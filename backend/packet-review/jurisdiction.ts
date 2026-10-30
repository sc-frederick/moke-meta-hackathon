import { Schema } from "effect";
import type { PacketJurisdictionLeads } from "#lib/review/packet.ts";

const states = [
  ["Alabama", "AL"],
  ["Alaska", "AK"],
  ["Arizona", "AZ"],
  ["Arkansas", "AR"],
  ["California", "CA"],
  ["Colorado", "CO"],
  ["Connecticut", "CT"],
  ["Delaware", "DE"],
  ["District of Columbia", "DC"],
  ["Florida", "FL"],
  ["Georgia", "GA"],
  ["Hawaii", "HI"],
  ["Idaho", "ID"],
  ["Illinois", "IL"],
  ["Indiana", "IN"],
  ["Iowa", "IA"],
  ["Kansas", "KS"],
  ["Kentucky", "KY"],
  ["Louisiana", "LA"],
  ["Maine", "ME"],
  ["Maryland", "MD"],
  ["Massachusetts", "MA"],
  ["Michigan", "MI"],
  ["Minnesota", "MN"],
  ["Mississippi", "MS"],
  ["Missouri", "MO"],
  ["Montana", "MT"],
  ["Nebraska", "NE"],
  ["Nevada", "NV"],
  ["New Hampshire", "NH"],
  ["New Jersey", "NJ"],
  ["New Mexico", "NM"],
  ["New York", "NY"],
  ["North Carolina", "NC"],
  ["North Dakota", "ND"],
  ["Ohio", "OH"],
  ["Oklahoma", "OK"],
  ["Oregon", "OR"],
  ["Pennsylvania", "PA"],
  ["Rhode Island", "RI"],
  ["South Carolina", "SC"],
  ["South Dakota", "SD"],
  ["Tennessee", "TN"],
  ["Texas", "TX"],
  ["Utah", "UT"],
  ["Vermont", "VT"],
  ["Virginia", "VA"],
  ["Washington", "WA"],
  ["West Virginia", "WV"],
  ["Wisconsin", "WI"],
  ["Wyoming", "WY"],
] as const;

const byCode = new Map<string, string>(states.map(([name, code]) => [code, name]));

// Longer names first, so "West Virginia" is not also read as "Virginia".
const names = states.map(([name]) => name).toSorted((left, right) => right.length - left.length);

// Agency words end a place name: "City of Tampa Building Department" is the City of Tampa.
const Word =
  "(?!(?:AHJ|Building|Code|Codes|Department|Development|Division|Fire|Office|Permit|Permitting|Planning|Services|Zoning)\\b)[A-Z][A-Za-z.'-]*";

const Place = `${Word}(?:\\s+${Word}){0,3}`;

/** States and named counties or municipalities found in free-form jurisdiction text. */
export interface JurisdictionPlace {
  readonly states: ReadonlySet<string>;
  readonly localities: ReadonlySet<string>;
}

/**
 * Reads US states (full names, or a two-letter code after a comma, as in "Tampa, FL") and
 * "X County", "City of X" style localities. Text without either has no place.
 */
export function jurisdictionPlace(text: string): JurisdictionPlace {
  let rest = ` ${text} `;
  const found = new Set<string>();

  for (const name of names) {
    const pattern = new RegExp(`\\b${name.replaceAll(" ", "\\s+")}\\b`, "gi");

    if (pattern.test(rest)) {
      found.add(name);
      rest = rest.replace(pattern, " ");
    }
  }

  for (const match of text.matchAll(/,\s*([A-Z]{2})\b(?![a-z])/g)) {
    const name = byCode.get(match[1] ?? "");

    if (name !== undefined) found.add(name);
  }

  const localities = new Set<string>();

  for (const match of text.matchAll(new RegExp(`\\b(${Place})\\s+(County|Parish|Borough)\\b`, "g")))
    localities.add(`${match[1]} ${match[2]}`.toLowerCase());

  for (const match of text.matchAll(
    new RegExp(`\\b(City|Town|Village|Township)\\s+of\\s+(${Place})`, "g"),
  ))
    localities.add(`${match[1]} of ${match[2]}`.toLowerCase());

  // A state name is not a locality ("State of Florida").
  for (const locality of localities)
    if (names.some((name) => locality.endsWith(` of ${name.toLowerCase()}`)))
      localities.delete(locality);

  return { states: found, localities };
}

/** How closely an earlier jurisdiction matches: a shared locality, the same state, or neither. */
export function jurisdictionMatch(
  current: JurisdictionPlace,
  earlier: JurisdictionPlace,
): "locality" | "state" | null {
  const sharedState = [...current.states].some((state) => earlier.states.has(state));

  // Named states that differ rule out a match, even for a same-named county.
  if (current.states.size > 0 && earlier.states.size > 0 && !sharedState) return null;

  if ([...current.localities].some((locality) => earlier.localities.has(locality)))
    return "locality";

  return sharedState ? "state" : null;
}

/** The value of the first project configuration key that names the jurisdiction. */
export function jurisdictionValue(configuration: Readonly<Record<string, string>>) {
  const entry = Object.entries(configuration).find(([key]) =>
    /jurisdiction|^ahj$|authority/i.test(key),
  );

  return entry?.[1].trim() || null;
}

