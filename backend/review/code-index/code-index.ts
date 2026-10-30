import { Schema, Struct } from "effect";
import reference from "./assets/FBC_2023_plan_review_reference.md" with { type: "text" };
import additions from "./assets/florida-code-additions.md" with { type: "text" };
import provenance from "./provenance.json";

/** Index version recorded with reviews; change it whenever an asset or the parser changes. */
export const codeIndexVersion = provenance.version;

/**
 * How a reviewer can read the governing text. ICC Digital Codes blocks automated clients and its
 * user agreement excludes robots, and Florida rules publish their text as Word documents, so those
 * links are for the engineer to open. Statute pages can be retrieved and verified with read_source.
 */
export const CodeTextAccess = Schema.Literals(["read_source", "open_in_browser"]);

/** One pointer from a review check to a Florida code section, statute or rule; never code text. */
export class CodeReference extends Schema.Class<CodeReference>("CodeReference")({
  /** Stable identity: the link without its scheme, which is unique across both assets. */
  id: Schema.NonEmptyString,
  /** Code volume or body of law, such as "FBC Building (Commercial)" or "Florida Statutes". */
  document: Schema.NonEmptyString,
  edition: Schema.NonEmptyString,
  topic: Schema.NonEmptyString,
  /** Section, statute or rule numbers named in the title, such as "1005", "R302" or "553.79". */
  sections: Schema.Array(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  /** What a plan reviewer checks against this section. */
  check: Schema.NonEmptyString,
  url: Schema.String.check(Schema.isStartingWith("https://")),
  access: CodeTextAccess,
}) {}

const entryPattern =
  /^- \*\*(.+?)\*\* - (.+?)\s*((?:\[[^\]]*Link\]\(https:\/\/[^)\s]+\)\s*\/?\s*)+)$/;

const linkPattern = /\[([^\]]*)Link\]\((https:\/\/[^)\s]+)\)/g;

// FBC sections (1005, 1609.3, R302, N1101, C402), statutes (553.79) and rules (61G15-23.002).
const sectionPattern =
  /\b(?:\d{2}[A-Z]\d{0,2}-\d{1,3}(?:\.\d{3,4})?|[A-Z]{0,2}\d{3,4}(?:\.\d+)*)\b/g;

const accessFor = (url: URL): typeof CodeTextAccess.Type =>
  url.hostname.endsWith("iccsafe.org") || url.hostname.endsWith("flrules.org")
    ? "open_in_browser"
    : "read_source";

/** Parse one reference file: `## Document - Edition`, `### Topic`, then bold-titled link entries. */
export function parseCodeReferences(markdown: string): ReadonlyArray<CodeReference> {
  const entries: Array<CodeReference> = [];
  let document: string | null = null;
  let edition: string | null = null;
  let topic: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{2,4}) (.+)$/.exec(line);

    if (heading) {
      const [, level, text = ""] = heading;

      if (level === "##") {
        const split = text.lastIndexOf(" - ");
        document = split < 0 ? null : text.slice(0, split).trim();
        edition = split < 0 ? null : text.slice(split + 3).trim();
        topic = null;
      } else topic = level === "###" ? text.trim() : null;

      continue;
    }

    const entry = entryPattern.exec(line);

    if (!entry || document === null || edition === null || topic === null) continue;
    const [, title = "", check = "", links = ""] = entry;
    const targets = [...links.matchAll(linkPattern)];

    for (const [, label = "", href = ""] of targets) {
      const url = new URL(href);
      const named = targets.length > 1 && label.trim() ? `${title} (${label.trim()})` : title;

      entries.push(
        new CodeReference({
          id: `${url.host}${url.pathname}${url.search}${url.hash}`,
          document,
          edition,
          topic,
          sections: [...new Set(title.match(sectionPattern) ?? [])],
          title: named,
          check,
          url: url.href,
          access: accessFor(url),
        }),
      );
    }
  }

  return entries;
}

/** A section listed under two topics keeps both entries; later ones get a `~2`, `~3` suffix. */
function withUniqueIds(entries: ReadonlyArray<CodeReference>): ReadonlyArray<CodeReference> {
  const counts = new Map<string, number>();

  return entries.map((entry) => {
    const count = (counts.get(entry.id) ?? 0) + 1;
    counts.set(entry.id, count);

    return count === 1
      ? entry
      : new CodeReference(Struct.assign(entry, { id: `${entry.id}~${count}` }));
  });
}

/** The bundled Florida index: the plan review reference followed by the additions. */
export const floridaCodeIndex: ReadonlyArray<CodeReference> = withUniqueIds([
  ...parseCodeReferences(reference),
  ...parseCodeReferences(additions),
]);

/** Look up an entry by the id search_code returned. */
export const codeReference = (id: string) => floridaCodeIndex.find((entry) => entry.id === id);

const stopWords = new Set(
  "a an and are as at be by for from in is of on or the to with what which where when how does".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word.length > 1 && !stopWords.has(word));

/** A query section matches itself, its subsections, and the parent section it belongs to. */
const sectionScore = (query: string, section: string) => {
  const left = query.toLowerCase();
  const right = section.toLowerCase();

  if (left === right) return 10;

  return left.startsWith(`${right}.`) || right.startsWith(`${left}.`) ? 6 : 0;
};

/** Rank index entries for a reviewer's query by section numbers, then title, topic and check words. */
export function searchCodeReferences(
  index: ReadonlyArray<CodeReference>,
  query: string,
  limit: number,
): ReadonlyArray<CodeReference> {
  const terms = words(query);

  if (terms.length === 0) return [];

  return index
    .flatMap((entry) => {
      const fields = [
        { words: new Set(words(entry.title)), weight: 3 },
        { words: new Set(words(entry.topic)), weight: 2 },
        { words: new Set(words(`${entry.document} ${entry.edition}`)), weight: 1.5 },
        { words: new Set(words(entry.check)), weight: 1 },
      ];

      let matched = 0;
      let score = 0;

      for (const term of terms) {
        const section = Math.max(0, ...entry.sections.map((value) => sectionScore(term, value)));

        const field = Math.max(
          0,
          ...fields.map((item) => (item.words.has(term) ? item.weight : 0)),
        );

        if (section + field > 0) matched++;
        score += section + field;
      }

      // Entries matching every query term rank above those matching one term strongly.
      const total = score + (matched === terms.length ? terms.length * 2 : 0);

      return total > 0 ? [{ entry, score: total }] : [];
    })
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => result.entry);
}
