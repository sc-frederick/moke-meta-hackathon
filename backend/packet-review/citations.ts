import type { PacketCitation, PacketSource } from "#lib/review/packet.ts";

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u00ad/g, "")
    .replace(/\s+/gu, " ")
    .trim();

const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)*/gu) ?? [];

const phrase = (text: string) => words(text).join(" ");

const containsPhrase = (text: string, value: string) => {
  const expected = phrase(value);

  return expected.length > 0 && ` ${phrase(text)} `.includes(` ${expected} `);
};

const sectionText = (text: string) =>
  normalize(text)
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/(?<=[\p{L}\p{N}])\s*([.-])\s*(?=[\p{L}\p{N}])/gu, "$1")
    .replace(/(?<=[\p{L}\p{N})])\s+(?=\()/gu, "")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")");

const sectionIdentifier = (text: string) =>
  sectionText(text)
    .replace(/^(?:(?:section|sec\.?|article)\s*|§\s*)/u, "")
    .replace(/^table\s*/u, "table ");

function containsEdition(text: string, edition: string) {
  const expected = sectionText(edition);

  if (!expected) return false;
  const retrieved = sectionText(text);
  let position = retrieved.indexOf(expected);

  while (position >= 0) {
    const before = retrieved[position - 1] ?? "";
    const after = retrieved[position + expected.length] ?? "";

    if (!/[\p{L}\p{N}_./-]/u.test(before) && !/[\p{L}\p{N}_./-]/u.test(after)) return true;
    position = retrieved.indexOf(expected, position + expected.length);
  }

  return false;
}

function sectionEvidence(text: string, section: string) {
  const lines = text.normalize("NFKC").replace(/\r\n?/g, "\n").split("\n");
  const headings: Array<{ line: number; id: string | null }> = [];

  for (const [line, contents] of lines.entries()) {
    // Florida Statutes pages print the section's page title before its number: "F.S. 553.79 553.79 ...".
    const value = sectionText(contents)
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^f\.s\.\s*(\d+(?:\.\d+)+)\s+(?=\1\b)/u, "");

    const explicit = /^(?:section\b|sec\.?\s|article\b|table\b|§)/u.test(value);

    const matched = value.match(
      /^(?:(section|sec\.?|article|table|§)\s*)?([a-z]?\d+(?:[.-]\d+)*(?:\([a-z0-9]+\))*)\.?(?:\s+|$)/u,
    );

    const id = matched?.[2];

    if (
      id &&
      (explicit || ((/[.-]/u.test(id) || /\d{3}/u.test(id)) && !/^(?:19|20)\d{2}$/u.test(id)))
    )
      headings.push({ line, id: matched?.[1] === "table" ? `table ${id}` : id });
    else if (explicit || /^\d+[/.(-]/u.test(value)) headings.push({ line, id: null });
  }

  const expected = sectionIdentifier(section);
  const matches = headings.filter((heading) => heading.id === expected);

  if (matches.length !== 1) return undefined;
  const heading = matches[0];

  if (!heading) return undefined;
  const next = headings.find((candidate) => candidate.line > heading.line);

  return {
    identity: lines.slice(0, headings[0]?.line ?? 0).join("\n"),
    text: lines.slice(heading.line, next?.line ?? lines.length).join("\n"),
  };
}

function substantiveQuote(quote: string) {
  const tokens = words(quote);
  const normalized = tokens.join(" ");

  if (normalized.length < 40 || tokens.length < 6) return false;

  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "must",
    "not",
    "of",
    "on",
    "or",
    "shall",
    "that",
    "the",
    "these",
    "this",
    "those",
    "to",
    "with",
  ]);

  const content = new Set(tokens.filter((token) => /\p{L}/u.test(token) && !stopwords.has(token)));

  return content.size >= 3;
}

/**
 * Check retrieved textual support for a citation's claimed identity and quote.
 * This does not establish adopted jurisdiction, correct interpretation, or applicability to the project.
 */
export function citationHasSourceSupport(
  citation: typeof PacketCitation.Type,
  source: typeof PacketSource.Type | undefined,
): boolean {
  if (
    source === undefined ||
    citation.sourceId !== source.id ||
    source.status !== "available" ||
    !source.official ||
    phrase(citation.application).length === 0 ||
    !substantiveQuote(citation.quote)
  )
    return false;
  const section = sectionEvidence(source.text, citation.section);

  if (!section) return false;
  const identity = `${source.title}\n${section.identity}`;

  return (
    containsPhrase(identity, citation.document) &&
    containsEdition(identity, citation.edition) &&
    containsPhrase(section.text, citation.quote)
  );
}
