import { Effect, Schema } from "effect";

const Mark = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9-]*$/));
const Quantity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A transcribed row from the drawing's fixture schedule, independent of plan detection. */
export const FixtureSchedule = Schema.Struct({
  rows: Schema.NonEmptyArray(
    Schema.Struct({
      mark: Mark,
      description: Schema.NonEmptyString,
      quantity: Quantity,
    }),
  ),
});

/** One plan candidate with its source and evidence outcome, before human acceptance. */
export const InventoryFixture = Schema.Struct({
  id: Schema.NonEmptyString,
  mark: Mark,
  room: Schema.NonEmptyString,
  scope: Schema.Literals(["existing", "new", "unclear"]),
  crop: Schema.NonEmptyString,
  pdf: Schema.NonEmptyString,
  page: Schema.Int.check(Schema.isGreaterThan(0)),
  evidence: Schema.Literals(["available", "failed"]),
  proposal: Schema.Struct({ left: Quantity, top: Quantity, right: Quantity, bottom: Quantity }),
});

/** Plan candidates are proposals; a mask does not verify a candidate's semantic class. */
export type InventoryFixture = typeof InventoryFixture.Type;

/** Invalid inventory sources cannot be reconciled by silently dropping rows. */
export class ReconciliationError extends Schema.TaggedError<ReconciliationError>()(
  "ReconciliationError",
  {
    message: Schema.String,
  },
) {}

/** Reconcile only explicitly covered fixture classes; other schedule rows remain untested. */
export const reconcileFixtures = Effect.fn("reconcileFixtures")(function* (
  schedule: typeof FixtureSchedule.Type,
  fixtures: ReadonlyArray<InventoryFixture>,
  coveredMarks: ReadonlyArray<string>,
) {
  if (new Set(schedule.rows.map((row) => row.mark)).size !== schedule.rows.length) {
    return yield* new ReconciliationError({
      message: "The schedule contains duplicate fixture marks.",
    });
  }

  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    return yield* new ReconciliationError({
      message: "The inventory contains duplicate candidate IDs.",
    });
  }

  if (fixtures.some((fixture) => !coveredMarks.includes(fixture.mark))) {
    return yield* new ReconciliationError({
      message: "An inventory fixture is outside the declared coverage.",
    });
  }

  const marks = new Set([...schedule.rows.map((row) => row.mark), ...coveredMarks]);

  return Array.from(marks, (mark) => {
    const scheduled = schedule.rows.find((row) => row.mark === mark);
    const covered = coveredMarks.includes(mark);
    const candidates = fixtures.filter((fixture) => fixture.mark === mark);
    const available = candidates.filter((fixture) => fixture.evidence === "available").length;
    const failed = candidates.length - available;
    const count = covered ? available : null;
    const quantity = scheduled?.quantity ?? null;
    const delta = count !== null && quantity !== null ? count - quantity : null;

    return {
      mark,
      description: scheduled?.description ?? "Missing schedule row",
      scheduled: quantity,
      candidates: covered ? candidates.length : null,
      proposed: count,
      unresolved: covered ? failed : null,
      delta,
      status: !covered
        ? "not-tested"
        : failed > 0 || quantity === null
          ? "needs-input"
          : delta === 0
            ? "counts-agree"
            : "counts-differ",
    };
  });
});
