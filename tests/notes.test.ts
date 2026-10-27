import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { readFile } from "node:fs/promises";
import { expect, test } from "vite-plus/test";
import { NotesRpc } from "../src/lib/notes.ts";
import { NotesHandlers, NotesStore } from "../src/lib/server/notes-store.ts";

test("RPC saves and reads notes through real SQLite", async () => {
  const schema = await readFile(new URL("../migrations/0001_notes.sql", import.meta.url), "utf8");

  const setup = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(schema);
    }),
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

  const handlers = NotesHandlers.pipe(Layer.provide(NotesStore.layer), Layer.provide(setup));

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* RpcTest.makeClient(NotesRpc);
        const saved = yield* api.AddNote({ text: "A persisted note" });

        return { saved, notes: yield* api.ListNotes() };
      }).pipe(Effect.provide(handlers)),
    ),
  );

  expect(result.saved.text).toBe("A persisted note");
  expect(result.notes).toEqual([result.saved]);
});
