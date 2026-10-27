import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** A saved note crossing the database and RPC boundaries. */
export class Note extends Schema.Class<Note>("Note")({
  id: Schema.Int,
  text: Schema.String,
  created_at: Schema.String,
}) {}

/** Validated content accepted by the application. */
export const NoteText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/** A persistence failure safe to expose to the caller. */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
}) {}

/** The shared, schema-validated application contract. */
export class NotesRpc extends RpcGroup.make(
  Rpc.make("ListNotes", { success: Schema.Array(Note), error: StorageError }),
  Rpc.make("AddNote", { payload: { text: NoteText }, success: Note, error: StorageError }),
) {}
