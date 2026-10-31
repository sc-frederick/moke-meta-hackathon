import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentError } from "#lib/review/contracts.ts";
import { reviewDisciplines } from "#lib/review/execution.ts";
import { ReviewPass } from "#lib/review/packet.ts";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import {
  readSource,
  searchSources,
  sourceKey,
  type SourceLookupOptions,
  type SourceResponse,
} from "../../backend/packet-review/sources.ts";
import {
  decodeRequest,
  open,
  outputs,
  response,
  systemPrompt,
  until,
} from "../fixtures/packet-review.ts";

const publicDns: NonNullable<SourceLookupOptions["resolve"]> = async () => [
  { address: "1.1.1.1", family: 4 },
];

const bytes = (text: string) => new TextEncoder().encode(text);

const html = (body: string): SourceResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: bytes(body),
});

const fixture = (body: string): SourceLookupOptions => ({
  resolve: publicDns,
  transport: async () => html(body),
});

test("retains actual governing text, canonical source and content hash without executing page code", async () => {
  const body =
    "<html><head><title>Florida Code &amp; amendments</title><script>secret_code()</script></head><body><h1>403.1</h1><p>One fixture &gt; zero fixtures.</p></body></html>";

  const source = await Effect.runPromise(
    readSource("https://codes.iccsafe.org/content/example#403.1", fixture(body)),
  );

  expect(source.status).toBe("available");
  expect(source.official).toBe(true);
  expect(source.title).toBe("Florida Code & amendments");
  expect(source.text).toContain("403.1\nOne fixture > zero fixtures.");
  expect(source.text).not.toContain("secret_code");
  expect(source.sha256).toBe(createHash("sha256").update(body).digest("hex"));
  expect(source.url).toBe("https://codes.iccsafe.org/content/example#403.1");
  expect(source.retrievedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
});

test.each([
  ["https://www.floridabuilding.org/rule", true],
  ["https://www.myfloridacfo.com/division/sfm", true],
  ["https://flrules.org/gateway/ruleNo.asp?id=61G15-23.002", true],
  ["https://www.leg.state.fl.us/statutes/index.cfm", true],
  ["https://county.gov/permits", true],
  ["https://manufacturer.com/manual", false],
  ["https://floridabuilding.org.example.com/claims", false],
  ["https://county.gov.example.com/claims", false],
] as const)("distinguishes source ownership at %s", async (url, official) => {
  expect(
    (await Effect.runPromise(readSource(url, fixture("<p>Actual source text</p>")))).official,
  ).toBe(official);
});

test("revalidates redirects and retains the destination source identity", async () => {
  const destinations: string[] = [];

  const source = await Effect.runPromise(
    readSource("https://county.gov/old", {
      resolve: publicDns,
      transport: async (url, address) => {
        expect(address).toEqual({ address: "1.1.1.1", family: 4 });
        destinations.push(url.href);

        return url.pathname === "/old"
          ? { status: 302, headers: { location: "https://codes.iccsafe.org/new" }, body: bytes("") }
          : html("<p>Retrieved adopted text</p>");
      },
    }),
  );

  expect(destinations).toEqual(["https://county.gov/old", "https://codes.iccsafe.org/new"]);
  expect(source.url).toBe("https://codes.iccsafe.org/new");
  expect(source.status).toBe("available");
});

test("never dispatches a redirect into a private destination", async () => {
  const destinations: string[] = [];

  const source = await Effect.runPromise(
    readSource("https://county.gov/redirect", {
      resolve: publicDns,
      transport: async (url) => {
        destinations.push(url.href);

        return {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
          body: bytes(""),
        };
      },
    }),
  );

  expect(destinations).toEqual(["https://county.gov/redirect"]);
  expect(source.status).toBe("unavailable");
  expect(source.sha256).toBeNull();
});

test("rejects DNS with any private address before an HTTP request", async () => {
  const sent: string[] = [];

  const source = await Effect.runPromise(
    readSource("https://county.gov/source", {
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      transport: async (url) => {
        sent.push(url.href);

        return html("Should not be read");
      },
    }),
  );

  expect(source.status).toBe("unavailable");
  expect(sent).toEqual([]);
});

test("passes the one vetted DNS result to transport without resolving again at dispatch", async () => {
  let resolutions = 0;

  const source = await Effect.runPromise(
    readSource("https://county.gov/source", {
      resolve: async () => {
        resolutions++;

        return [{ address: resolutions === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 }];
      },
      transport: async (_url, address) => {
        expect(address).toEqual({ address: "1.1.1.1", family: 4 });

        return html("<p>Public destination text</p>");
      },
    }),
  );

  expect(source.status).toBe("available");
  expect(resolutions).toBe(1);
});

test.each([
  "http://county.gov/source",
  "https://name:password@county.gov/source",
  "https://county.gov:8443/source",
  "https://localhost/source",
  "https://printer.local/source",
  "https://127.0.0.1/source",
  "https://2130706433/source",
  "https://0x7f000001/source",
  "https://169.254.169.254/source",
  "https://168.63.129.16/source",
  "https://192.168.2.5/source",
  "https://100.64.0.1/source",
  "https://[::1]/source",
  "https://[::ffff:127.0.0.1]/source",
  "https://[2001:db8::1]/source",
  "https://[2001:20::1]/source",
  "https://[3fff::1]/source",
  "https://[2002:7f00:1::]/source",
])("rejects nonpublic source URL %s", async (url) => {
  const result = await Effect.runPromise(
    Effect.result(readSource(url, fixture("Should never be requested"))),
  );

  expect(Result.isFailure(result)).toBe(true);
});

test("keeps access denial, PDF and oversized content unverified", async () => {
  for (const response of [
    { status: 403, headers: { "content-type": "text/html" }, body: bytes("Private error detail") },
    {
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: bytes("%PDF-1.7 actual bytes"),
    },
    html("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const source = await Effect.runPromise(
      readSource("https://county.gov/document", {
        resolve: publicDns,
        transport: async () => response,
      }),
    );

    expect(source.status).toBe("unavailable");
    expect(source.sha256).toBeNull();
    expect(source.text).not.toContain("Private error detail");
  }
});

test("bounds retained text while hashing the complete fetched response", async () => {
  const body = "Source text ".repeat(4000);
  const source = await Effect.runPromise(readSource("https://county.gov/section", fixture(body)));
  expect(source.text.length).toBeLessThanOrEqual(32000);
  expect(source.text).toContain("Source text truncated");
  expect(source.sha256).toBe(createHash("sha256").update(body).digest("hex"));
});

test("search returns discovery links, decodes RSS text and discards nonpublic links", async () => {
  const result = await Effect.runPromise(
    searchSources("Florida building governing edition", {
      resolve: publicDns,
      transport: async (url) => {
        expect(url.hostname).toBe("www.bing.com");
        expect(url.searchParams.get("format")).toBe("rss");
        expect(url.searchParams.get("q")).toBe("Florida building governing edition");

        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: bytes(
            `<rss><channel><item><title>Code &amp; amendments</title><link>https://www.floridabuilding.org/source?a=1&amp;b=2</link><description><![CDATA[<b>Official</b> source discovery.]]></description></item><item><title>Bad</title><link>https://127.0.0.1/secret</link></item></channel></rss>`,
          ),
        };
      },
    }),
  );

  expect(result).toEqual([
    {
      title: "Code & amendments",
      url: "https://www.floridabuilding.org/source?a=1&b=2",
      description: "Official source discovery.",
    },
  ]);
});

test("handles unclosed markup without exposing script text or repeated rescans", async () => {
  const source = await Effect.runPromise(
    readSource(
      "https://county.gov/source",
      fixture("<p>Visible provision.</p><script>" + "<script>".repeat(10000)),
    ),
  );

  expect(source.status).toBe("available");
  expect(source.text).toBe("Visible provision.");
});

const pdfResponse =
  (text = "%PDF-1.7 rule text"): NonNullable<SourceLookupOptions["transport"]> =>
  async () => ({
    status: 200,
    headers: { "content-type": "application/pdf" },
    body: bytes(text),
  });

test("extracts a retrieved PDF's text from the requested page and says how to continue", async () => {
  const requests: Array<{ firstPage: number; maxCharacters: number; header: string }> = [];

  const source = await Effect.runPromise(
    readSource("https://flrules.org/gateway/readFile.asp?file=61G15-23.pdf#page=3", {
      resolve: publicDns,
      transport: pdfResponse(),
      pdfText: (body, firstPage, maxCharacters) => {
        requests.push({
          firstPage,
          maxCharacters,
          header: new TextDecoder().decode(body.subarray(0, 5)),
        });

        return Effect.succeed({
          sha256: "a".repeat(64),
          pageCount: 9,
          firstPage,
          lastPage: 4,
          text: "[Page 3]\n61G15-23.002 Seals Acceptable to the Board\n\n[Page 4]\nThe seal shall be",
          truncated: true,
        });
      },
    }),
  );

  expect(requests).toEqual([{ firstPage: 3, maxCharacters: 31800, header: "%PDF-" }]);
  expect(source.status).toBe("available");
  expect(source.official).toBe(true);
  expect(source.sha256).toBe("a".repeat(64));
  expect(source.title).toBe("readFile.asp (PDF pages 3-4 of 9)");
  expect(source.text).toContain("61G15-23.002 Seals Acceptable to the Board");
  expect(source.text).toContain("Read the same URL with #page=5 to continue.");
});

test.each([
  ["https://county.gov/current.pdf", 2],
  ["https://county.gov/current.pdf#page=3", 3],
])(
  "a redirected PDF page read is keyed to the page its text came from (%s)",
  async (location, page) => {
    const destinations: Array<string> = [];

    const source = await Effect.runPromise(
      readSource("https://county.gov/old.pdf#page=2", {
        resolve: publicDns,
        transport: async (url) => {
          destinations.push(url.pathname);

          if (url.pathname === "/old.pdf")
            return { status: 302, headers: { location }, body: bytes("") };

          return {
            status: 200,
            headers: { "content-type": "application/pdf" },
            body: bytes("%PDF-1.7"),
          };
        },
        pdfText: (_body, firstPage) =>
          Effect.succeed({
            sha256: "c".repeat(64),
            pageCount: 3,
            firstPage,
            lastPage: firstPage,
            text: `[Page ${firstPage}]\nAmended text`,
            truncated: false,
          }),
      }),
    );

    // A redirect without a fragment keeps the requested page; its own fragment replaces it.
    expect(destinations).toEqual(["/old.pdf", "/current.pdf"]);
    expect(source.status).toBe("available");
    expect(source.text).toContain(`[Page ${page}]`);
    expect(source.url).toBe(`https://county.gov/current.pdf#page=${page}`);
    expect(sourceKey(source.url)).not.toBe(sourceKey("https://county.gov/current.pdf"));
  },
);

test("keeps scanned, missing-page and unreadable PDFs unavailable", async () => {
  const read = (
    pdfText: NonNullable<SourceLookupOptions["pdfText"]>,
    url = "https://county.gov/amendments.pdf",
  ) =>
    Effect.runPromise(readSource(url, { resolve: publicDns, transport: pdfResponse(), pdfText }));

  const result =
    (text: string, pageCount = 2) =>
    () =>
      Effect.succeed({
        sha256: "b".repeat(64),
        pageCount,
        firstPage: 1,
        lastPage: pageCount,
        text,
        truncated: false,
      });

  const scanned = await read(result("  "));
  expect(scanned.status).toBe("unavailable");
  expect(scanned.text).toContain("may be scanned");

  const missing = await read(result("text"), "https://county.gov/amendments.pdf#page=7");
  expect(missing.status).toBe("unavailable");
  expect(missing.text).toContain("page 7 does not exist");

  const failed = await read(() =>
    Effect.fail(new DocumentError({ reason: "invalid", message: "The PDF could not be parsed." })),
  );

  expect(failed.status).toBe("unavailable");
  expect(failed.sha256).toBeNull();
  expect(failed.text).toContain("The PDF could not be parsed.");
});

test("a source key ignores fragments except a PDF page selector", () => {
  expect(sourceKey("https://County.gov:443/rules.pdf#section-3")).toBe(
    "https://county.gov/rules.pdf",
  );
  expect(sourceKey("https://county.gov/rules.pdf#page=1")).toBe("https://county.gov/rules.pdf");
  expect(sourceKey("https://county.gov/rules.pdf#page=4")).toBe(
    "https://county.gov/rules.pdf#page=4",
  );
});

const Call = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const ReadResult = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  status: Schema.String,
  text: Schema.String,
});