/** The parts of an earlier review this module reads; source text is never loaded. */
export const EarlierReview = Schema.Struct({
  id: Schema.String,
  projectName: Schema.String,
  changedAt: Schema.Finite,
  projectConfiguration: Schema.Record(Schema.String, Schema.String),
  sources: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      status: Schema.String,
      official: Schema.Boolean,
      retrievedAt: Schema.String,
    }),
  ),
  citations: Schema.Array(
    Schema.Struct({
      jurisdiction: Schema.String,
      document: Schema.String,
      edition: Schema.String,
      section: Schema.String,
      status: Schema.String,
    }),
  ),
  priorComments: Schema.Array(
    Schema.Struct({ agency: Schema.String, comment: Schema.String, status: Schema.String }),
  ),
});

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const limits = { reviews: 5, sources: 12, citations: 12, editions: 8, agencyComments: 10 } as const;

/**
 * Leads for the requirements pass from earlier reviews in the same state or locality: governing
 * sources they read, citations they recorded, code editions in their project configuration and
 * agency comments. `history` is the tool result; `leads` is what the review records.
 */
export function jurisdictionHistory(
  jurisdiction: string,
  earlier: ReadonlyArray<typeof EarlierReview.Type>,
) {
  const place = jurisdictionPlace(jurisdiction);

  const matched = earlier
    .flatMap((review) => {
      const value = jurisdictionValue(review.projectConfiguration);
      const match = value === null ? null : jurisdictionMatch(place, jurisdictionPlace(value));

      return match === null || value === null ? [] : [{ review, value, match }];
    })
    .toSorted(
      (left, right) =>
        Number(right.match === "locality") - Number(left.match === "locality") ||
        right.review.changedAt - left.review.changedAt,
    );

  const sources = new Map<string, (typeof EarlierReview.Type)["sources"][number]>();
  const citations = new Map<string, (typeof EarlierReview.Type)["citations"][number]>();
  const editions = new Map<string, { key: string; value: string; projectName: string }>();

  const comments = new Map<
    string,
    (typeof EarlierReview.Type)["priorComments"][number] & { projectName: string }
  >();

  for (const { review, value } of matched) {
    for (const source of review.sources)
      if (!sources.has(source.url)) sources.set(source.url, source);

    for (const citation of review.citations) {
      const key = [citation.document, citation.edition, citation.section].join("\u0000");
      const known = citations.get(key);

      if (known === undefined || (known.status !== "verified" && citation.status === "verified"))
        citations.set(key, citation);
    }

    for (const [key, text] of Object.entries(review.projectConfiguration))
      if (
        /code|edition|amend/i.test(key) &&
        text !== value &&
        !/^needs input/i.test(text.trim()) &&
        !editions.has(text)
      )
        editions.set(text, { key, value: text, projectName: review.projectName });

    for (const comment of review.priorComments)
      if (!comments.has(comment.comment))
        comments.set(comment.comment, { ...comment, projectName: review.projectName });
  }

  const reviews = matched.slice(0, limits.reviews);
  const sourceLeads = [...sources.values()].slice(0, limits.sources);

  const citationLeads = [...citations.values()]
    .toSorted(
      (left, right) => Number(right.status === "verified") - Number(left.status === "verified"),
    )
    .slice(0, limits.citations);

  const editionLeads = [...editions.values()].slice(0, limits.editions);
  const commentLeads = [...comments.values()].slice(0, limits.agencyComments);

  return {
    history: {
      jurisdiction,
      note: "Leads from earlier MOKE reviews in this workspace, matched by state or locality. They are not evidence for this project. Read a source again with read_source and confirm its edition and applicability before citing it. Check an earlier agency comment against the current drawings before recording anything.",
      earlierReviews: reviews.map(({ review, value, match }) => ({
        projectName: review.projectName,
        jurisdiction: clip(value, 200),
        match,
        reviewedAt: new Date(review.changedAt).toISOString(),
      })),
      sources: sourceLeads.map(({ url, title, status, official, retrievedAt }) => ({
        url,
        title: clip(title, 200),
        status,
        official,
        retrievedAt,
      })),
      citations: citationLeads.map((citation) => ({
        jurisdiction: clip(citation.jurisdiction, 200),
        document: clip(citation.document, 200),
        edition: clip(citation.edition, 120),
        section: clip(citation.section, 120),
        status: citation.status,
      })),
      recordedEditions: editionLeads.map(({ key, value, projectName }) => ({
        key: clip(key, 80),
        value: clip(value, 300),
        projectName,
      })),
      agencyComments: commentLeads.map(({ agency, comment, status, projectName }) => ({
        agency: clip(agency, 120),
        comment: clip(comment, 400),
        status,
        projectName,
      })),
    },
    leads: {
      jurisdiction: clip(jurisdiction, 32000),
      reviews: reviews.map(({ review, value, match }) => ({
        reviewId: review.id,
        projectName: review.projectName,
        jurisdiction: clip(value, 200),
        match,
      })),
      sources: sourceLeads.length,
      citations: citationLeads.length,
      editions: editionLeads.length,
      agencyComments: commentLeads.length,
    } satisfies typeof PacketJurisdictionLeads.Type,
  };
}
