import { Effect, Schema } from "effect";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { CloudEngineIdentity, CloudWorkerProgress, type CloudReviewRecord } from "./contracts.ts";

/** Workers from earlier protocols, as built with any packet prompt they shipped with. */
const priorWorkerProgress = (protocol: 2 | 3) =>
  Schema.Struct({
    ...CloudWorkerProgress.fields,
    identity: Schema.Struct({
      ...CloudEngineIdentity.fields,
      protocol: Schema.Literal(protocol),
      packetPrompt: Schema.Literals([
        "moke-packet-review-v1",
        "moke-packet-review-v2",
        "moke-packet-review-v3",
      ]),
    }),
  });

const Protocol3CloudWorkerProgress = priorWorkerProgress(3);

/** Unmarked receipts were saved by protocol 2 or 3 desktops, never by protocol 4. */
const UnmarkedCloudWorkerProgress = Schema.Union([
  Protocol3CloudWorkerProgress,
  priorWorkerProgress(2),
]);

// Protocol 4 first shipped with v3. Its already-dispatched results must survive
// the v4 prompt upgrade without admitting an old worker for new reviews.
const Protocol4CloudWorkerProgress = Schema.Union([
  CloudWorkerProgress,
  Schema.Struct({
    ...CloudWorkerProgress.fields,
    identity: Schema.Struct({
      ...CloudEngineIdentity.fields,
      packetPrompt: Schema.Literal("moke-packet-review-v3"),
    }),
  }),
]);

const RecoverableCloudWorkerProgress = Schema.Union([
  Protocol4CloudWorkerProgress,
  UnmarkedCloudWorkerProgress,
]);

/** Recovery retains the worker's actual protocol without relaxing new worker admission. */
export type CloudRecoveredWorkerProgress = typeof RecoverableCloudWorkerProgress.Type;

/** Well above a full finding preview and execution status; anything larger is not a progress record. */
export const cloudWorkerProgressMaxBytes = 256 * 1024;

/** Parse progress for the saved owner before acknowledging any result checkpoint. */
export const parseCloudWorkerProgress = Effect.fn("parseCloudWorkerProgress")(function* (
  record: CloudReviewRecord,
  text: string,
) {
  if (Buffer.byteLength(text) > cloudWorkerProgressMaxBytes)
    return yield* new CloudReviewError({
      reason: "incompatible",
      message: "The cloud service returned oversized review progress. Refresh to reconnect.",
    });

  // Old receipts also include v3 jobs saved before this marker was introduced. Only
  // observation of already dispatched work can accept v2 or v3; this never admits a request.
  const dispatched = record.phase === "dispatching" || record.phase === "running";

  const schema = !dispatched
    ? CloudWorkerProgress
    : record.workerProtocol === undefined
      ? UnmarkedCloudWorkerProgress
      : record.workerProtocol === 3
        ? Protocol3CloudWorkerProgress
        : Protocol4CloudWorkerProgress;

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
