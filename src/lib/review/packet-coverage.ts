import { Match } from "effect";
import { reviewDisciplines } from "./execution.ts";
import { ReviewPass } from "./packet.ts";
import type { PacketCoverage, PacketReview, PacketScope, PacketSheet } from "./packet.ts";

/** Earlier coverage may be reused only while its immutable source identity is unchanged. */
export interface PreviousPacketCoverage {
  readonly sheets: ReadonlyArray<typeof PacketSheet.Type>;
  readonly coverage: ReadonlyArray<typeof PacketCoverage.Type>;
}

/** One required sheet, discipline and pass that cannot yet support settled coverage. */
export interface PacketCoverageGap {
  readonly sheetId: (typeof PacketSheet.Type)["id"];
  readonly discipline: (typeof PacketCoverage.Type)["discipline"];
  readonly pass: typeof ReviewPass.Type;
  readonly reason: "missing" | "unreviewed" | "needs_input" | "needs_reason";
}

/** Progress counts only the requested scope while retaining compatible historical rows for display. */
export interface PacketCoverageProgress {
  readonly rows: ReadonlyArray<typeof PacketCoverage.Type>;
  readonly ledger: ReadonlyArray<typeof PacketCoverage.Type>;
  readonly total: number;
  readonly recorded: number;
  readonly settled: number;
  readonly gaps: ReadonlyArray<PacketCoverageGap>;
  readonly complete: boolean;
}

const key = (entry: Pick<typeof PacketCoverage.Type, "sheetId" | "discipline" | "pass">) =>
  `${entry.sheetId}:${entry.discipline}:${entry.pass}`;

/** Original pixels remain compatible only for the same sheet, revision, hash, page and page box. */
export function samePacketSheetSource(
  left: typeof PacketSheet.Type,
  right: typeof PacketSheet.Type,
) {
  return (
    left.id === right.id &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256 &&
    left.pageIndex === right.pageIndex &&
    left.box.x === right.box.x &&
    left.box.y === right.box.y &&
    left.box.width === right.box.width &&
    left.box.height === right.box.height
  );
}

function requiredRows(
  scope: typeof PacketScope.Type,
  sheets: ReadonlyArray<typeof PacketSheet.Type>,
) {
  const disciplines = Match.value(scope).pipe(
    Match.tagsExhaustive({
      SelectedSheets: () => reviewDisciplines.map((discipline) => discipline.id),
      WholeSet: () => reviewDisciplines.map((discipline) => discipline.id),
      Discipline: ({ discipline }) => [discipline],
    }),
  );

  return sheets.flatMap((sheet) =>
    disciplines.flatMap((discipline) =>
      ReviewPass.literals.map((pass): typeof PacketCoverage.Type => ({
        sheetId: sheet.id,
        discipline,
        pass,
        status: "unreviewed",
        note: "",
      })),
    ),
  );
}

/** Keep compatible earlier rows and add every missing sheet/pass/discipline required by this scope. */
export function initializePacketCoverage(
  scope: typeof PacketScope.Type,
  sheets: ReadonlyArray<typeof PacketSheet.Type>,
  previous?: PreviousPacketCoverage,
): Array<typeof PacketCoverage.Type> {
  const currentSheets = new Map(sheets.map((sheet) => [sheet.id, sheet]));
  const previousSheets = new Map((previous?.sheets ?? []).map((sheet) => [sheet.id, sheet]));
  const rows = new Map<string, typeof PacketCoverage.Type>();

  for (const entry of previous?.coverage ?? []) {
    const current = currentSheets.get(entry.sheetId);
    const earlier = previousSheets.get(entry.sheetId);

    if (current && earlier && samePacketSheetSource(current, earlier)) rows.set(key(entry), entry);
  }

  for (const entry of requiredRows(scope, sheets)) {
    if (!rows.has(key(entry))) rows.set(key(entry), entry);
  }

  return [...rows.values()];
}

/** Missing, unreviewed and Needs input checks remain gaps; Not applicable requires an explicit reason. */
export function packetCoverageProgress(
  review: Pick<PacketReview, "scope" | "sheets" | "coverage">,
): PacketCoverageProgress {
  const recorded = new Map(review.coverage.map((entry) => [key(entry), entry]));

  const rows = requiredRows(review.scope, review.sheets).map(
    (entry) => recorded.get(key(entry)) ?? entry,
  );

  const gaps: Array<PacketCoverageGap> = [];

  for (const entry of rows) {
    const base = { sheetId: entry.sheetId, discipline: entry.discipline, pass: entry.pass };

    if (!recorded.has(key(entry))) gaps.push({ ...base, reason: "missing" });
    else if (entry.status === "unreviewed" || entry.status === "needs_input")
      gaps.push({ ...base, reason: entry.status });
    else if (entry.status === "not_applicable" && entry.note.trim().length === 0)
      gaps.push({ ...base, reason: "needs_reason" });
  }

  return {
    rows,
    ledger: initializePacketCoverage(review.scope, review.sheets, {
      sheets: review.sheets,
      coverage: review.coverage,
    }),
    total: rows.length,
    recorded: rows.filter((entry) => entry.status !== "unreviewed").length,
    settled: rows.length - gaps.length,
    gaps,
    complete: rows.length > 0 && gaps.length === 0,
  };
}

/** Status counts for a set of coverage records. */
export interface PacketCoverageCounts {
  readonly total: number;
  readonly checked: number;
  readonly issues: number;
  readonly needsInput: number;
  readonly unreviewed: number;
  readonly notApplicable: number;
}

/** One sheet's coverage records in ledger order, with their status counts. */
export interface PacketSheetCoverage {
  readonly rows: ReadonlyArray<typeof PacketCoverage.Type>;
  readonly counts: PacketCoverageCounts;
}

/** Count coverage records by status in one pass. */
export function countPacketCoverage(
  rows: ReadonlyArray<typeof PacketCoverage.Type>,
): PacketCoverageCounts {
  const counts = { checked: 0, issue: 0, needs_input: 0, unreviewed: 0, not_applicable: 0 };

  for (const row of rows) counts[row.status]++;

  return {
    total: rows.length,
    checked: counts.checked,
    issues: counts.issue,
    needsInput: counts.needs_input,
    unreviewed: counts.unreviewed,
    notApplicable: counts.not_applicable,
  };
}

/**
 * Group coverage records by sheet and count each sheet's statuses in one pass, so filters and
 * sheet search work on the grouped records instead of rescanning the ledger for every sheet.
 */
export function indexPacketCoverage(
  rows: ReadonlyArray<typeof PacketCoverage.Type>,
): ReadonlyMap<(typeof PacketSheet.Type)["id"], PacketSheetCoverage> {
  const grouped = new Map<(typeof PacketSheet.Type)["id"], Array<typeof PacketCoverage.Type>>();

  for (const row of rows) {
    const sheet = grouped.get(row.sheetId);

    if (sheet) sheet.push(row);
    else grouped.set(row.sheetId, [row]);
  }

  return new Map(
    [...grouped].map(([sheetId, sheetRows]) => [
      sheetId,
      { rows: sheetRows, counts: countPacketCoverage(sheetRows) },
    ]),
  );
}

/** Saved project-configuration keys are camelCase field names; show them as plain labels. */
export function configurationLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
