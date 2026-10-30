import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CommandId, FindingId, ProjectId } from "./contracts.ts";
import { ExecutionStatus, StartExecution } from "./execution.ts";
import {
  PacketActivity,
  PacketFinding,
  PacketParallelReview,
  PacketReview,
  StartPacketReview,
} from "./packet.ts";

/** Cloud runs copy a complete workspace and fence its local writes until returned. */
export const StartCloudReview = Schema.Struct({
  ...StartExecution.fields,
  transferScope: Schema.Literal("whole-application"),
});

/** Whole-set and discipline reviews share the same transfer and ownership protocol. */
export const StartCloudPacketReview = Schema.Struct({
  ...StartPacketReview.fields,
  kind: Schema.Literal("packet"),
  transferScope: Schema.Literal("whole-application"),
});

/** A transfer admits either one selected count check or one drawing-set review. */
export const CloudReviewRequest = Schema.Union([StartCloudReview, StartCloudPacketReview]);

/** Bounds keep live progress small; the verified result package carries every finding in full. */
export const cloudFindingPreviewLimits = {
  findings: 50,
  title: 200,
  sheets: 6,
  sheetLabel: 60,
  bytes: 32 * 1024,
} as const;

/** One finding as last recorded in the cloud. It stays read-only until results are imported. */
export const CloudFindingPreview = Schema.Struct({
  id: PacketFinding.fields.id,
  title: Schema.String.check(Schema.isMaxLength(cloudFindingPreviewLimits.title)),
  severity: PacketFinding.fields.severity,
  discipline: PacketFinding.fields.discipline,
  sheets: Schema.Array(
    Schema.String.check(Schema.isMaxLength(cloudFindingPreviewLimits.sheetLabel)),
  ).check(Schema.isMaxLength(cloudFindingPreviewLimits.sheets)),
});

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Sheet reviewer states of a parallel review, counted rather than listed. */
export const CloudSheetReviewProgress = Schema.Struct({
  stage: PacketParallelReview.fields.stage,
  queued: Count,
  running: Count,
  completed: Count,
  failed: Count,
});

/** Bounded drawing-set progress; findings and evidence arrive in the verified result package. */
export const CloudPacketProgress = Schema.Struct({
  id: PacketReview.fields.id,
  projectId: ProjectId,
  conversationId: PacketReview.fields.conversationId,
  model: PacketReview.fields.model,
  state: PacketReview.fields.state,
  version: PacketReview.fields.version,
  admittedCalls: PacketReview.fields.admittedCalls,
  projectName: Schema.optionalKey(Schema.String),
  openedSheets: Schema.optionalKey(Schema.Int),
  totalSheets: Schema.optionalKey(Schema.Int),
  findings: Schema.optionalKey(Schema.Int),
  recordedPasses: Schema.optionalKey(Schema.Int),
  totalPasses: Schema.optionalKey(Schema.Int),
  changedAt: Schema.optionalKey(Schema.Finite),
  stage: Schema.optionalKey(Schema.Literals(["reviewing", "preparing-results", "results-ready"])),
  lastOpenedDrawing: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(Schema.NullOr(PacketActivity)),
  /** Most recently recorded findings, newest last. A preview only; nothing here is imported. */
  findingPreview: Schema.optionalKey(
    Schema.Array(CloudFindingPreview).check(Schema.isMaxLength(cloudFindingPreviewLimits.findings)),
  ),
  sheetReviews: Schema.optionalKey(CloudSheetReviewProgress),
});

