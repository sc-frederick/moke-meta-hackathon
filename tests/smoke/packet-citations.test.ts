import { expect, test } from "bun:test";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { PacketCitation, PacketSource } from "#lib/review/packet.ts";
import { citationHasSourceSupport } from "../../backend/packet-review/citations.ts";

const quote = "Door openings shall have a clear width of at least thirty two inches.";

const source = Schema.decodeUnknownSync(PacketSource)({
  id: randomUUID(),
  url: "https://codes.iccsafe.org/example",
  title: "2023 Florida Building Code — Building",
  retrievedAt: "2026-10-28T00:00:00.000Z",
  status: "available",
  official: true,
  sha256: "a".repeat(64),
  text: `Section 101.1 Door openings.\n${quote}`,
});

const citation = Schema.decodeUnknownSync(PacketCitation)({
  id: randomUUID(),
  sourceId: source.id,
  jurisdiction: "Needs adoption confirmation",
  document: "Florida Building Code, Building",
  edition: "2023",
  section: "101.1",
  quote,
  application:
    "The submitted door opening must be checked against the applicable clear-width requirement.",
  status: "verified",
  note: "Textual support only; applicability still requires review.",
});

const changedCitation = (patch: Partial<typeof PacketCitation.Type>) =>
  Schema.decodeUnknownSync(PacketCitation)({ ...citation, ...patch });

const changedSource = (patch: Partial<typeof PacketSource.Type>) =>
  Schema.decodeUnknownSync(PacketSource)({ ...source, ...patch });

test("supports a substantive quote tied to the retrieved official document, edition and exact section", () => {
  expect(citationHasSourceSupport(citation, source)).toBe(true);
});

test.each([
  { document: "Florida Building Code, Mechanical" },
  { edition: "2026" },
  { section: "1101.1" },
  { sourceId: randomUUID() },
  { sourceId: null },
  { quote: "shall" },
  { quote: "shall shall shall shall shall shall shall shall shall shall" },
  { application: "" },
  { document: "" },
  { edition: "" },
  { section: "" },
  { quote: "Door openings shall have a clear width of at least forty eight inches." },
])("does not verify an unsupported citation claim %j", (patch) => {
  expect(citationHasSourceSupport(changedCitation(patch), source)).toBe(false);
});

test("missing, unofficial and inaccessible evidence cannot support verification", () => {
  expect(citationHasSourceSupport(citation, undefined)).toBe(false);
  expect(citationHasSourceSupport(citation, changedSource({ official: false }))).toBe(false);
  expect(citationHasSourceSupport(citation, changedSource({ status: "unavailable" }))).toBe(false);
});

test("normalizes case, punctuation, Unicode typography and whitespace", () => {
  const normalized = changedSource({
    title: "２０２３ FLORIDA BUILDING CODE: BUILDING",
    text: `SECTION 101 . 1\nDOOR OPENINGS SHALL HAVE A CLEAR\nWIDTH OF AT LEAST THIRTY-TWO INCHES.`,
  });

  expect(citationHasSourceSupport(changedCitation({ section: "§ 101.1" }), normalized)).toBe(true);
});

test("edition and section identifiers do not match substrings of a different identifier", () => {
  expect(
    citationHasSourceSupport(
      changedCitation({ edition: "2026" }),
      changedSource({ title: "20260 Florida Building Code Building" }),
    ),
  ).toBe(false);
  expect(
    citationHasSourceSupport(
      changedCitation({ section: "101" }),
      changedSource({ text: `Section 1101\n${quote}` }),
    ),
  ).toBe(false);
  expect(
    citationHasSourceSupport(
      changedCitation({ section: "101.1" }),
      changedSource({ text: `Section 101.10\n${quote}` }),
    ),
  ).toBe(false);
  expect(citationHasSourceSupport(changedCitation({ section: "101" }), source)).toBe(false);
});

test("short or context-free repeated text remains unsupported despite occurring in the source", () => {
  const short = "Door openings shall be wide.";
  expect(
    citationHasSourceSupport(
      changedCitation({ quote: short }),
      changedSource({ text: `Section 101.1\n${short}` }),
    ),
  ).toBe(false);
  const repeated = "load load load load load load load load load load load load";
  expect(
    citationHasSourceSupport(
      changedCitation({ quote: repeated }),
      changedSource({ text: `Section 101.1\n${repeated}` }),
    ),
  ).toBe(false);
});
