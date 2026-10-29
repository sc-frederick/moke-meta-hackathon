import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { BackendConfig, BackendRpc, DatabaseFileError } from "../src/lib/backend-rpc.ts";
import { exportDatabase, migrateDatabase, restoreDatabase } from "./database-files.ts";
import { SqlClient } from "effect/sql";
import { ReviewSegmentation } from "./inference/segmentation.ts";
import { Documents } from "./documents/documents.ts";
import { acquireDataDirectoryOwnership } from "./ownership.ts";
import { ReviewStore } from "./review/store.ts";
import { createReviewOperations } from "./review/operations.ts";
import { PacketReviews } from "./packet-review/service.ts";
import { ReviewExecution } from "./review/execution.ts";
import {
  ProjectId,
  ReviewError,
  ReviewConflict,
  ReviewStorageError,
} from "#lib/review/contracts.ts";

import {
  exportReviewPackage,
  restoreReviewPackage,
  recoverInterruptedRestore,
  hasReviewBearingRows,
} from "./review/packages.ts";
import {
  PackageError,
  type PackageExportResult,
  type PackageRestoreResult,
  type PackageLimits,
} from "#lib/review/packages.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { CloudReviews, CloudSandbox, unavailableCloudSandbox } from "./cloud/service.ts";
import { modalSandboxLayer } from "./cloud/modal.ts";
import { executionPersistence } from "./review/execution-store.ts";
import { cloudPackageLimits } from "./cloud/transfer.ts";
import { CloudReviewSynchronization } from "./cloud/sync.ts";

/** The single managed application runtime is also the entrypoint for Pi callbacks. */
export interface ApplicationEntry {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
}

/** Application operations; the Bun process exclusively owns database connections and recovery. */
export class Application extends Context.Service<
  Application,
  {
    readonly export: (destination: string) => Effect.Effect<string, DatabaseFileError>;
    readonly restore: (source: string) => Effect.Effect<void, DatabaseFileError>;
    readonly review: ReturnType<typeof createReviewOperations>;
    readonly execution: ReviewExecution["Service"];
    readonly packets: PacketReviews["Service"];
    readonly cloud: CloudReviews["Service"];
    readonly cloudSync: CloudReviewSynchronization["Service"];
    readonly exportPackage: (
      destination: string,
      limits?: typeof PackageLimits.Type,
    ) => Effect.Effect<PackageExportResult, PackageError>;
    readonly restorePackage: (source: string) => Effect.Effect<PackageRestoreResult, PackageError>;
  }
