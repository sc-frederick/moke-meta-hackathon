import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NotesRpc } from "./notes.ts";

/** A safe failure at the database file, migration, or recovery boundary. */
export class DatabaseFileError extends Schema.TaggedError<DatabaseFileError>()(
  "DatabaseFileError",
  {
    message: Schema.String,
  },
) {}

/** A backend process or transport failure safe to report at the desktop boundary. */
export class BackendUnavailable extends Schema.TaggedError<BackendUnavailable>()(
  "BackendUnavailable",
  {
    message: Schema.String,
  },
) {}

const Path = Schema.String.check(Schema.isMinLength(1));

/** Private startup configuration sent once over the child's stdin, never command-line arguments. */
export class BackendConfig extends Schema.Class<BackendConfig>("BackendConfig")({
  dataDirectory: Path,
  migrationDirectory: Path,
  token: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
}) {}

/** Versioned, validated readiness message emitted after migrations and API startup. */
export class BackendReady extends Schema.Class<BackendReady>("BackendReady")({
  protocolVersion: Schema.Literal(1),
  runtime: Schema.Literal("bun"),
  version: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
}) {}

/** Database operations available only to the trusted desktop shell. */
export class DatabaseRpc extends RpcGroup.make(
  Rpc.make("ExportDatabase", {
    payload: { destination: Path },
    success: Schema.String,
    error: DatabaseFileError,
  }),
  Rpc.make("RestoreDatabase", {
    payload: { source: Path },
    success: Schema.Void,
    error: DatabaseFileError,
  }),
) {}

/** Shared application API served by Bun; Electron exposes only NotesRpc to the renderer. */
export class BackendRpc extends NotesRpc.merge(DatabaseRpc) {}