const SheetOpening = Schema.Struct({
  stage: Schema.Literal("sheet"),
  sheet: Schema.Struct({ id: Schema.String }),
  inventory: Schema.Array(Schema.Struct({ id: Schema.String })),
});

test("parallel sheet reviewers share one retrieval of a source and reread it by id; page selectors stay distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-source-reads-"));
  const url = "https://county.gov/amendments.pdf";
  const fetched = new Array<string>();
  const reads = new Map<string, ReadonlyArray<typeof ReadResult.Type>>();
  const bothAsked = Promise.withResolvers<void>();
  let asked = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    const made = Schema.decodeUnknownSync(Schema.Array(Call))(request.input ?? []).flatMap(
      (item) => (item.type === "function_call" && item.name ? [item.name] : []),
    );

    // The coordinator records nothing in setup and finishes in coordination.
    if (!systemPrompt(request).includes("## Parallel review: sheet reviewer")) {
      if (!outputs(Schema.Struct({ stage: Schema.Literal("coordination") }), request).length)
        return response([], "Project configuration recorded.");

      return made.includes("finish_review")
        ? response([], "Coordination complete.")
        : response([
            {
              name: "finish_review",
              arguments: { summary: "Sheets reviewed and compared.", missingInputs: [] },
            },
          ]);
    }

    const input = outputs(SheetOpening, request).at(0);

    if (!input) throw new Error("Sheet reviewer input is missing its sheet");
    const own = input.sheet.id;
    const first = own === input.inventory[0]?.id;
    const results = outputs(ReadResult, request);

    if (!made.includes("render_sheet"))
      return response([{ name: "render_sheet", arguments: { sheetId: own } }]);

    if (!made.includes("read_source")) {
      if (++asked === 2) bothAsked.resolve();

      return response([{ name: "read_source", arguments: { url } }]);
    }

    // Each reviewer rereads the saved copy by id; the first also opens a later PDF page.
    if (results.length === 1)
      return response([
        { name: "read_source", arguments: { sourceId: results[0]?.id ?? "missing" } },
        ...(first ? [{ name: "read_source", arguments: { url: `${url}#page=2` } }] : []),
      ]);

    reads.set(own, results);

    if (!made.includes("record_coverage_batch"))
      return response([
        {
          name: "record_coverage_batch",
          arguments: {
            entries: reviewDisciplines.flatMap((discipline) =>
              ReviewPass.literals.map((pass) => ({
                sheetId: own,
                discipline: discipline.id,
                pass,
                status: "checked",
                note: "",
              })),
            ),
          },
        },
      ]);

    if (!made.includes("finish_sheet"))
      return response([
        {
          name: "finish_sheet",
          arguments: {
            summary: "Sheet reviewed.",
            keyFacts: [],
            crossReferences: [],
            suspectedGaps: [],
          },
        },
      ]);

    return response([], "Sheet notes saved.");
  };

  const sources = {
    resolve: publicDns,
    transport: async (target: URL) => {
      fetched.push(target.href);
      // The first retrieval is still on the wire when the second reviewer asks for the source.
      await Promise.race([bothAsked.promise, Bun.sleep(5000)]);

      return html("<p>County amendment 3: cleanouts at every change of direction.</p>");
    },
  };

  const session = await open(
    directory,
    transport,
    true,
    undefined,
    "observe",
    { minSheets: 2, concurrency: { meta: 4, baseten: 2 } },
    sources,
  );

  try {
    const sheets = (await session.snapshot()).sheets;

    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    const finished = await until(session, started.id, "completed");
    const [left, right] = sheets.map((sheet) => reads.get(sheet.id) ?? []);

    // Two reviewers' reads of one URL made one retrieval; the later page is its own source.
    expect(fetched).toHaveLength(2);
    expect(finished.sources).toHaveLength(2);
    expect(new Set(finished.sources.map((source) => source.id)).size).toBe(2);
    expect(finished.sources.map((source) => sourceKey(source.url)).toSorted()).toEqual(
      [url, `${url}#page=2`].toSorted(),
    );

    const [shared, page] = [left?.[0], left?.[2]];
    expect(shared?.status).toBe("available");
    expect(right?.[0]).toEqual(shared);
    // Rereading by id returns the same saved source.
    expect(left?.[1]).toEqual(shared);
    expect(right?.[1]).toEqual(shared);
    expect(page?.id).not.toBe(shared?.id);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
