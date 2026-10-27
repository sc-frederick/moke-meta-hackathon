import { Effect } from "effect";
import { NotesRpc, StorageError } from "../src/lib/notes.ts";
import { BackendApi } from "./backend.ts";

/** Forward the renderer's typed contract; application work stays in the Bun backend. */
export const NotesProxy = NotesRpc.toLayer(
  Effect.gen(function* () {
    const { api } = yield* BackendApi;

    return {
      ListNotes: () =>
        api
          .ListNotes()
          .pipe(Effect.mapError(() => new StorageError({ message: "Notes could not be loaded." }))),
      AddNote: ({ text }) =>
        api
          .AddNote({ text })
          .pipe(
            Effect.mapError(() => new StorageError({ message: "The note could not be saved." })),
          ),
    };
  }),
);
