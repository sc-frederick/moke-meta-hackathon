import { DateTime, Effect, Option, Result, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketSource } from "#lib/review/packet.ts";

const maximumBytes = 2 * 1024 * 1024;
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
  /** UTF-8 body bounded to two MiB. */
  readonly body: string;
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
}

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
    "floridarules.org",
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
          Accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
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
        let size = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;

          if (size > maximumBytes)
            request.destroy(new Error("Public source exceeded its size bound"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
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

        if (Buffer.byteLength(response.body) > maximumBytes) throw new Error("Source is too large");

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
  const { body, headers, status, url } = response.success;
  const contentType = (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const updated = { ...base, url: url.href, official: officialSource(url.hostname) };

  if (status < 200 || status >= 300)
    return Schema.decodeUnknownSync(PacketSource)({
      ...updated,
      status: "unavailable",
      text: `Source returned HTTP ${status}. Its governing text was not retrieved.`,
    });

  if (contentType === "application/pdf" || body.startsWith("%PDF-"))
    return Schema.decodeUnknownSync(PacketSource)({
      ...updated,
      status: "unavailable",
      text: "This source is a PDF. Import its document to inspect it; this lookup did not extract or verify its text.",
    });

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

  for (const body of markupContents(response.body, "item")) {
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
