import type { Effect, Stream } from "effect";
import type { InferenceConfiguration } from "#lib/backend-rpc.ts";
import type { CloudReviewError } from "#lib/review/cloud.ts";
import type { CloudReviewRecord, CloudWorkerProgress } from "./contracts.ts";

/** Sandbox mechanics stay behind the cloud application's replay and ownership policy. */
export interface CloudSandboxPort {
  /** Change signals are hints; callers reconcile the durable job after subscribing and on reconnect. */
  readonly changes: (record: CloudReviewRecord) => Stream.Stream<void, CloudReviewError>;
  readonly allocate: (record: CloudReviewRecord) => Effect.Effect<string, CloudReviewError>;
  readonly upload: (
    record: CloudReviewRecord,
    source: string,
  ) => Effect.Effect<string, CloudReviewError>;
  readonly dispatch: (
    record: CloudReviewRecord,
    provider: typeof InferenceConfiguration.Type,
    alternatives: ReadonlyArray<typeof InferenceConfiguration.Type>,
  ) => Effect.Effect<void, CloudReviewError>;
  readonly progress: (
    record: CloudReviewRecord,
  ) => Effect.Effect<CloudObservedProgress, CloudReviewError>;
  readonly download: (
    record: CloudReviewRecord,
    destination: string,
  ) => Effect.Effect<void, CloudReviewError>;
  /** This only succeeds once the original execution sandbox is confirmed terminated. */
  readonly stop: (record: CloudReviewRecord) => Effect.Effect<void, CloudReviewError>;
}

/** Ready progress is acknowledged only with a completed external result snapshot. */
export interface CloudObservedProgress {
  readonly progress: typeof CloudWorkerProgress.Type;
  readonly resultSnapshotId: string | null;
  /** The original execution sandbox is confirmed stopped, even if its last progress was active. */
  readonly sourceStopped: boolean;
}
