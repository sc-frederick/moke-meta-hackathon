import { DateTime, Effect, Option, Result, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { DocumentError, ReviewStorageError } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketSource } from "#lib/review/packet.ts";

const maximumBytes = 2 * 1024 * 1024;

// Code amendments and agency checklists are often scanned or illustrated PDFs.
const maximumPdfBytes = 20 * 1024 * 1024;
const maximumText = 32000;
const Address = Schema.Struct({ address: Schema.String, family: Schema.Literals([4, 6]) });

/** A DNS result approved before dispatch and pinned to the actual TLS connection. */
export type SourceAddress = typeof Address.Type;

/** Bounded HTTP response supplied by the public-source transport. */
export interface SourceResponse {
  /** HTTP status after this single request; transports must not follow redirects. */
  readonly status: number;
  /** Lower-case response headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Raw body bytes, bounded to two MiB, or twenty MiB for a PDF. */
  readonly body: Uint8Array;
}

/** Embedded text extracted from a retrieved PDF, with the stored artifact's content hash. */
export interface PdfSourceText {
  readonly sha256: string;
  readonly pageCount: number;
  readonly firstPage: number;
  readonly lastPage: number;
  readonly text: string;
  readonly truncated: boolean;
}

/** DNS and HTTPS seams permit deterministic tests without replacing application modules. */
export interface SourceLookupOptions {
  /** Resolve all candidate addresses; every candidate must be public. */
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<SourceAddress>>;
  /** Make one request to the approved address, retaining URL hostname for TLS verification. */
  readonly transport?: (
    url: URL,
    address: SourceAddress,
    signal: AbortSignal,
  ) => Promise<SourceResponse>;
  /** Extract a retrieved PDF's text from a one-based page; without it, PDFs stay unavailable. */
  readonly pdfText?: (
    bytes: Uint8Array,
    firstPage: number,
    maxCharacters: number,
  ) => Effect.Effect<PdfSourceText, DocumentError | ReviewStorageError>;
}

const pdfResponse = (headers: Readonly<Record<string, string>>) =>
  (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() === "application/pdf";

/** Search results are discovery links, never verified governing-source evidence. */
export const SourceSearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  description: Schema.String,
});

const PublicUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => {
    const hostname = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    )
      return false;
    const family = isIP(hostname);

    if (family === 4 || family === 6) return publicAddress({ address: hostname, family });

    if (family !== 0) return false;

    return (
      hostname.includes(".") &&
      !/\.(?:localhost|local|internal|home|lan)$/.test(hostname) &&
      hostname !== "localhost"
    );
  }),
);

function publicAddress(address: SourceAddress) {
  if (isIP(address.address) !== address.family) return false;

  if (address.family === 6) {
    const value = new URL(`https://[${address.address}]`).hostname.slice(1, -1);

    const parts = value.split(":");
    const second = Number.parseInt(parts[1] || "0", 16);

    // Global unicast only; exclude special-purpose, translation/tunnel and documentation ranges.
    return (
      /^[23][0-9a-f]{3}:/.test(value) &&
      !(parts[0] === "2001" && (second < 0x200 || second === 0xdb8)) &&
      !(parts[0] === "3fff" && second < 0x1000) &&
      !value.startsWith("2002:")
    );
  }

  const bytes = address.address.split(".").map(Number);
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;

  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 168 && b === 63 && c === 129 && bytes[3] === 16) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}

