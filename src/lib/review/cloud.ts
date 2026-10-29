import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CommandId, FindingId, ProjectId } from "./contracts.ts";
import { ExecutionStatus, StartExecution } from "./execution.ts";
import { PacketReview, StartPacketReview } from "./packet.ts";

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

/** Bounded drawing-set progress; findings and evidence arrive in the verified result package. */
export const CloudPacketProgress = Schema.Struct({
  id: PacketReview.fields.id,
  projectId: ProjectId,
  conversationId: PacketReview.fields.conversationId,
  model: PacketReview.fields.model,
  state: PacketReview.fields.state,
  version: PacketReview.fields.version,
  admittedCalls: PacketReview.fields.admittedCalls,
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
  phase: CloudReviewPhase,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
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
  timeoutMinutes: Schema.Int,
  warmPool: Schema.Boolean,
  transferScope: Schema.Literal("whole-application"),
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
