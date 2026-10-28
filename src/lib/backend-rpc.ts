import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ReviewFilesRpc, ReviewRpc } from "./review/contracts.ts";
import { ExecutionRpc } from "./review/execution.ts";
import { ReviewPackageFilesRpc } from "./review/packages.ts";

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

const ProcessingConfiguration = Schema.Struct({
  workerCommand: Schema.NonEmptyArray(Path),
  assetsDirectory: Path,
  nativeLibraryPath: Path,
});

/** Credentials cross the startup pipe only; application exports never contain them. */
export const InferenceConfiguration = Schema.Struct({
  provider: Schema.Literals(["meta", "baseten"]),
  apiKey: Schema.RedactedFromValue(Schema.NonEmptyString),
  baseUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
  model: Schema.NonEmptyString,
});

/** Private startup configuration sent once over the child's stdin, never command-line arguments. */
export class BackendConfig extends Schema.Class<BackendConfig>("BackendConfig")({
  dataDirectory: Path,
  migrationDirectory: Path,
  token: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  processing: Schema.optionalKey(ProcessingConfiguration),
  inference: Schema.optionalKey(InferenceConfiguration),
  inferenceAlternatives: Schema.optionalKey(Schema.Array(InferenceConfiguration)),
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
class DatabaseRpc extends RpcGroup.make(
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

/** Application API served by Bun; Electron exposes restricted review and chooser contracts to its trusted renderer. */
export class BackendRpc extends DatabaseRpc.merge(ReviewRpc)
  .merge(ReviewFilesRpc)
  .merge(ExecutionRpc)
  .merge(ReviewPackageFilesRpc) {}
