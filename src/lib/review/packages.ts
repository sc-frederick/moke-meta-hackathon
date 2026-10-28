import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { ExecutionState } from "./execution.ts";

/** Directory package format. The manifest is written last and is not an archive. */
export const packageFormat = "moke-review-package";

/** Current package manifest version. Older and newer versions are refused. */
export const packageFormatVersion = 1;

/**
 * Pi journal format this package writer can close and reopen.
 * Kept beside the backend journal module and checked for equality at export.
 */
export const packageEngineFormat = "review-pi-1.4.0-v1";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ByteCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_589_934_592 }));
const Uuid = Schema.String.check(Schema.isUUID());

/** A hashed file inside a package directory. Paths are package-relative. */
export class PackageFile extends Schema.Class<PackageFile>("PackageFile")({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  sha256: Sha256,
  bytes: ByteCount,
}) {}

/** A closed Pi journal included by id, hash, and engine format. */
export class PackageJournalFile extends Schema.Class<PackageJournalFile>("PackageJournalFile")({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  sha256: Sha256,
  bytes: ByteCount,
  journalId: Uuid,
  format: Schema.Literal(packageEngineFormat),
}) {}

/** Run identity recorded at export, before restore rewrites executing states. */
export class PackageRunSnapshot extends Schema.Class<PackageRunSnapshot>("PackageRunSnapshot")({
  runId: Uuid,
  journalId: Uuid,
  state: ExecutionState,
  ownerGeneration: Uuid,
  uncertainAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
}) {}

/**
 * Manifest for one package directory.
 * `application` / `whole-application` is the only scope this writer produces.
 * `database-only` is recognized so a partial package can be refused.
 */
export class PackageManifest extends Schema.Class<PackageManifest>("PackageManifest")({
  format: Schema.Literal(packageFormat),
  formatVersion: Schema.Literal(packageFormatVersion),
  scope: Schema.Literals(["application", "database-only"]),
  scopeLabel: Schema.Literals(["whole-application", "database-only"]),
  createdAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  hash: Schema.Literal("sha256"),
  engine: Schema.Literal(packageEngineFormat),
  migrations: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
      sha256: Sha256,
    }),
  ),
  database: PackageFile,
  artifacts: Schema.Array(PackageFile),
  journals: Schema.Array(PackageJournalFile),
  runs: Schema.Array(PackageRunSnapshot),
}) {}

/** Parsed caps for package file count and total bytes. */
export const PackageLimits = Schema.Struct({
  maxFiles: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8_589_934_592 })),
});

/** Default caps: 5,000 files and 2 GiB. */
export const defaultPackageLimits = {
  maxFiles: 5_000,
  maxBytes: 2_147_483_648,
} as const satisfies typeof PackageLimits.Type;

/** Known package failures. Messages omit credentials, prompts, and SQL text. */
export class PackageError extends Schema.TaggedError<PackageError>()("PackageError", {
  reason: Schema.Literals([
    "input",
    "incomplete",
    "incompatible",
    "corrupt",
    "conflict",
    "limit",
    "unavailable",
    "interrupted",
  ]),
  message: Schema.String,
}) {}

/** Where a restored run was left, and whether the current runtime may resume it. */
export class RestoredRun extends Schema.Class<RestoredRun>("RestoredRun")({
  runId: Uuid,
  journalId: Uuid,
  previousState: ExecutionState,
  state: ExecutionState,
  ownerGeneration: Uuid,
  uncertainAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  resumeBlocked: Schema.Boolean,
  reason: Schema.Literals([
    "terminal",
    "uncertain-attempt",
    "foreign-owner",
    "restored-historical",
  ]),
}) {}

/**
 * Admission instruction for the parent after a successful file replacement.
 * `admitWork` is false while any restored run can still be resumed or dispatched.
 */
export class PackageAdmission extends Schema.Class<PackageAdmission>("PackageAdmission")({
  admitWork: Schema.Boolean,
  parentAction: Schema.String,
  runs: Schema.Array(RestoredRun),
}) {}

/** Result of writing a whole-application package directory. */
export class PackageExportResult extends Schema.Class<PackageExportResult>("PackageExportResult")({
  destination: Schema.String,
  scope: Schema.Literal("application"),
  scopeLabel: Schema.Literal("whole-application"),
  files: Schema.Int,
  bytes: Schema.Int,
}) {}

/** Result of replacing local data from a validated package. */
export class PackageRestoreResult extends Schema.Class<PackageRestoreResult>(
  "PackageRestoreResult",
)({
  admission: PackageAdmission,
  preRestorePackagePath: Schema.NullOr(Schema.String),
}) {}

/** Startup reconciliation of an interrupted multi-file replacement. */
export class PackageRecovery extends Schema.Class<PackageRecovery>("PackageRecovery")({
  status: Schema.Literals(["idle", "completed", "rolled-back"]),
  preRestorePackagePath: Schema.NullOr(Schema.String),
}) {}

/** Durable points where a test can stop a restore and leave the replacement journal. */
export const PackageInterrupt = Schema.Literals(["prepared", "first-replaced"]);

/** One crash seam. Production callers omit this. */
export type PackageInterrupt = typeof PackageInterrupt.Type;

/** Only the trusted shell chooses full-package filesystem locations. */
export class ReviewPackageFilesRpc extends RpcGroup.make(
  Rpc.make("ExportReviewPackage", {
    payload: { destination: Schema.NonEmptyString },
    success: PackageExportResult,
    error: PackageError,
  }),
  Rpc.make("RestoreReviewPackage", {
    payload: { source: Schema.NonEmptyString },
    success: PackageRestoreResult,
    error: PackageError,
  }),
) {}
