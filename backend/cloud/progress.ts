import { Effect, Schema } from "effect";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { CloudEngineIdentity, CloudWorkerProgress, type CloudReviewRecord } from "./contracts.ts";

const LegacyCloudWorkerProgress = Schema.Struct({
  ...CloudWorkerProgress.fields,
  identity: Schema.Struct({ ...CloudEngineIdentity.fields, protocol: Schema.Literal(2) }),
});

const RecoverableCloudWorkerProgress = Schema.Union([
  CloudWorkerProgress,
  LegacyCloudWorkerProgress,
]);

/** Recovery retains the worker's actual protocol without relaxing new worker admission. */
export type CloudRecoveredWorkerProgress = typeof RecoverableCloudWorkerProgress.Type;

/** Parse progress for the saved owner before acknowledging any result checkpoint. */
export const parseCloudWorkerProgress = Effect.fn("parseCloudWorkerProgress")(function* (
  record: CloudReviewRecord,
  text: string,
) {
  // Old receipts also include v3 jobs saved before this marker was introduced. Only
  // observation of already dispatched work can accept v2; this never admits a request.
  const schema =
    record.workerProtocol === undefined &&
    (record.phase === "dispatching" || record.phase === "running")
      ? RecoverableCloudWorkerProgress
      : CloudWorkerProgress;

  const progress = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      () =>
        new CloudReviewError({
          reason: "incompatible",
          message: "The cloud service returned unreadable review progress. Refresh to reconnect.",
        }),
    ),
  );

  if (progress.id !== record.id)
    return yield* new CloudReviewError({
      reason: "incompatible",
      message:
        "The cloud service returned a different review. Your local workspace is still protected.",
    });

  return progress;
});
