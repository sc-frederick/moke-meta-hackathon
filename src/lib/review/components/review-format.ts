import type { CheckRun, CountFact, Finding, Sheet } from "#lib/review/contracts.ts";

/** Compact elapsed time shared by live progress and saved replies. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Human-readable check outcome for lists and the source header. */
export function formatOutcome(outcome: Finding["outcome"]): string {
  switch (outcome) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "needs_evidence":
      return "Needs evidence";
    case "supported_issue":
      return "Count mismatch";
    case "checked_no_issue":
      return "Counts match";
    case "stale":
      return "Drawing changed";
    case "outside_scope":
      return "Outside scope";
  }
}

/** Monogram from a project name for the breadcrumb. */
export function projectMonogram(name: string): string {
  const trimmed = name.trim();

  if (trimmed.length === 0) return "?";

  return trimmed.charAt(0).toUpperCase();
}

/** Latest accepted fact for one operand side. */
export function latestAcceptedFact(
  facts: ReadonlyArray<CountFact>,
  findingId: string,
  side: "drawn" | "scheduled",
) {
  return facts.findLast(
    (fact) => fact.findingId === findingId && fact.side === side && fact.state === "accepted",
  );
}

/** Checks for one finding, newest last. */
export function checksForFinding(checks: ReadonlyArray<CheckRun>, findingId: string) {
  return checks.filter((check) => check.findingId === findingId);
}

/** Sheet label with confirmation state for navigation. */
export function sheetCaption(sheet: Sheet): string {
  let coverage = "unreviewed";

  if (sheet.coverage === "reviewer_complete") coverage = "complete";
  else if (sheet.coverage === "partial") coverage = "partial";

  return `${sheet.label}${sheet.confirmed ? "" : " (unconfirmed)"} · ${coverage}`;
}

/** Finding row subtitle for the popover. */
export function findingSubtitle(finding: Finding, sheets: ReadonlyArray<Sheet>): string {
  const drawn = sheets.find((sheet) => sheet.id === finding.drawnSheetId);
  const scheduled = sheets.find((sheet) => sheet.id === finding.scheduledSheetId);

  return `${drawn?.label ?? "Drawn"} ↔ ${scheduled?.label ?? "Scheduled"}`;
}
