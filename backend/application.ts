import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Semaphore } from "effect";
import { join } from "node:path";
import { BackendConfig, BackendRpc, DatabaseFileError } from "../src/lib/backend-rpc.ts";
import { Note, StorageError } from "../src/lib/notes.ts";
import { exportDatabase, migrateDatabase, restoreDatabase } from "./database-files.ts";
import { NotesStore } from "./notes-store.ts";

/** Application operations; the Bun process exclusively owns database connections and recovery. */
export class Application extends Context.Service<
  Application,
  {
    readonly list: Effect.Effect<ReadonlyArray<Note>, StorageError>;
    readonly add: (text: string) => Effect.Effect<Note, StorageError>;
    readonly export: (destination: string) => Effect.Effect<string, DatabaseFileError>;
    readonly restore: (source: string) => Effect.Effect<void, DatabaseFileError>;
  }
>()("app/Application") {
  /** Migrate before serving and serialize recovery with scoped per-operation SQL connections. */
  static layer(config: BackendConfig) {
    return Layer.effect(
      Application,
      Effect.gen(function* () {
        const filename = join(config.dataDirectory, "app.sqlite");
        const backups = join(config.dataDirectory, "backups");
        yield* Effect.scoped(migrateDatabase(filename, config.migrationDirectory, backups));
        const operations = yield* Semaphore.make(1);
        const store = NotesStore.layer.pipe(Layer.provide(SqliteClient.layer({ filename })));

        const query = <A>(operation: Effect.Effect<A, StorageError, NotesStore>) =>
          Effect.scoped(operation.pipe(Effect.provide(store))).pipe(
            Effect.mapError(() => new StorageError({ message: "The database operation failed." })),
            Semaphore.withPermit(operations),
          );

        return Application.of({
          list: query(Effect.flatMap(NotesStore, (notes) => notes.list)),
          add: (text) => query(Effect.flatMap(NotesStore, (notes) => notes.add(text))),
          export: (destination) =>
            Effect.scoped(exportDatabase(filename, destination)).pipe(
              Semaphore.withPermit(operations),
            ),
          restore: (source) =>
            Effect.scoped(
              restoreDatabase(filename, source, config.migrationDirectory, backups),
            ).pipe(Semaphore.withPermit(operations), Effect.uninterruptible),
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
    };
  }),
);
