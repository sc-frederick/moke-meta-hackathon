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

function containsSection(text: string, section: string) {
  const expected = sectionText(section).replace(/^(?:(?:section|sec\.?)\s+|§\s*)/u, "");

  if (!/\d/u.test(expected)) return false;
  const retrieved = sectionText(text);
  let start = retrieved.indexOf(expected);

  while (start >= 0) {
    const before = retrieved[start - 1] ?? "";
    const after = retrieved[start + expected.length] ?? "";

    if (!/[\p{L}\p{N}_.-]/u.test(before) && !/[\p{L}\p{N}_.(-]/u.test(after)) return true;
    start = retrieved.indexOf(expected, start + expected.length);
  }

  return false;
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
  const identity = `${source.title}\n${source.text}`;

  return (
    containsPhrase(identity, citation.document) &&
    containsPhrase(identity, citation.edition) &&
    containsSection(identity, citation.section) &&
    containsPhrase(source.text, citation.quote)
  );
}
