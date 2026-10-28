import type { CountFact, Finding } from "#lib/review/contracts.ts";

/** The first rule compares reviewer-accepted counts; it asserts no regulatory threshold. */
export function evaluateCoordination(
  finding: Finding,
  drawn: CountFact | undefined,
  scheduled: CountFact | undefined,
) {
  if (!finding.applicabilityConfirmed) {
    return {
      outcome: "outside_scope" as const,
      difference: null,
      explanation: "Confirm that the selected plan region and schedule describe the same object class and scope.",
    };
  }

  if (
    drawn?.state !== "accepted" ||
    scheduled?.state !== "accepted" ||
    !drawn.coverageConfirmed ||
    !scheduled.coverageConfirmed
  ) {
    return {
      outcome: "needs_evidence" as const,
      difference: null,
      explanation: "Accept both source-linked counts and confirm coverage of the selected scope before evaluating.",
    };
  }

  const difference = drawn.value - scheduled.value;

  return {
    outcome: difference === 0 ? ("checked_no_issue" as const) : ("supported_issue" as const),
    difference,
    explanation: `${drawn.value} drawn − ${scheduled.value} scheduled = ${difference}. ${difference === 0 ? "The accepted counts agree." : "The accepted counts disagree; coordinate the selected sources."}`,
  };
}
