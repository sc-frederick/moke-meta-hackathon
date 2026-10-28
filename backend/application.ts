import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { join } from "node:path";
import { BackendConfig, BackendRpc, DatabaseFileError } from "../src/lib/backend-rpc.ts";
import { Note, StorageError } from "../src/lib/notes.ts";
import { exportDatabase, migrateDatabase, restoreDatabase } from "./database-files.ts";
import { NotesStore } from "./notes-store.ts";
import { SqlClient } from "effect/sql";
import { Documents } from "./documents/documents.ts";
import { acquireDataDirectoryOwnership } from "./ownership.ts";
import { ReviewStore } from "./review/store.ts";
import { createReviewOperations } from "./review/operations.ts";
import { ReviewExecution } from "./review/execution.ts";
import { ReviewError, ReviewStorageError } from "#lib/review/contracts.ts";

/** The single managed application runtime is also the entrypoint for Pi callbacks. */
export interface ApplicationEntry {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

const hasReviews = (filename: string) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='review_projects'`;

  if (tables.length === 0) return false;
  const rows = yield* sql`SELECT id FROM review_projects LIMIT 1`;

  return rows.length > 0;
}).pipe(Effect.provide(SqliteClient.layer({ filename, readonly: true }))));

/** Application operations; the Bun process exclusively owns database connections and recovery. */
export class Application extends Context.Service<
  Application,
  {
    readonly list: Effect.Effect<ReadonlyArray<Note>, StorageError>;
    readonly add: (text: string) => Effect.Effect<Note, StorageError>;
    readonly export: (destination: string) => Effect.Effect<string, DatabaseFileError>;
    readonly restore: (source: string) => Effect.Effect<void, DatabaseFileError>;
    readonly review: ReturnType<typeof createReviewOperations>;
    readonly execution: ReviewExecution["Service"];
  }
>()("app/Application") {
  /** Migrate before serving and serialize recovery with scoped per-operation SQL connections. */
  static layer(config: BackendConfig, entry: ApplicationEntry) {
    return Layer.effect(
      Application,
      Effect.gen(function* () {
        const owner = yield* acquireDataDirectoryOwnership(config.dataDirectory);
        const filename = join(owner.canonicalDirectory, "app.sqlite");
        const backups = join(config.dataDirectory, "backups");
        yield* Effect.scoped(migrateDatabase(filename, config.migrationDirectory, backups));
        const operations = yield* Semaphore.make(1);
        const database = SqliteClient.layer({ filename });
        const store = NotesStore.layer.pipe(Layer.provide(database));

        const reviewQuery = <A>(operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>) =>
          Effect.scoped(Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA foreign_keys=ON`;
            yield* sql`PRAGMA synchronous=FULL`;
            yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ foreign_keys: Schema.Literal(1) })))(yield* sql`PRAGMA foreign_keys`);
            yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ synchronous: Schema.Literal(2) })))(yield* sql`PRAGMA synchronous`);

            return yield* operation.pipe(Effect.provide(ReviewStore.layer));
          }).pipe(Effect.provide(database))).pipe(
            Effect.mapError((error) => Schema.is(ReviewError)(error) ? error : new ReviewStorageError({ message: "The review database operation failed." })),
            Semaphore.withPermit(operations), Effect.uninterruptible,
          );

        const processing = config.processing;
        const documents = processing === undefined ? undefined : yield* Documents.pipe(Effect.provide(yield* Layer.build(Documents.layer({ ...processing, dataDirectory: owner.canonicalDirectory }))));
        const review = createReviewOperations({ query: reviewQuery, documents, owner });
        const inference = config.inference;

        const executionOptions = { owner, queries: operations,port: review.port,runPromise: entry.runPromise };
        const executionLayer = ReviewExecution.layer(inference === undefined ? executionOptions : {
          ...executionOptions,provider: { provider: inference.provider,apiKey: inference.apiKey,baseUrl: inference.baseUrl,model: inference.model,route: "live" },
        });
        const execution = yield* ReviewExecution.pipe(Effect.provide(yield* Layer.build(executionLayer)));

        const query = <A>(operation: Effect.Effect<A, StorageError, NotesStore>) =>
          Effect.scoped(operation.pipe(Effect.provide(store))).pipe(
            Effect.mapError(() => new StorageError({ message: "The database operation failed." })),
            Semaphore.withPermit(operations),
          );

        return Application.of({
          review, execution,
          list: query(Effect.flatMap(NotesStore, (notes) => notes.list)),
          add: (text) => query(Effect.flatMap(NotesStore, (notes) => notes.add(text))),
          export: (destination) =>
            Effect.scoped(exportDatabase(filename, destination)).pipe(
              Semaphore.withPermit(operations),
            ),
          restore: (source) =>
            Effect.scoped(Effect.gen(function* () {
              const currentReviews = yield* hasReviews(filename);
              const incomingReviews = yield* hasReviews(source);

              if (currentReviews || incomingReviews) return yield* new DatabaseFileError({ message: "Review data requires its complete project package, including originals and execution journals. Database-only restore is unavailable." });
              yield* restoreDatabase(filename, source, config.migrationDirectory, backups);
            })).pipe(Effect.mapError(() => new DatabaseFileError({ message: "Use a complete review package to restore review data. Existing data was preserved." })), Semaphore.withPermit(operations), Effect.uninterruptible),
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
      ListNotes: () => application.list,
      AddNote: ({ text }) => application.add(text),
      ExportDatabase: ({ destination }) => application.export(destination),
      RestoreDatabase: ({ source }) => application.restore(source),
      ReviewSnapshot: ({ projectId, afterSequence }) => application.review.snapshot(projectId,afterSequence),
      ReviewCommand: ({ command }) => application.review.command(command),
      RenderSource: (request) => application.review.render(request),
      ReadArtifactChunk: (request) => application.review.chunk(request),
      ImportReviewPdf: (request) => application.review.importPdf(request),
      StartExecution: (request) => application.execution.start(request),
      ExecutionStatus: ({ projectId, runId }) => application.execution.status(projectId,runId),
      ControlExecution: ({ projectId, runId, expectedVersion, action }) => application.execution.control(projectId,runId,expectedVersion,action),
      ExecutionEvents: ({ projectId, afterSequence }) => application.execution.events(projectId,afterSequence),
    };
  }),
);