function officialSource(hostname: string) {
  const host = hostname.replace(/\.$/, "").toLowerCase();

  const domains = [
    "floridabuilding.org",
    "myfloridacfo.com",
    "iccsafe.org",
    "nfpa.org",
    "leg.state.fl.us",
    "flrules.org",
  ];

  return (
    host.endsWith(".gov") ||
    host.endsWith(".mil") ||
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

async function resolvePublic(hostname: string) {
  return Schema.decodeUnknownSync(Schema.Array(Address))(
    await lookup(hostname, { all: true, verbatim: true }),
  );
}

function requestPublic(
  url: URL,
  address: SourceAddress,
  signal: AbortSignal,
): Promise<SourceResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        signal,
        headers: {
          "User-Agent": "Moke/0.1 public-source-review",
          Accept:
            "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.1",
          "Accept-Encoding": "identity",
        },
        // Pin the vetted address so a second DNS response cannot redirect this connection into a private network.
        lookup(_hostname, _options, callback) {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
          ),
        );

        const chunks: Buffer[] = [];
        const limit = pdfResponse(headers) ? maximumPdfBytes : maximumBytes;
        let size = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;

          if (size > limit) request.destroy(new Error("Public source exceeded its size bound"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          }),
        );
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function abortable<A>(work: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(new Error("Source lookup interrupted"));

  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Source lookup interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const fetchText = Effect.fn("PacketReview.fetchPublicSource")(function* (
  initial: URL,
  options: SourceLookupOptions,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
      let url = initial;

      for (let hop = 0; hop <= 4; hop++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
        const literal = isIP(hostname);

        const addresses =
          literal === 4 || literal === 6
            ? [{ address: hostname, family: literal }]
            : await abortable((options.resolve ?? resolvePublic)(hostname), deadline);

        const parsed = Schema.decodeUnknownSync(Schema.NonEmptyArray(Address))(addresses);

        if (!parsed.every(publicAddress)) throw new Error("Public source address was refused");
        const address = parsed[0];

        const response = await abortable(
          (options.transport ?? requestPublic)(url, address, deadline),
          deadline,
        );

        if (
          response.body.byteLength >
          (pdfResponse(response.headers) ? maximumPdfBytes : maximumBytes)
        )
          throw new Error("Source is too large");

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;

          if (!location || hop === 4) throw new Error("Source redirect could not be followed");
          url = Schema.decodeUnknownSync(PublicUrl)(new URL(location, url).href);
          continue;
        }

        return { ...response, url };
      }

      throw new Error("Source redirect limit reached");
    },
    catch: () =>
      new ExecutionError({
        reason: "unavailable",
        message: "The public source could not be read within its access, size, or time limits.",
      }),
  });
});

function decodeEntities(text: string) {
  const names = new Map(
    Object.entries({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
      ndash: "–",
      mdash: "—",
      sect: "§",
      deg: "°",
      copy: "©",
    }),
  );

  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (!entity.startsWith("#")) return names.get(entity.toLowerCase()) ?? full;

    const value =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);

    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : "";
  });
}

function markupContents(markup: string, name: string) {
  const lower = markup.toLowerCase();
  const values: string[] = [];
  let position = 0;

  while (position < markup.length) {
    const start = lower.indexOf(`<${name}`, position);

    if (start < 0) break;
    const boundary = lower[start + name.length + 1] ?? "";
    position = start + name.length + 1;

    if (boundary !== ">" && !/\s/.test(boundary)) continue;
    const openingEnd = lower.indexOf(">", position);

    if (openingEnd < 0) break;
    const closingStart = lower.indexOf(`</${name}`, openingEnd + 1);

    if (closingStart < 0) break;
    values.push(markup.slice(openingEnd + 1, closingStart));
    const closingEnd = lower.indexOf(">", closingStart + name.length + 2);

    if (closingEnd < 0) break;
    position = closingEnd + 1;
  }

  return values;
}

