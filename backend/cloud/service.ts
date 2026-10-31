import {
  Clock,
  Context,
  Effect,
  Layer,
  PubSub,
  Queue,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudReviewError,
  CloudReviewSetup,
  CloudReviewStatus,
  cloudReviewLocksWorkspace,
  type CloudReviewRequest,
  type CloudWorkspaceEstimate,
} from "#lib/review/cloud.ts";
import { reviewModels } from "#lib/review/models.ts";
import {
  cloudEngineIdentity,
  cloudProviderEndpoints,
  cloudWorkerMinimumTimeoutMs,
  type CloudReviewRecord,
} from "./contracts.ts";
import {
  cloudReceiptReserveBytes,
  cloudRequestFingerprint,
  cloudStateBytes,
  cloudStateMaxBytes,
  compactCloudReceipt,
  createCloudDirectory,
  readCloudState,
  writeCloudState,
} from "./files.ts";
import type { CloudSandboxPort } from "./sandbox-port.ts";
import {
  cloudCacheVolumeName,
  listLocalArtifacts,
  readCloudCacheState,
  writeCloudCacheState,
  type CloudCacheState,
} from "./cache.ts";
import { parseCloudManifest, reuseLocalArtifact } from "./transfer.ts";

/** Application-owned sandbox port, implemented by Modal or a local test seam. */
export class CloudSandbox extends Context.Service<CloudSandbox, CloudSandboxPort>()(
  "app/CloudSandbox",
) {}

interface WorkspaceVersions {
  readonly sourceVersion: number;
  readonly factVersion: number;
  readonly projectVersion: number;
}

/** The parent serializes maintenance, closes local execution, and owns package recovery. */
export interface CloudReviewConfiguration {
  readonly directory: string;
  readonly modal?: typeof ModalConfiguration.Type;
  readonly provider?: typeof InferenceConfiguration.Type;
  readonly providers?: ReadonlyArray<typeof InferenceConfiguration.Type>;
  readonly inspect: (
    request: typeof CloudReviewRequest.Type,
  ) => Effect.Effect<WorkspaceVersions, CloudReviewError>;
  readonly prepare: (
    destination: string,
  ) => Effect.Effect<void | { readonly bytes: number }, CloudReviewError>;
  /** Read referenced files without quiescing local review work or writing a package. */
  readonly estimate?: Effect.Effect<typeof CloudWorkspaceEstimate.Type, CloudReviewError>;
  readonly restore: (source: string) => Effect.Effect<void, CloudReviewError>;
  readonly restorePending: () => boolean;
  /** Local artifact store for cache seeding and for reusing result files instead of downloading. */
  readonly dataDirectory?: string;
}

const conflict = () =>
  new CloudReviewError({
    reason: "conflict",
    message:
      "A cloud review owns this workspace. Wait for its results to sync or confirm it has stopped before making local changes.",
  });

const publicStatus = (record: CloudReviewRecord) => {
  const status = {
    id: record.id,
    revision: record.revision,
    projectId: record.request.projectId,
    findingId: "kind" in record.request ? null : record.request.findingId,
    phase: record.phase,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    execution: record.execution,
    message: record.message,
    syncFailure: record.syncFailure,
  };

  const contextual =
    "kind" in record.request
      ? {
          ...status,
          conversationId: record.request.conversationId,
          model: record.request.model,
          scopeLabel:
            record.request.selection?.mode === "selected_sheets"
              ? "Selected sheets"
              : record.request.discipline === "auto"
                ? "Whole set"
                : record.request.discipline,
        }
      : status;

  const transfer =
    record.transferBytes === undefined
      ? contextual
      : { ...contextual, transferBytes: record.transferBytes };

  const progress =
    record.transfer === undefined ? transfer : { ...transfer, transfer: record.transfer };

  return new CloudReviewStatus(
    record.packet === undefined ? progress : { ...progress, packet: record.packet },
  );
};

