import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Note, NotesRpc, StorageError } from "../notes.ts";

/** Application-owned capability for saving and listing notes. */
export class NotesStore extends Context.Service<
  NotesStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<Note>, StorageError>;
    readonly add: (text: string) => Effect.Effect<Note, StorageError>;
  }
>()("app/NotesStore") {
  /** SQLite/D1 adapter; callers receive parsed domain values and safe failures. */
  static readonly layer = Layer.effect(
    NotesStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const list = sql`SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 100`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Note))),
        Effect.mapError(() => new StorageError({ message: "Notes could not be loaded." })),
        Effect.withSpan("NotesStore.list"),
      );

      const add = Effect.fn("NotesStore.add")(
        function* (text: string) {
          const rows =
            yield* sql`INSERT INTO notes (text) VALUES (${text}) RETURNING id, text, created_at`;

          const notes = yield* Schema.decodeUnknownEffect(Schema.Array(Note))(rows);
          const note = notes[0];

          if (note === undefined) {
            return yield* new StorageError({ message: "The note was not saved." });
          }

          return note;
        },
        Effect.mapError(() => new StorageError({ message: "The note was not saved." })),
      );

      return NotesStore.of({ list, add });
    }),
  );
}

/** Connect the RPC contract to the persistence capability at the application boundary. */
export const NotesHandlers = NotesRpc.toLayer(
  Effect.gen(function* () {
    const store = yield* NotesStore;

    return {
      ListNotes: () => store.list,
      AddNote: ({ text }) => store.add(text),
    };
  }),
);