>()("app/Application") {
  /** Migrate before serving and serialize recovery with scoped per-operation SQL connections. */
  static layer(
    config: BackendConfig,
    entry: ApplicationEntry,
    cloudSandbox?: Layer.Layer<CloudSandbox>,
  ) {
    return Layer.effect(
      Application,
      Effect.gen(function* () {
        const owner = yield* acquireDataDirectoryOwnership(config.dataDirectory);
        yield* recoverInterruptedRestore(owner.canonicalDirectory);
        const filename = join(owner.canonicalDirectory, "app.sqlite");
        const backups = join(config.dataDirectory, "backups");
        yield* Effect.scoped(migrateDatabase(filename, config.migrationDirectory, backups));
        const operations = yield* Semaphore.make(1);
        const maintenance = yield* Semaphore.make(1);
        const workSlots = yield* Semaphore.make(16);
        let maintaining = false;

        const pendingRestore = () => {
          try {
            lstatSync(join(owner.canonicalDirectory, ".package-restore", "journal.json"));

            return true;
          } catch (cause) {
            return !Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause);
          }
        };

        const restoreMessage =
          "A restore requires recovery. Reopen the application before continuing; pending data must not be edited.";

        const admit = <A, E>(operation: Effect.Effect<A, E>) =>
          Effect.suspend((): Effect.Effect<A, E | ReviewConflict> =>
            maintaining || pendingRestore()
              ? Effect.fail(
                  new ReviewConflict({
                    message: pendingRestore()
                      ? restoreMessage
                      : "Review maintenance is in progress. Wait for it to finish.",
                  }),
                )
              : operation,
          ).pipe(Semaphore.withPermit(workSlots));

        const database = SqliteClient.layer({ filename });

        const reviewQuery = <A>(
          operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`PRAGMA foreign_keys=ON`;
              yield* sql`PRAGMA synchronous=FULL`;
              yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ foreign_keys: Schema.Literal(1) })),
              )(yield* sql`PRAGMA foreign_keys`);
              yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ synchronous: Schema.Literal(2) })),
              )(yield* sql`PRAGMA synchronous`);

              return yield* operation.pipe(Effect.provide(ReviewStore.layer));
            }).pipe(Effect.provide(database)),
          ).pipe(
            Effect.mapError((error) =>
              Schema.is(ReviewError)(error)
                ? error
                : new ReviewStorageError({ message: "The review database operation failed." }),
            ),
            Semaphore.withPermit(operations),
            Effect.uninterruptible,
          );

        const processing = config.processing;

        const documents =
          processing === undefined
            ? undefined
            : yield* Documents.pipe(
                Effect.provide(
                  yield* Layer.build(
                    Documents.layer({ ...processing, dataDirectory: owner.canonicalDirectory }),
                  ),
                ),
              );

        const review = createReviewOperations({ query: reviewQuery, documents, owner });
        const inference = config.inference;

        const providers = [
          ...(inference === undefined ? [] : [inference]),
          ...(config.inferenceAlternatives ?? []),
        ];

        const meta = providers.find((provider) => provider.provider === "meta");

        let port = review.port;

        if (meta !== undefined) {
          const segmentation = yield* ReviewSegmentation.pipe(
            Effect.provide(
              yield* Layer.build(
                ReviewSegmentation.layer({
                  dataDirectory: owner.canonicalDirectory,
                  queries: operations,
                  owner,
                  apiKey: meta.apiKey,
                  loadArtifact: review.artifact,
                  readImage: review.port.readImage,
                }),
              ),
            ),
          );

          port = { ...port, segmentation: { segment: segmentation.segment } };
        }

        const executionOptions = { owner, queries: operations, port, runPromise: entry.runPromise };

        const executionLayer = ReviewExecution.layer(
          inference === undefined
            ? executionOptions
            : {
                ...executionOptions,
                providers: providers.map((provider) => ({ ...provider, route: "live" as const })),
                provider: {
                  provider: inference.provider,
                  apiKey: inference.apiKey,
                  baseUrl: inference.baseUrl,
                  model: inference.model,
                  route: "live",
                },
              },
        );

        const execution = yield* ReviewExecution.pipe(
          Effect.provide(yield* Layer.build(executionLayer)),
        );

        const packets = yield* PacketReviews.pipe(
          Effect.provide(
            yield* Layer.build(
              PacketReviews.layer({
                owner,
                queries: operations,
                review,
                providers: providers.map((provider) => ({ ...provider, route: "live" as const })),
                runPromise: entry.runPromise,
              }),
            ),
          ),
        );

        const quiesce = Effect.gen(function* () {
          maintaining = true;
          yield* packets.quiesce.pipe(
            Effect.mapError(
              () =>
                new PackageError({
                  reason: "conflict",
                  message: "Packet reviews must close safely before maintenance.",
                }),
            ),
          );
          yield* execution.quiesce.pipe(
            Effect.mapError(
              () =>
                new PackageError({
                  reason: "conflict",
                  message:
                    "Review execution did not close safely. Reopen the application before maintenance.",
                }),
            ),
          );
          // Lock order: admission -> drain tools/jobs -> SQL exclusion. Never hold SQL while draining.
          yield* Effect.void.pipe(Semaphore.withPermits(workSlots, 16));
        });

        const packages = {
          dataDirectory: owner.canonicalDirectory,
          migrationDirectory: config.migrationDirectory,
          queries: operations,
          quiesce,
          ownerGeneration: owner.generation,
        };

        const finishMaintenance = Effect.sync(() => {
          maintaining = false;
        });

        const cloudFailure = (message: string) =>
          Effect.mapError(() => new CloudReviewError({ reason: "conflict", message }));

        const cloudOptions = {
          directory: `${owner.canonicalDirectory}.cloud`,
          inspect: (request: Parameters<CloudReviews["Service"]["start"]>[0]) =>
            Effect.gen(function* () {
              if (!("kind" in request))
                yield* review.port
                  .inspect(request)
                  .pipe(
                    cloudFailure("The selected review or its saved instructions are unavailable."),
                  );

              const state = yield* review
                .snapshot(request.projectId, 0)
                .pipe(cloudFailure("The selected project could not be read."));

              if (state.project === null)
                return yield* new CloudReviewError({
                  reason: "conflict",
                  message: "Select an existing review project first.",
                });
              const project = state.project;

              if (
                "kind" in request &&
                (state.sheets.length === 0 ||
                  !state.messages.some(
                    (message) =>
                      message.id === request.messageId &&
                      message.conversationId === request.conversationId &&
                      message.role === "reviewer",
                  ))
              )
                return yield* new CloudReviewError({
                  reason: "conflict",
                  message:
                    "Import the drawing set and save its review request before pushing to cloud.",
                });

              return {
                sourceVersion: project.sourceVersion,
                factVersion: project.factVersion,
                projectVersion: project.version,
              };
            }),
          prepare: (destination: string) =>
            Effect.gen(function* () {
              const persistence = executionPersistence(filename, operations);

              const blocked = yield* persistence
                .query(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;

                    const countBlocked =
                      (yield* sql`SELECT run_id FROM review_execution_runs r WHERE r.state IN ('running','pausing','paused','uncertain') OR ((EXISTS(SELECT 1 FROM review_execution_attempts a WHERE a.run_id=r.run_id AND a.status='uncertain') OR EXISTS(SELECT 1 FROM review_sam_attempts s WHERE s.run_id=r.run_id AND s.status='uncertain')) AND NOT EXISTS(SELECT 1 FROM review_execution_acknowledgements k WHERE k.run_id=r.run_id)) LIMIT 1`)
                        .length > 0;

                    const packetBlocked =
                      (yield* sql`SELECT id FROM packet_reviews WHERE json_extract(payload,'$.state') IN ('running','paused','uncertain') LIMIT 1`)
                        .length > 0;

                    return countBlocked || packetBlocked;
                  }),
                )
                .pipe(cloudFailure("Review execution could not be checked before transfer."));

              if (blocked)
                return yield* new CloudReviewError({
                  reason: "conflict",
                  message:
                    "Finish or cancel existing local inspections and acknowledge any unresolved charges before starting a separate cloud review.",
                });
              yield* exportReviewPackage(
                { ...packages, limits: cloudPackageLimits },
                destination,
              ).pipe(
                cloudFailure(
                  "The complete workspace could not be prepared for cloud review. Cloud transfers are limited to 256 MiB.",
                ),
              );
            }),
          restore: (source: string) =>
            restoreReviewPackage({ ...packages, limits: cloudPackageLimits }, source).pipe(
              Effect.asVoid,
              Effect.mapError(
                (error) =>
                  new CloudReviewError({
                    reason: error.reason === "limit" ? "limit" : "incompatible",
                    message: error.message,
                  }),
              ),
            ),
          restorePending: pendingRestore,
        };

        const withProvider =
          inference === undefined
            ? cloudOptions
            : { ...cloudOptions, provider: inference, providers };

        const cloud = yield* CloudReviews.pipe(
          Effect.provide(
            yield* Layer.build(
              CloudReviews.layer(
                config.modal === undefined
                  ? withProvider
                  : { ...withProvider, modal: config.modal },
              ).pipe(
                Layer.provide(
                  cloudSandbox ??
                    (config.modal === undefined
                      ? unavailableCloudSandbox
                      : modalSandboxLayer(config.modal, inference?.apiKey)),
                ),
              ),
            ),
          ),
        );

        const locally = <A, E>(operation: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            yield* cloud.assertLocal.pipe(
              Effect.mapError((error) => new ReviewConflict({ message: error.message })),
            );

            return yield* operation;
          });

        const cloudMaintenance = <A>(operation: Effect.Effect<A, CloudReviewError>) =>
          Effect.gen(function* () {
            if (pendingRestore())
              return yield* new CloudReviewError({ reason: "conflict", message: restoreMessage });
            maintaining = true;
            yield* Effect.void.pipe(Semaphore.withPermits(workSlots, 16));

            return yield* operation;
          }).pipe(Effect.ensuring(finishMaintenance), Semaphore.withPermit(maintenance));

        const cloudSync = yield* CloudReviewSynchronization.pipe(
          Effect.provide(
            yield* Layer.build(
              CloudReviewSynchronization.layer((id) =>
                cloudMaintenance(cloud.importResults(id)),
              ).pipe(Layer.provide(Layer.succeed(CloudReviews, cloud))),
            ),
          ),
        );

        const publicReview = {
          ...review,
          snapshot: (...args: Parameters<typeof review.snapshot>) =>
            admit(review.snapshot(...args)),
          command: (...args: Parameters<typeof review.command>) =>
            admit(locally(review.command(...args))),
          importPdf: (...args: Parameters<typeof review.importPdf>) =>
            admit(locally(review.importPdf(...args))),
          render: (...args: Parameters<typeof review.render>) =>
            admit(locally(review.render(...args))),
          chunk: (...args: Parameters<typeof review.chunk>) => admit(review.chunk(...args)),
        };

        const executePublic = <A>(operation: Effect.Effect<A, ExecutionError>) =>
          admit(locally(operation)).pipe(
            Effect.mapError((cause) =>
              cause instanceof ExecutionError
                ? cause
                : new ExecutionError({ reason: "conflict", message: cause.message }),
            ),
          );

        const publicExecution = ReviewExecution.of({
          ...execution,
          start: (request) => executePublic(execution.start(request)),
          control: (...args) => executePublic(execution.control(...args)),
          acknowledge: (...args) => executePublic(execution.acknowledge(...args)),
        });

        return Application.of({
          review: publicReview,
          execution: publicExecution,
          packets: {
            ...packets,
            start: (request) => executePublic(packets.start(request)),
            control: (request) => executePublic(packets.control(request)),
            complete: (request) => executePublic(packets.complete(request)),
          },
          cloudSync,
          cloud: CloudReviews.of({
            ...cloud,
            start: (request) => cloudMaintenance(cloud.start(request)),
            importResults: (id) => cloudMaintenance(cloud.importResults(id)),
          }),
          exportPackage: (destination, limits) =>
            Effect.suspend(() =>
              pendingRestore()
                ? Effect.fail(new PackageError({ reason: "interrupted", message: restoreMessage }))
                : exportReviewPackage(
                    limits === undefined ? packages : { ...packages, limits },
                    destination,
                  ),
            ).pipe(Effect.ensuring(finishMaintenance), Semaphore.withPermit(maintenance)),
          restorePackage: (source) =>
            Effect.suspend(() =>
              pendingRestore()
                ? Effect.fail(new PackageError({ reason: "interrupted", message: restoreMessage }))
                : cloud.assertLocal.pipe(
                    Effect.mapError(
                      (error) => new PackageError({ reason: "conflict", message: error.message }),
                    ),
                    Effect.andThen(restoreReviewPackage(packages, source)),
                  ),
            ).pipe(Effect.ensuring(finishMaintenance), Semaphore.withPermit(maintenance)),
          export: (destination) =>
            Effect.suspend(() =>
              maintaining || pendingRestore()
                ? Effect.fail(new DatabaseFileError({ message: restoreMessage }))
                : Effect.scoped(exportDatabase(filename, destination)),
            ).pipe(Semaphore.withPermit(operations)),
          restore: (source) =>
            Effect.scoped(
              Effect.gen(function* () {
                if (maintaining || pendingRestore())
                  return yield* new DatabaseFileError({ message: restoreMessage });
                yield* cloud.assertLocal.pipe(
                  Effect.mapError((error) => new DatabaseFileError({ message: error.message })),
                );
                const currentReviews = yield* hasReviewBearingRows(filename);
                const incomingReviews = yield* hasReviewBearingRows(source);

                if (currentReviews || incomingReviews)
                  return yield* new DatabaseFileError({
                    message:
                      "Review data requires its complete project package, including originals and execution journals. Database-only restore is unavailable.",
                  });
                yield* restoreDatabase(filename, source, config.migrationDirectory, backups);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new DatabaseFileError({
                    message:
                      "Use a complete review package to restore review data. Existing data was preserved.",
                  }),
              ),
              Semaphore.withPermit(operations),
              Effect.uninterruptible,
            ),
        });
      }),
    );
  }
}