/** Durable, single-owner cloud review admission and return; status reads never replay dispatch. */
export class CloudReviews extends Context.Service<
  CloudReviews,
  {
    readonly setup: Effect.Effect<CloudReviewSetup>;
    readonly status: Effect.Effect<CloudReviewStatus | null>;
    readonly observe: Stream.Stream<CloudReviewStatus | null>;
    readonly watch: (id: string) => Stream.Stream<void, CloudReviewError>;
    /** Preserve an explicit-retry requirement across process restarts. */
    readonly pauseSynchronization: (
      id: string,
      error: CloudReviewError,
    ) => Effect.Effect<void, CloudReviewError>;
    readonly retrySynchronization: Effect.Effect<void, CloudReviewError>;
    readonly assertLocal: Effect.Effect<void, CloudReviewError>;
    readonly start: (
      request: typeof CloudReviewRequest.Type,
    ) => Effect.Effect<CloudReviewStatus, CloudReviewError>;
    readonly refresh: (id: string) => Effect.Effect<CloudReviewStatus, CloudReviewError>;
    readonly importResults: (id: string) => Effect.Effect<CloudReviewStatus, CloudReviewError>;
    readonly cancel: (id: string) => Effect.Effect<CloudReviewStatus, CloudReviewError>;
    /** Ask the background seeder to sync new source files to cloud storage. Never fails. */
    readonly syncCache: Effect.Effect<void>;
  }
