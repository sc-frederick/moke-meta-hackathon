import { expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PacketCitation } from "#lib/review/packet.ts";
import {
  codeReference,
  floridaCodeIndex,
  parseCodeReferences,
  searchCodeReferences,
} from "../../backend/review/code-index/code-index.ts";
import provenance from "../../backend/review/code-index/provenance.json";
import { decodeRequest, id, open, outputs, response, until } from "../fixtures/packet-review.ts";

const assets = "backend/review/code-index";

test("every entry in the owner's reference and the additions becomes a unique, linked pointer", async () => {
  const reference = await readFile(
    join(assets, "assets/FBC_2023_plan_review_reference.md"),
    "utf8",
  );

  const bullets = reference.split("\n").filter((line) => line.startsWith("- **"));
  const parsed = parseCodeReferences(reference);

  // One entry links both the commercial and residential energy chapters.
  expect(parsed.length).toBe(bullets.length + 1);
  expect(new Set(floridaCodeIndex.map((entry) => entry.id)).size).toBe(floridaCodeIndex.length);
  expect(floridaCodeIndex.every((entry) => entry.url.startsWith("https://"))).toBe(true);
  expect(new Set(floridaCodeIndex.map((entry) => entry.document))).toEqual(
    new Set([
      "FBC Building (Commercial)",
      "FBC Residential",
      "FBC Existing Building",
      "FBC Energy Conservation",
      "FBC Accessibility",
      "FBC Mechanical",
      "FBC Plumbing",
      "FBC Fuel Gas",
      "Florida Statutes",
      "Florida Administrative Code",
      "Florida Building Code",
    ]),
  );

  for (const file of provenance.files) {
    const bytes = await readFile(join(assets, file.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
});

test("only links the app can retrieve are marked for read_source", () => {
  const access = (title: string) =>
    floridaCodeIndex.find((entry) => entry.title.startsWith(title))?.access;

  expect(access("1004 Occupant Load")).toBe("open_in_browser");
  expect(access("553.79 Permits")).toBe("read_source");
  expect(access("61G15-23.002 Seals")).toBe("open_in_browser");
});

test("search ranks section numbers and plan review terms", () => {
  const titles = (query: string, limit = 3) =>
    searchCodeReferences(floridaCodeIndex, query, limit).map((entry) => entry.title);

  expect(titles("occupant load")[0]).toBe("1004 Occupant Load");
  expect(titles("1005.3")[0]).toBe("1005 Egress Sizing");
  expect(titles("R302 townhouse fire separation")[0]).toBe("R302 Fire-resistant construction");
  expect(titles("threshold building structural inspection plan")[0]).toStartWith("553.79");
  expect(titles("engineer seal digital signature")).toContain(
    "61G15-23.004 Procedures for Digitally Signing and Sealing Electronically Transmitted Plans, Specifications, Reports or Other Documents",
  );
  expect(titles("the of and")).toEqual([]);
  expect(searchCodeReferences(floridaCodeIndex, "egress", 20).length).toBeLessThanOrEqual(20);
});

test("a citation names a search_code result and the host attaches its link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-code-citation-"));

  const SearchOutput = Schema.Struct({
    index: Schema.String,
    results: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  });

  const citationId = id();
  let resultId: string | undefined;
  let rejected = false;
  let step = 0;

  const citation = (codeReferenceId: string) => ({
    id: citationId,
    sourceId: null,
    jurisdiction: "Florida",
    document: "Florida Building Code, Building",
    edition: "2023 8th Edition",
    section: "1004",
    quote: "",
    application: "Occupant load posted on the life safety plan.",
    status: "verified",
    note: "",
    codeReferenceId,
  });

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    switch (step++) {
      case 0:
        return response([{ name: "search_code", arguments: { query: "occupant load", limit: 2 } }]);
      case 1:
        resultId = outputs(SearchOutput, request).at(-1)?.results[0]?.id;

        return response([{ name: "record_citation", arguments: citation("not-an-index-id") }]);
      case 2:
        rejected = JSON.stringify(request).includes("Unknown code reference");

        return response([{ name: "record_citation", arguments: citation(resultId ?? "") }]);
      default:
        return response([], "Code citation fixture finished.");
    }
  });

  try {
    const started = await session.run(
      session.packets.start(await session.request("Check the occupant load requirement.")),
    );

    const finished = await until(session, started.id, "failed");
    const recorded = finished.citations.find((entry) => entry.id === citationId);
    const indexed = codeReference(resultId ?? "");

    expect(indexed?.title).toBe("1004 Occupant Load");
    expect(rejected).toBe(true);
    expect(Schema.is(PacketCitation)(recorded)).toBe(true);
    expect(recorded?.reference).toEqual({
      id: indexed?.id ?? "",
      document: "FBC Building (Commercial)",
      edition: "2023 8th Edition",
      title: "1004 Occupant Load",
      url: indexed?.url ?? "",
      access: "open_in_browser",
    });
    // A pointer is not retrieved text, so a verified claim without a source stays unverified.
    expect(recorded?.status).toBe("unverified");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
