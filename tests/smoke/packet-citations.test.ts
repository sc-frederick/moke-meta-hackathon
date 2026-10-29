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
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({ title: "2023 (8th Edition) Florida Building Code Building" }),
    ),
  ).toBe(true);
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

test("binds a quote to its own section instead of a neighboring section on the same page", () => {
  const sections = changedSource({
    text: `Section 101.1 Scope\nThis section establishes the scope of the adopted building requirements.\nSection 101.2 Door openings\n${quote}`,
  });

  expect(citationHasSourceSupport(citation, sections)).toBe(false);
  expect(citationHasSourceSupport(changedCitation({ section: "101.2" }), sections)).toBe(true);
});

test("does not borrow a subsection quote or cross a section boundary", () => {
  const sections = changedSource({
    text: `101.1 Scope\nThe adopted requirements apply to the construction work described here.\n101.1.1 Door openings\n${quote}\n101.2 Other work\nUnrelated construction requirements apply to a separate scope.`,
  });

  expect(citationHasSourceSupport(citation, sections)).toBe(false);
  expect(citationHasSourceSupport(changedCitation({ section: "101.1.1" }), sections)).toBe(true);
  expect(
    citationHasSourceSupport(
      changedCitation({
        quote:
          "construction work described here. 101.1.1 Door openings Door openings shall have a clear width of at least thirty two inches.",
      }),
      sections,
    ),
  ).toBe(false);
});

test("inline references and duplicate section headings cannot establish a unique governing section", () => {
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({ text: `See section 101.1 for related requirements.\n${quote}` }),
    ),
  ).toBe(false);
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({ text: `Section 101.1 Contents\nSection 101.1 Door openings\n${quote}` }),
    ),
  ).toBe(false);
});

test("source identity must precede the section or be in the source title", () => {
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({
        title: "Official source",
        text: `2023 Florida Building Code Building\nSection 101.1 Door openings\n${quote}`,
      }),
    ),
  ).toBe(true);
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({
        title: "Official source",
        text: `Section 101.1 Door openings\n${quote}\nFlorida Building Code Building 2023`,
      }),
    ),
  ).toBe(false);
});

test("compound section and edition identifiers do not support shorter claims", () => {
  expect(
    citationHasSourceSupport(
      changedCitation({ section: "101" }),
      changedSource({ text: `Section 101/102 Combined scope\n${quote}` }),
    ),
  ).toBe(false);
  expect(
    citationHasSourceSupport(
      citation,
      changedSource({ title: "2023-1 Florida Building Code Building" }),
    ),
  ).toBe(false);
});

test("binds table clauses independently of the section with the same number", () => {
  const sections = changedSource({
    text: `Section 403.1 General\nThis section establishes the governing building scope.\nTable 403.1 Minimum provisions\n${quote}`,
  });

  expect(citationHasSourceSupport(changedCitation({ section: "403.1" }), sections)).toBe(false);
  expect(citationHasSourceSupport(changedCitation({ section: "Table 403.1" }), sections)).toBe(
    true,
  );
});