/** Bind every backend RPC to its application-owned operation. */
export const BackendHandlers = BackendRpc.toLayer(
  Effect.gen(function* () {
    const application = yield* Application;

    return {
      ExportPacketReport: ({ projectId, reviewId, destination }) =>
        application.packets
          .exportReport(Schema.decodeUnknownSync(ProjectId)(projectId), reviewId, destination)
          .pipe(
            Effect.mapError(
              () => new DatabaseFileError({ message: "The review report could not be exported." }),
            ),
          ),
      StartPacketReview: (request) => application.packets.start(request),
      ListPacketReviews: ({ projectId }) => application.packets.list(projectId),
      GetPacketReview: ({ projectId, reviewId }) => application.packets.get(projectId, reviewId),
      ObservePacketReviews: ({ projectId }) => application.packets.observe(projectId),
      ControlPacketReview: (request) => application.packets.control(request),
      CompletePacketFinding: (request) => application.packets.complete(request),
      ExportDatabase: ({ destination }) => application.export(destination),
      RestoreDatabase: ({ source }) => application.restore(source),
      ReviewSnapshot: ({ projectId, afterSequence }) =>
        application.review.snapshot(projectId, afterSequence),
      ReviewCommand: ({ command }) => application.review.command(command),
      RenderSource: (request) => application.review.render(request),
      ReadArtifactChunk: (request) => application.review.chunk(request),
      ImportReviewPdf: (request) => application.review.importPdf(request),
      ExportReviewPackage: ({ destination }) => application.exportPackage(destination),
      RestoreReviewPackage: ({ source }) => application.restorePackage(source),
      ExecutionSetup: () => application.execution.setup,
      CloudReviewSetup: () => application.cloud.setup,
      StartCloudReview: (request) => application.cloud.start(request),
      StartCloudPacketReview: (request) => application.cloud.start(request),
      CloudReviewStatus: () => application.cloud.status,
      ObserveCloudReview: () => application.cloudSync.observe,
      RetryCloudReviewSync: () => application.cloudSync.retry,
      RefreshCloudReview: ({ id }) => application.cloud.refresh(id),
      ImportCloudReview: ({ id }) => application.cloud.importResults(id),
      CancelCloudReview: ({ id }) => application.cloud.cancel(id),
      StartExecution: (request) => application.execution.start(request),
      ExecutionStatus: ({ projectId, runId }) => application.execution.status(projectId, runId),
      ControlExecution: ({ projectId, runId, expectedVersion, action, commandId }) =>
        application.execution.control(projectId, runId, expectedVersion, action, commandId),
      AcknowledgeUncertainExecution: ({ projectId, runId, expectedVersion, commandId }) =>
        application.execution.acknowledge(projectId, runId, expectedVersion, commandId),
      ObserveExecution: ({ projectId, afterSequence }) =>
        application.execution.observe(projectId, afterSequence),
    };
  }),
);