>()("app/CloudReviews") {
  /** Local intents live outside portable packages and survive restoring the application database. */
  static layer(config: CloudReviewConfiguration) {
    return Layer.effect(
      CloudReviews,
      Effect.gen(function* () {
        const sandbox = yield* CloudSandbox;
        const serial = yield* Semaphore.make(1);
        const path = join(config.directory, "state.json");
        let jobs = yield* readCloudState(path);
        const latest = jobs.at(-1);

        const changes = yield* SubscriptionRef.make<CloudReviewStatus | null>(
          latest === undefined ? null : publicStatus(latest),
        );

        yield* Effect.addFinalizer(() => PubSub.shutdown(changes.pubsub));

        if (jobs.filter((record) => cloudReviewLocksWorkspace(record.phase)).length > 1)
          return yield* new CloudReviewError({
            reason: "storage",
            message:
              "Multiple cloud owners were recorded. Local work remains blocked until ownership is recovered.",
          });

        // Workspace cache: originals, renders and closed journals stored in Modal by SHA-256.
        // Everything here is best-effort; a cache failure only means more bytes at Send.
        const cachePath = join(config.directory, "cache.json");
        let cacheState = yield* readCloudCacheState(cachePath);

        const cacheVolume =
          config.modal === undefined
            ? undefined
            : cloudCacheVolumeName(config.modal.appName, cacheState.id);

        const cacheWakeups = yield* Queue.sliding<void>(1);
        yield* Effect.addFinalizer(() => Queue.shutdown(cacheWakeups));
        let starting = false;

        // A Send needs the uplink, and pruning must never race a review that reads the cache.
        const cachePaused = () =>
          starting || jobs.some((record) => cloudReviewLocksWorkspace(record.phase));

        const saveCache = (next: CloudCacheState) =>
          Effect.suspend(() => {
            cacheState = next;

            return writeCloudCacheState(cachePath, next);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("cloud_cache_state_unsaved", { reason: error.reason }),
            ),
          );

        // The Volume name derives from this id, so keep it stable across launches.
        if (cacheVolume !== undefined) yield* saveCache(cacheState);

        const seedCache = Effect.gen(function* () {
          if (cacheVolume === undefined) return;

          const now = yield* Clock.currentTimeMillis;
          const pending = cacheState.pending.filter((entry) => entry.expiresAt > now);

          const retained = new Set(
            pending.flatMap((entry) => entry.files.map((file) => file.sha256)),
          );

          const cached = new Map(cacheState.cached.map((file) => [file.sha256, file.bytes]));

          const local =
            config.dataDirectory === undefined || cachePaused()
              ? []
              : yield* listLocalArtifacts(config.dataDirectory);

          const missing = local.filter(
            (file) => cached.get(file.sha256) !== file.bytes && !retained.has(file.sha256),
          );

          const keep = new Set([
            ...local.map((file) => file.sha256),
            ...cacheState.referenced,
            ...retained,
          ]);

          const prune =
            local.length > 0 &&
            !cachePaused() &&
            cacheState.cached.some((file) => !keep.has(file.sha256));

          if (pending.length === 0 && missing.length === 0 && !prune) {
            if (pending.length !== cacheState.pending.length)
              yield* saveCache({ ...cacheState, pending });

            return;
          }

          const listing = yield* sandbox.seedCache({
            volume: cacheVolume,
            snapshots: pending,
            local: missing,
            keep: prune ? [...keep] : null,
            paused: Effect.sync(cachePaused),
          });

          const processed = new Set(pending.map((entry) => entry.imageId));

          yield* saveCache({
            ...cacheState,
            cached: [...listing],
            pending: cacheState.pending.filter(
              (entry) => entry.expiresAt > now && !processed.has(entry.imageId),
            ),
          });
          yield* Effect.logDebug("cloud_cache_seeded", {
            files: listing.length,
            retainedSnapshots: pending.length,
            localCandidates: missing.length,
            pruned: prune,
          });
        });

        const syncCache = Queue.offer(cacheWakeups, undefined).pipe(Effect.asVoid);

        /**
         * Remember a package manifest (sent or returned) and queue its uploaded files for an
         * in-cloud copy from the given directory snapshot, so they never cross the uplink twice.
         */
        const rememberPackage = (
          manifestPath: string,
          snapshotId: string | null,
          root: "input/" | "",
        ) =>
          Effect.gen(function* () {
            if (cacheVolume === undefined) return;

            const text = yield* Effect.tryPromise({
              try: () => readFile(manifestPath, "utf8"),
              catch: () =>
                new CloudReviewError({ reason: "storage", message: "Manifest unavailable." }),
            });

            const { manifest, files } = yield* parseCloudManifest(text);
            const stored = files.filter((file) => file.path !== manifest.database.path);
            const cached = new Map(cacheState.cached.map((file) => [file.sha256, file.bytes]));
            const now = yield* Clock.currentTimeMillis;

            const retain =
              snapshotId === null
                ? []
                : stored
                    .filter((file) => cached.get(file.sha256) !== file.bytes)
                    .map(({ sha256, bytes, path }) => ({ sha256, bytes, path: `${root}${path}` }));

            yield* saveCache({
              ...cacheState,
              referenced: [...new Set(stored.map((file) => file.sha256))],
              pending:
                snapshotId === null || retain.length === 0
                  ? cacheState.pending
                  : [
                      ...cacheState.pending.slice(-15),
                      // Review snapshots are kept for seven days.
                      { imageId: snapshotId, expiresAt: now + 6 * 24 * 60 * 60_000, files: retain },
                    ],
            });
            yield* syncCache;
          }).pipe(Effect.catchCause(() => Effect.logWarning("cloud_cache_package_unrecorded")));

        yield* Stream.fromQueue(cacheWakeups).pipe(
          Stream.runForEach(() =>
            seedCache.pipe(Effect.catchCause(() => Effect.logWarning("cloud_cache_seed_deferred"))),
          ),
          Effect.forkScoped,
        );

        // Seed on launch too, so a workspace opened after imports is ready before the next Send.
        if (cacheVolume !== undefined) yield* syncCache;

        const save = Effect.fn("CloudReviews.save")(function* (record: CloudReviewRecord) {
          const locked = cloudReviewLocksWorkspace(record.phase);

          // Imported findings replace the preview, and terminal receipts must fit the state file.
          const saved = compactCloudReceipt({
            ...record,
            revision: Math.max(0, ...jobs.map((job) => job.revision)) + 1,
            syncFailure: locked ? record.syncFailure : null,
          });

          const next = jobs.some((job) => job.id === record.id)
            ? jobs.map((job) => (job.id === record.id ? saved : job))
            : [...jobs, saved];

          // No external action follows until this receipt is flushed successfully.
          yield* writeCloudState(path, next);
          jobs = next;
          yield* SubscriptionRef.set(changes, publicStatus(saved));

          return publicStatus(saved);
        });

        const load = (id: string) =>
          Effect.suspend(() => {
            const job = jobs.find((record) => record.id === id);

            return job === undefined
              ? Effect.fail(
                  new CloudReviewError({
                    reason: "conflict",
                    message: "This cloud review is not recorded in the current workspace.",
                  }),
                )
              : Effect.succeed(job);
          });

        const assertLocal = Effect.suspend(() =>
          jobs.some((record) => cloudReviewLocksWorkspace(record.phase))
            ? Effect.fail(conflict())
            : Effect.void,
        );

        const refresh = Effect.fn("CloudReviews.refresh")(function* (id: string) {
          const record = yield* load(id);

          if (
            record.phase === "ready" ||
            record.syncFailure !== null ||
            record.phase === "failed" ||
            record.phase === "importing" ||
            !cloudReviewLocksWorkspace(record.phase)
          )
            return publicStatus(record);
          const observed = yield* sandbox.progress(record);
          const progress = observed.progress;

          if (
            progress.id !== record.id ||
            (progress.execution !== null &&
              (progress.execution.projectId !== record.request.projectId ||
                !("findingId" in record.request) ||
                progress.execution.findingId !== record.request.findingId)) ||
            (progress.packet !== undefined &&
              (!("kind" in record.request) ||
                progress.packet.projectId !== record.request.projectId ||
                progress.packet.conversationId !== record.request.conversationId ||
                progress.packet.model !== record.request.model))
          )
            return yield* new CloudReviewError({
              reason: "incompatible",
              message:
                "The cloud service returned a different review. Your local workspace is still protected.",
            });

          const observedStatus =
            progress.packet === undefined
              ? { execution: progress.execution }
              : { execution: progress.execution, packet: progress.packet };

          if (progress.phase === "failed" || (observed.sourceStopped && progress.phase !== "ready"))
            return yield* save({
              ...record,
              phase: "failed",
              ...observedStatus,
              message:
                "The cloud review stopped without a complete result package. Confirm it has stopped to return to local work; prior review calls may have used credits.",
            });

          if (progress.phase === "ready" && observed.resultSnapshotId === null)
            return yield* new CloudReviewError({
              reason: "unavailable",
              message: "The cloud results are still being saved. Sync will continue automatically.",
            });

          return yield* save({
            ...record,
            resultSnapshotId: observed.resultSnapshotId,
            phase: progress.phase === "ready" ? "ready" : "running",
            ...observedStatus,
            message: progress.message,
          });
        });

        return CloudReviews.of({
          setup: Effect.gen(function* () {
            const configured = config.modal !== undefined && config.provider !== undefined;

            const checked = configured
              ? yield* sandbox
                  .preflight(
                    config.providers ?? (config.provider === undefined ? [] : [config.provider]),
                  )
                  .pipe(
                    Effect.as(null),
                    Effect.catch((error) => Effect.succeed(error.message)),
                  )
              : "Set up the cloud and model connections before pushing a review.";

            yield* syncCache;

            const estimate =
              config.estimate === undefined
                ? {}
                : yield* config.estimate.pipe(
                    Effect.flatMap((workspaceEstimate) =>
                      config.dataDirectory === undefined || cacheVolume === undefined
                        ? Effect.succeed(workspaceEstimate)
                        : Effect.map(listLocalArtifacts(config.dataDirectory), (local) => {
                            const cached = new Map(
                              cacheState.cached.map((file) => [file.sha256, file.bytes]),
                            );

                            const synced = local.filter(
                              (file) => cached.get(file.sha256) === file.bytes,
                            );

                            return {
                              ...workspaceEstimate,
                              syncedBytes: Math.min(
                                workspaceEstimate.bytes,
                                synced.reduce((total, file) => total + file.bytes, 0),
                              ),
                              syncedFiles: synced.length,
                            };
                          }),
                    ),
                    Effect.map((workspaceEstimate) => ({ workspaceEstimate })),
                    Effect.catch((error) =>
                      Effect.succeed({ workspaceEstimateError: error.message }),
                    ),
                  );

            return new CloudReviewSetup({
              configured: configured && checked === null,
              message: checked,
              timeoutMinutes: config.modal?.timeoutMinutes ?? 15,
              warmPool: config.modal?.poolQueue !== undefined && config.modal.poolQueue !== null,
              transferScope: "whole-application",
              ...estimate,
            });
          }),
          status: Effect.sync(() => {
            const job = jobs.at(-1);

            return job === undefined ? null : publicStatus(job);
          }),
          observe: SubscriptionRef.changes(changes),
          watch: (id) => Stream.unwrap(Effect.map(load(id), (record) => sandbox.changes(record))),
          pauseSynchronization: (id, error) =>
            Effect.gen(function* () {
              const record = yield* load(id);

              if (cloudReviewLocksWorkspace(record.phase))
                yield* save({ ...record, syncFailure: error });
            }).pipe(Semaphore.withPermit(serial), Effect.uninterruptible),
          retrySynchronization: Effect.gen(function* () {
            const record = jobs.at(-1);

            if (record !== undefined && record.syncFailure !== null)
              yield* save({ ...record, syncFailure: null });
          }).pipe(Semaphore.withPermit(serial), Effect.uninterruptible),
          assertLocal,
          start: (request) =>
            Effect.gen(function* () {
              starting = true;
              const fingerprint = cloudRequestFingerprint(request);

              const previous = jobs.find(
                (record) => record.request.commandId === request.commandId,
              );

              if (previous !== undefined) {
                if (previous.fingerprint !== fingerprint) return yield* conflict();

                return publicStatus(previous);
              }

              yield* assertLocal;

              if (config.modal === undefined || config.provider === undefined)
                return yield* new CloudReviewError({
                  reason: "configuration",
                  message: "Set up the cloud and model connections before pushing a review.",
                });

              // The deadline starts before allocation and upload, and dispatch needs a full worker
              // minute afterwards, so a limit of exactly that minute can never dispatch.
              if (config.modal.timeoutMinutes * 60_000 <= cloudWorkerMinimumTimeoutMs)
                return yield* new CloudReviewError({
                  reason: "configuration",
                  message:
                    "A 1-minute cloud time limit cannot start a review: setup and upload use part of it, and the cloud worker needs a full minute after them. Set the limit to 2 minutes or more. Your workspace has not been uploaded.",
                });

              const model = reviewModels.find((item) => item.id === request.model);

              const provider =
                request.model === undefined
                  ? config.provider
                  : (config.providers ?? [config.provider]).find(
                      (item) => item.provider === model?.provider,
                    );

              if (provider === undefined)
                return yield* new CloudReviewError({
                  reason: "configuration",
                  message: "Connect the selected model before pushing this review.",
                });

              const alternatives = (config.providers ?? []).filter(
                (item) => item.provider !== provider.provider,
              );

              // Dispatch admits only canonical routes; check them before any paid allocation.
              if (
                [provider, ...alternatives].some(
                  (item) => item.baseUrl !== cloudProviderEndpoints[item.provider],
                )
              )
                return yield* new CloudReviewError({
                  reason: "configuration",
                  message:
                    "Cloud reviews require canonical provider endpoints. Import the provider credentials again. Your workspace has not been uploaded.",
                });

              if (jobs.length >= 1000)
                return yield* new CloudReviewError({
                  reason: "limit",
                  message: "The cloud review receipt limit has been reached.",
                });

              // The new owner's receipt and its progress must fit before any cloud action.
              if (
                cloudStateBytes(jobs) +
                  Buffer.byteLength(JSON.stringify(request)) +
                  cloudReceiptReserveBytes >
                cloudStateMaxBytes
              )
                return yield* new CloudReviewError({
                  reason: "limit",
                  message:
                    "Cloud review records have no room for another review. Your workspace has not been uploaded.",
                });
              yield* sandbox.preflight(config.providers ?? [provider]);
              const versions = yield* config.inspect(request);
              const id = randomUUID();
              const input = join(config.directory, id, "input");
              yield* createCloudDirectory(join(config.directory, id));
              const prepared = yield* config.prepare(input);
              const now = yield* Clock.currentTimeMillis;

              let record: CloudReviewRecord = {
                id,
                workerProtocol: cloudEngineIdentity.protocol,
                revision: 0,
                syncFailure: null,
                request,
                fingerprint,
                phase: "preparing",
                createdAt: now,
                expiresAt: now + config.modal.timeoutMinutes * 60_000,
                sandboxId: null,
                inputSnapshotId: null,
                resultSnapshotId: null,
                sandboxName: `moke-review-${id}`,
                appName: config.modal.appName,
                environment: config.modal.environment,
                ...versions,
                execution: null,
                message: "Preparing your cloud review. Local editing is paused.",
              };

              if (prepared !== undefined) record = { ...record, transferBytes: prepared.bytes };

              if (cacheVolume !== undefined) record = { ...record, cacheVolume };

              yield* save(record);
              const sandboxId = yield* sandbox.allocate(record);
              record = { ...record, sandboxId };
              yield* save(record);

              const inputSnapshotId = yield* sandbox.upload(record, input, (transfer) =>
                Effect.gen(function* () {
                  record = {
                    ...record,
                    transfer,
                    message:
                      transfer.completedFiles === transfer.totalFiles
                        ? "Workspace files uploaded. Preparing cloud execution."
                        : "Uploading workspace files to the cloud.",
                  };
                  yield* save(record);
                }),
              );

              record = {
                ...record,
                inputSnapshotId,
                phase: "dispatching",
                message:
                  "Sending your review to the cloud. Progress and results will sync automatically.",
              };
              yield* save(record);
              yield* sandbox.dispatch(record, provider, alternatives);
              yield* rememberPackage(join(input, "manifest.json"), inputSnapshotId, "input/");

              return publicStatus(yield* load(id));
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  starting = false;
                }),
              ),
              Semaphore.withPermit(serial),
              Effect.uninterruptible,
            ),
          refresh: (id) => refresh(id).pipe(Semaphore.withPermit(serial)),
          importResults: (id) =>
            Effect.gen(function* () {
              let record = yield* load(id);

              if (record.phase === "imported") return publicStatus(record);

              if (record.syncFailure !== null) return yield* record.syncFailure;

              if (record.phase !== "ready" && record.phase !== "importing")
                return yield* new CloudReviewError({
                  reason: "conflict",
                  message: "Wait for the cloud review to finish before importing its results.",
                });
              const output = join(config.directory, id, "output");

              if (record.phase === "ready") {
                const current = yield* config.inspect(record.request);

                if (
                  current.sourceVersion !== record.sourceVersion ||
                  current.factVersion !== record.factVersion ||
                  current.projectVersion !== record.projectVersion
                )
                  return yield* new CloudReviewError({
                    reason: "conflict",
                    message:
                      "Local evidence changed after this transfer. Cloud results cannot replace the current workspace.",
                  });
                yield* sandbox.download(
                  record,
                  output,
                  (transfer) =>
                    Effect.gen(function* () {
                      record = {
                        ...record,
                        transfer,
                        message:
                          transfer.completedFiles === transfer.totalFiles
                            ? "Result files downloaded and verified. Preparing workspace import."
                            : "Downloading cloud result files.",
                      };
                      yield* save(record);
                    }),
                  config.dataDirectory === undefined
                    ? undefined
                    : reuseLocalArtifact(config.dataDirectory),
                );
                // A lost connection is never proof that the other owner has stopped.
                yield* sandbox.stop(record);
                record = {
                  ...record,
                  phase: "importing",
                  message:
                    "Syncing the cloud results. Local editing remains paused until verification finishes.",
                };
                yield* save(record);
              }

              // An interrupted import can safely restore this same package again while the fence is held.
              yield* config.restore(output).pipe(
                Effect.tapError(() =>
                  config.restorePending()
                    ? Effect.void
                    : save({
                        ...record,
                        phase: "ready",
                        message:
                          "The results could not sync. Your local workspace is unchanged. Retry sync, or stop this cloud review to return to local work.",
                      }),
                ),
              );

              const imported = yield* save({
                ...record,
                phase: "imported",
                message:
                  "Cloud results synced. Local editing is available; proposed evidence still needs your review.",
              });

              // New crops rendered in the cloud are copied into the cache from the result snapshot.
              yield* rememberPackage(join(output, "manifest.json"), record.resultSnapshotId, "");

              return imported;
            }).pipe(Semaphore.withPermit(serial), Effect.uninterruptible),
          cancel: (id) =>
            Effect.gen(function* () {
              const record = yield* load(id);

              if (!cloudReviewLocksWorkspace(record.phase)) return publicStatus(record);

              if (record.phase === "importing" && config.restorePending())
                return yield* new CloudReviewError({
                  reason: "conflict",
                  message:
                    "Reopen the app to recover the interrupted import before returning to local work.",
                });
              yield* sandbox.stop(record);

              return yield* save({
                ...record,
                phase: "cancelled",
                message:
                  "Cloud execution is confirmed stopped. Local editing is available. Model calls may already have been charged.",
              });
            }).pipe(Semaphore.withPermit(serial), Effect.uninterruptible),
          syncCache,
        });
      }),
    );
  }
}

/** Disabled configuration keeps local review fully functional and reports explicit cloud failures. */
export const unavailableCloudSandbox = Layer.succeed(
  CloudSandbox,
  CloudSandbox.of({
    preflight: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "The cloud connection needs setup.",
        }),
      ),
    changes: () =>
      Stream.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "Restore the cloud connection to reconnect to the review.",
        }),
      ),
    allocate: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "The cloud connection needs setup.",
        }),
      ),
    upload: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "The cloud connection needs setup.",
        }),
      ),
    dispatch: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "The cloud connection needs setup.",
        }),
      ),
    progress: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "Restore the cloud connection to reconnect to the existing review.",
        }),
      ),
    download: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "Restore the cloud connection, then choose Retry sync.",
        }),
      ),
    stop: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "Restore the cloud connection to confirm this review has stopped.",
        }),
      ),
    seedCache: () =>
      Effect.fail(
        new CloudReviewError({
          reason: "configuration",
          message: "The cloud connection needs setup.",
        }),
      ),
  }),
);
