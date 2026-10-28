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
import { ReviewExecution } from "./review/execution.ts";
import { ReviewError, ReviewConflict, ReviewStorageError } from "#lib/review/contracts.ts";

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
} from "#lib/review/packages.ts";
import { ExecutionError } from "#lib/review/execution.ts";

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
    readonly exportPackage: (
      destination: string,
    ) => Effect.Effect<PackageExportResult, PackageError>;
    readonly restorePackage: (source: string) => Effect.Effect<PackageRestoreResult, PackageError>;
  }
>()("app/Application") {
  /** Migrate before serving and serialize recovery with scoped per-operation SQL connections. */
  static layer(config: BackendConfig, entry: ApplicationEntry) {
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

        let port = review.port;

        if (inference?.provider === "meta") {
          const segmentation = yield* ReviewSegmentation.pipe(
            Effect.provide(
              yield* Layer.build(
                ReviewSegmentation.layer({
                  dataDirectory: owner.canonicalDirectory,
                  queries: operations,
                  owner,
                  apiKey: inference.apiKey,
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

        const quiesce = Effect.gen(function* () {
          maintaining = true;
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

        const publicReview = {
          ...review,
          snapshot: (...args: Parameters<typeof review.snapshot>) =>
            admit(review.snapshot(...args)),
          command: (...args: Parameters<typeof review.command>) => admit(review.command(...args)),
          importPdf: (...args: Parameters<typeof review.importPdf>) =>
            admit(review.importPdf(...args)),
          render: (...args: Parameters<typeof review.render>) => admit(review.render(...args)),
          chunk: (...args: Parameters<typeof review.chunk>) => admit(review.chunk(...args)),
        };

        const executePublic = <A>(operation: Effect.Effect<A, ExecutionError>) =>
          admit(operation).pipe(
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
          exportPackage: (destination) =>
            Effect.suspend(() =>
              pendingRestore()
                ? Effect.fail(new PackageError({ reason: "interrupted", message: restoreMessage }))
                : exportReviewPackage(packages, destination),
            ).pipe(Effect.ensuring(finishMaintenance), Semaphore.withPermit(maintenance)),
          restorePackage: (source) =>
            Effect.suspend(() =>
              pendingRestore()
                ? Effect.fail(new PackageError({ reason: "interrupted", message: restoreMessage }))
                : restoreReviewPackage(packages, source),
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
      StartExecution: (request) => application.execution.start(request),
      ExecutionStatus: ({ projectId, runId }) => application.execution.status(projectId, runId),
      ControlExecution: ({ projectId, runId, expectedVersion, action, commandId }) =>
        application.execution.control(projectId, runId, expectedVersion, action, commandId),
      AcknowledgeUncertainExecution: ({ projectId, runId, expectedVersion, commandId }) =>
        application.execution.acknowledge(projectId, runId, expectedVersion, commandId),
      ExecutionEvents: ({ projectId, afterSequence }) =>
        application.execution.events(projectId, afterSequence),
      ObserveExecution: ({ projectId, afterSequence }) =>
        application.execution.observe(projectId, afterSequence),
    };
  }),
);
