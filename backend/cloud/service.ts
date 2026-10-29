import { Clock, Context, Effect, Layer, PubSub, Semaphore, Stream, SubscriptionRef } from "effect";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudReviewError,
  CloudReviewSetup,
  CloudReviewStatus,
  cloudReviewLocksWorkspace,
  type CloudReviewRequest,
} from "#lib/review/cloud.ts";
import { reviewModels } from "#lib/review/models.ts";
import { cloudEngineIdentity, type CloudReviewRecord } from "./contracts.ts";
import { createCloudDirectory, readCloudState, writeCloudState } from "./files.ts";
import type { CloudSandboxPort } from "./sandbox-port.ts";

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
  readonly restore: (source: string) => Effect.Effect<void, CloudReviewError>;
  readonly restorePending: () => boolean;
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

  return new CloudReviewStatus(
    record.packet === undefined ? transfer : { ...transfer, packet: record.packet },
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

        const save = Effect.fn("CloudReviews.save")(function* (record: CloudReviewRecord) {
          const saved = {
            ...record,
            revision: Math.max(0, ...jobs.map((job) => job.revision)) + 1,
            syncFailure: cloudReviewLocksWorkspace(record.phase) ? record.syncFailure : null,
          };

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

            return new CloudReviewSetup({
              configured: configured && checked === null,
              message: checked,
              timeoutMinutes: config.modal?.timeoutMinutes ?? 15,
              warmPool: config.modal?.poolQueue !== undefined && config.modal.poolQueue !== null,
              transferScope: "whole-application",
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
              const fingerprint = JSON.stringify(request);

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

              if (jobs.length >= 1000)
                return yield* new CloudReviewError({
                  reason: "limit",
                  message: "The cloud review receipt limit has been reached.",
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

              yield* save(record);
              const sandboxId = yield* sandbox.allocate(record);
              record = { ...record, sandboxId };
              yield* save(record);
              const inputSnapshotId = yield* sandbox.upload(record, input);
              record = {
                ...record,
                inputSnapshotId,
                phase: "dispatching",
                message:
                  "Sending your review to the cloud. Progress and results will sync automatically.",
              };
              yield* save(record);
              yield* sandbox.dispatch(
                record,
                provider,
                (config.providers ?? []).filter((item) => item.provider !== provider.provider),
              );

              return publicStatus(yield* load(id));
            }).pipe(Semaphore.withPermit(serial), Effect.uninterruptible),
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
                yield* sandbox.download(record, output);
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

              return yield* save({
                ...record,
                phase: "imported",
                message:
                  "Cloud results synced. Local editing is available; proposed evidence still needs your review.",
              });
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
  }),
);