/** Completed package files, including files verified and reused during a download retry. */
export const CloudTransferProgress = Schema.Struct({
  direction: Schema.Literals(["upload", "download"]),
  completedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Completed without the network: cloud storage already held them, or a local copy matched. */
  reusedBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  reusedFiles: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** Read-only size estimate of referenced workspace files; final preparation enforces exact limits. */
export const CloudWorkspaceEstimate = Schema.Struct({
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  projects: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  measuredAt: Schema.Finite,
  /** Projects whose active local reviews must finish before the whole workspace can transfer. */
  localReviews: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Source files already synced to cloud storage, which Send does not upload again. */
  syncedBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  syncedFiles: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** Stable cloud operation identity; sandbox identifiers stay in the backend. */
export const CloudReviewId = Schema.String.check(Schema.isUUID());

/** Disconnection never changes ownership or silently dispatches another review. */
export const CloudReviewPhase = Schema.Literals([
  "preparing",
  "dispatching",
  "running",
  "failed",
  "ready",
  "importing",
  "imported",
  "cancelled",
]);

/** Cloud boundaries redact SDK exceptions, credentials, and filesystem locations. */
export class CloudReviewError extends Schema.TaggedError<CloudReviewError>()("CloudReviewError", {
  reason: Schema.Literals([
    "configuration",
    "conflict",
    "storage",
    "unavailable",
    "incompatible",
    "limit",
  ]),
  message: Schema.String,
}) {}

/** Renderer-safe cloud progress, including the last observed engine status. */
export class CloudReviewStatus extends Schema.Class<CloudReviewStatus>("CloudReviewStatus")({
  id: CloudReviewId,
  revision: Schema.Int,
  projectId: ProjectId,
  findingId: Schema.NullOr(FindingId),
  conversationId: Schema.optionalKey(PacketReview.fields.conversationId),
  model: Schema.optionalKey(PacketReview.fields.model),
  scopeLabel: Schema.optionalKey(Schema.String),
  phase: CloudReviewPhase,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  transferBytes: Schema.optionalKey(Schema.Int),
  transfer: Schema.optionalKey(CloudTransferProgress),
  execution: Schema.NullOr(ExecutionStatus),
  packet: Schema.optionalKey(CloudPacketProgress),
  message: Schema.String,
  syncFailure: Schema.NullOr(CloudReviewError).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/** Safe capability information; credits are managed by Modal rather than guessed locally. */
export class CloudReviewSetup extends Schema.Class<CloudReviewSetup>("CloudReviewSetup")({
  configured: Schema.Boolean,
  message: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  timeoutMinutes: Schema.Int,
  warmPool: Schema.Boolean,
  transferScope: Schema.Literal("whole-application"),
  workspaceEstimate: Schema.optionalKey(CloudWorkspaceEstimate),
  workspaceEstimateError: Schema.optionalKey(Schema.String),
}) {}

/** Replayed current cloud state and safe synchronization failures for a live desktop subscription. */
export class CloudReviewUpdate extends Schema.Class<CloudReviewUpdate>("CloudReviewUpdate")({
  status: Schema.NullOr(CloudReviewStatus),
  error: Schema.NullOr(CloudReviewError),
}) {}

/** A finished import or confirmed stop releases the workspace fence. */
export const cloudReviewLocksWorkspace = (phase: typeof CloudReviewPhase.Type) =>
  phase !== "imported" && phase !== "cancelled";

/** Late RPC replies cannot roll a live subscription back to an earlier durable receipt. */
export const latestCloudReviewStatus = (
  current: CloudReviewStatus | null,
  incoming: CloudReviewStatus | null,
) => {
  if (current === null) return incoming;

  if (incoming === null) return current;

  return incoming.revision >= current.revision ? incoming : current;
};

/** Trusted desktop controls share the same contracts as the Bun application. */
export class CloudReviewRpc extends RpcGroup.make(
  Rpc.make("CloudReviewSetup", { payload: {}, success: CloudReviewSetup, error: CloudReviewError }),
  Rpc.make("StartCloudReview", {
    payload: StartCloudReview,
    success: CloudReviewStatus,
    error: CloudReviewError,
  }),
  Rpc.make("StartCloudPacketReview", {
    payload: StartCloudPacketReview,
    success: CloudReviewStatus,
    error: CloudReviewError,
  }),
  Rpc.make("CloudReviewStatus", {
    payload: {},
    success: Schema.NullOr(CloudReviewStatus),
    error: CloudReviewError,
  }),
  Rpc.make("ObserveCloudReview", {
    payload: {},
    success: CloudReviewUpdate,
    error: CloudReviewError,
    stream: true,
  }),
  Rpc.make("RetryCloudReviewSync", {
    payload: {},
    success: Schema.Void,
    error: CloudReviewError,
  }),
  Rpc.make("RefreshCloudReview", {
    payload: { id: CloudReviewId },
    success: CloudReviewStatus,
    error: CloudReviewError,
  }),
  Rpc.make("ImportCloudReview", {
    payload: { id: CloudReviewId },
    success: CloudReviewStatus,
    error: CloudReviewError,
  }),
  Rpc.make("CancelCloudReview", {
    payload: {
      id: CloudReviewId,
      acknowledgePossibleCharge: Schema.Literal(true),
      commandId: CommandId,
    },
    success: CloudReviewStatus,
    error: CloudReviewError,
  }),
) {}
