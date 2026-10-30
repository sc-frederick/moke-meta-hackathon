import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { createHash } from "node:crypto";
import { DocumentError } from "#lib/review/contracts.ts";
import {
  readSource,
  searchSources,
  type SourceLookupOptions,
  type SourceResponse,
} from "../../backend/packet-review/sources.ts";

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
