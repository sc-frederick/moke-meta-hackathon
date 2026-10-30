import type { Effect, Stream } from "effect";
import type { InferenceConfiguration } from "#lib/backend-rpc.ts";
import type { CloudReviewError, CloudTransferProgress } from "#lib/review/cloud.ts";
import type { PackageFile } from "#lib/review/packages.ts";
import type { CloudCachedFile, CloudPendingRetain } from "./cache.ts";
import type { CloudReviewRecord } from "./contracts.ts";
import type { CloudRecoveredWorkerProgress } from "./progress.ts";

/** Sandbox mechanics stay behind the cloud application's replay and ownership policy. */
export interface CloudSandboxPort {
  /** Resolve the published image and every outbound provider secret without starting compute. */
  readonly preflight: (
    providers: ReadonlyArray<typeof InferenceConfiguration.Type>,
  ) => Effect.Effect<void, CloudReviewError>;
  /** Change signals are hints; callers reconcile the durable job after subscribing and on reconnect. */
  readonly changes: (record: CloudReviewRecord) => Stream.Stream<void, CloudReviewError>;
  readonly allocate: (record: CloudReviewRecord) => Effect.Effect<string, CloudReviewError>;
  /** Uploads the package, skipping files the record's read-only cache Volume already holds. */
  readonly upload: (
    record: CloudReviewRecord,
    source: string,
    report: (progress: typeof CloudTransferProgress.Type) => Effect.Effect<void, CloudReviewError>,
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
    report: (progress: typeof CloudTransferProgress.Type) => Effect.Effect<void, CloudReviewError>,
    /** Fills a result file from a matching local copy before it is downloaded. */
    reuse?: (file: PackageFile, local: string) => Effect.Effect<void>,
  ) => Effect.Effect<void, CloudReviewError>;
  /** Commits verified files to the workspace cache and returns what it holds afterwards. */
  readonly seedCache: (
    request: CloudCacheSeed,
  ) => Effect.Effect<ReadonlyArray<CloudCachedFile>, CloudReviewError>;
  /** This only succeeds once the original execution sandbox is confirmed terminated. */
  readonly stop: (record: CloudReviewRecord) => Effect.Effect<void, CloudReviewError>;
}

/** Ready progress is acknowledged only with a completed external result snapshot. */
export interface CloudObservedProgress {
  readonly progress: CloudRecoveredWorkerProgress;
  readonly resultSnapshotId: string | null;
  /** The original execution sandbox is confirmed stopped, even if its last progress was active. */
  readonly sourceStopped: boolean;
}

/** One bounded cache update, run in a short-lived, network-blocked uploader sandbox. */
export interface CloudCacheSeed {
  readonly volume: string;
  /** Copied inside Modal from earlier review snapshots; these never use the desktop uplink. */
  readonly snapshots: ReadonlyArray<CloudPendingRetain>;
  /** Local files uploaded with the desktop uplink, in order, until `paused` reports true. */
  readonly local: ReadonlyArray<CloudCachedFile & { readonly path: string }>;
  /** Hashes the workspace still references; every other cached file is deleted. Null keeps all. */
  readonly keep: ReadonlyArray<string> | null;
  /** A cloud Send needs the uplink and owns the workspace, so local uploads and pruning stop. */
  readonly paused: Effect.Effect<boolean>;
}