function readableText(html: string) {
  const lower = html.toLowerCase();
  const pieces: string[] = [];
  let position = 0;
  let blocked: string | null = null;

  // A forward-only scan keeps malformed/unclosed markup from causing repeated regex searches.
  while (position < html.length) {
    if (blocked !== null) {
      const closing = lower.indexOf(`</${blocked}`, position);

      if (closing < 0) break;
      position = closing;
      blocked = null;
    }

    const start = html.indexOf("<", position);

    if (start < 0) {
      pieces.push(html.slice(position));
      break;
    }

    pieces.push(html.slice(position, start));

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);

      if (end < 0) break;
      position = end + 3;
      continue;
    }

    let end = start + 1;
    let quote: string | null = null;

    for (; end < html.length; end++) {
      const character = html[end];

      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }

    if (end >= html.length) break;
    const tag = lower.slice(start + 1, end).trim();
    const name = tag.match(/^\/?\s*([a-z][a-z0-9:-]*)/)?.[1];
    const closing = tag.startsWith("/");

    if (!closing && name && ["script", "style", "noscript", "template", "svg"].includes(name))
      blocked = name;
    else if (
      (closing &&
        name &&
        ["p", "div", "li", "tr", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
          name,
        )) ||
      name === "br"
    )
      pieces.push("\n");
    else pieces.push(" ");
    position = end + 1;
  }

  return decodeEntities(pieces.join(""))
    .replace(/[\t \r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const parseUrl = (url: string) =>
  Schema.decodeUnknownEffect(PublicUrl)(url).pipe(
    Effect.mapError(
      () =>
        new ExecutionError({
          reason: "input",
          message: "Choose a public HTTPS source URL without credentials or a nonstandard port.",
        }),
    ),
  );

/** A `#page=N` fragment starts PDF text at that page, as PDF viewers do. */
const pdfFirstPage = (url: URL) => {
  const page = Number.parseInt(/(?:^|&)page=(\d+)/.exec(url.hash.slice(1))?.[1] ?? "1", 10);

  return Number.isSafeInteger(page) && page >= 1 && page <= 200 ? page : 1;
};

/**
 * One review retrieves each source once. A fragment does not change the fetched document, except
 * a PDF `#page=N` selector, which starts its text at another page.
 */
export const sourceKey = (url: string) => {
  const parsed = URL.parse(url);

  if (parsed === null) return url;
  const page = pdfFirstPage(parsed);
  parsed.hash = page === 1 ? "" : `page=${page}`;

  return parsed.href;
};

/** Extract a retrieved PDF's embedded text; scanned or unreadable PDFs stay unavailable. */
const readPdfSource = Effect.fnUntraced(function* (
  base: Omit<typeof PacketSource.Encoded, "status" | "text">,
  requested: URL,
  bytes: Uint8Array,
  options: SourceLookupOptions,
) {
  const unavailable = (text: string) =>
    Schema.decodeUnknownSync(PacketSource)({ ...base, status: "unavailable", text });

  if (options.pdfText === undefined)
    return unavailable(
      "This source is a PDF and PDF text extraction is unavailable in this launch. Import its document to inspect it.",
    );

  const firstPage = pdfFirstPage(requested);
  const extracted = yield* options.pdfText(bytes, firstPage, maximumText - 200).pipe(Effect.result);

  if (Result.isFailure(extracted))
    return unavailable(`The PDF could not be read: ${extracted.failure.message}`);
  const pdf = extracted.success;

  if (firstPage > pdf.pageCount)
    return unavailable(`The PDF has ${pdf.pageCount} pages; page ${firstPage} does not exist.`);

  if (!pdf.text.trim())
    return unavailable(
      "The PDF has no embedded text on the requested pages; it may be scanned. Import it to inspect its pages visually.",
    );
  const name = decodeURIComponent(requested.pathname.split("/").at(-1) ?? "") || requested.hostname;

  return Schema.decodeUnknownSync(PacketSource)({
    ...base,
    title: `${name} (PDF pages ${pdf.firstPage}-${pdf.lastPage} of ${pdf.pageCount})`.slice(
      0,
      1000,
    ),
    status: "available",
    sha256: pdf.sha256,
    text: pdf.truncated
      ? `${pdf.text}\n[PDF text continues after page ${pdf.lastPage}. Read the same URL with #page=${pdf.lastPage + 1} to continue.]`
      : pdf.text,
  });
});

/** Fetch public governing text with DNS-pinned TLS; access failures remain unverified source records. */
export const readSource = Effect.fn("PacketReview.readSource")(function* (
  input: string,
  options: SourceLookupOptions = {},
) {
  const initial = yield* parseUrl(input);
  const retrievedAt = DateTime.formatIso(yield* DateTime.now);

  const base = {
    id: randomUUID(),
    url: initial.href,
    title: initial.hostname,
    retrievedAt,
    official: officialSource(initial.hostname),
    sha256: null,
  };

  const response = yield* fetchText(initial, options).pipe(Effect.result);

  if (Result.isFailure(response))
    return Schema.decodeUnknownSync(PacketSource)({
      ...base,
      status: "unavailable",
      text: response.failure.message,
    });
  const { body: bytes, headers, status, url } = response.success;
  const body = new TextDecoder().decode(bytes);
  const contentType = (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const updated = { ...base, url: url.href, official: officialSource(url.hostname) };

  if (status < 200 || status >= 300)
    return Schema.decodeUnknownSync(PacketSource)({
      ...updated,
      status: "unavailable",
      text: `Source returned HTTP ${status}. Its governing text was not retrieved.`,
    });

  if (contentType === "application/pdf" || body.startsWith("%PDF-"))
    return yield* readPdfSource(updated, initial, bytes, options);

  if (
    (contentType && !/^(?:text\/|application\/(?:xhtml\+xml|xml|json)$)/.test(contentType)) ||
    (headers["content-encoding"] && headers["content-encoding"] !== "identity")
  )
    return Schema.decodeUnknownSync(PacketSource)({
      ...updated,
      status: "unavailable",
      text: "The source did not provide readable uncompressed text. No governing text was verified.",
    });
  const html = contentType.includes("html") || /<html\b|<!doctype html/i.test(body);
  const text = html ? readableText(body) : body.trim();

  const title = html
    ? readableText(markupContents(body, "title")[0] ?? url.hostname)
    : url.hostname;

  if (!text)
    return Schema.decodeUnknownSync(PacketSource)({
      ...updated,
      status: "unavailable",
      text: "The source returned no readable text. Login or another document may be required.",
    });

  return Schema.decodeUnknownSync(PacketSource)({
    ...updated,
    title: title.slice(0, 1000),
    status: "available",
    sha256: createHash("sha256").update(body).digest("hex"),
    text:
      text.length > maximumText
        ? `${text.slice(0, maximumText - 70)}\n[Source text truncated; retrieve a more specific section URL.]`
        : text,
  });
});

/** Discover source links; the reviewer must retrieve and inspect their governing text separately. */
export const searchSources = Effect.fn("PacketReview.searchSources")(function* (
  input: string,
  options: SourceLookupOptions = {},
) {
  const query = yield* Schema.decodeUnknownEffect(
    Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(500)),
  )(input).pipe(
    Effect.mapError(
      () =>
        new ExecutionError({
          reason: "input",
          message: "Use a source-search query between 3 and 500 characters.",
        }),
    ),
  );

  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("format", "rss");
  url.searchParams.set("q", query);
  const response = yield* fetchText(url, options);

  if (response.status !== 200)
    return yield* new ExecutionError({
      reason: "unavailable",
      message: "Source search is unavailable. Retrieve a known official source URL directly.",
    });
  const links: Array<typeof SourceSearchResult.Type> = [];

  for (const body of markupContents(new TextDecoder().decode(response.body), "item")) {
    const field = (name: string) =>
      decodeEntities(markupContents(body, name)[0] ?? "")
        .replace(/^<!\[CDATA\[|\]\]>$/g, "")
        .trim();

    const parsed = yield* parseUrl(field("link")).pipe(Effect.option);

    if (Option.isNone(parsed)) continue;
    links.push({
      title: readableText(field("title")).slice(0, 1000),
      url: parsed.value.href,
      description: readableText(field("description")).slice(0, 2000),
    });

    if (links.length === 10) break;
  }

  return links;
});
