import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CommandId, ConversationId, FindingId, ProjectId } from "./contracts.ts";

/** Discipline routing preserves the four distinct fire responsibilities from Moke. */
export const ReviewDiscipline = Schema.Literals([
  "general",
  "civil",
  "building_design",
  "life_safety",
  "structural",
  "mechanical",
  "electrical",
  "plumbing",
  "fire_alarm",
  "fire_sprinkler",
  "fire_protection",
]);

/** Human-readable scope names shared by setup and the execution summary. */
export const reviewDisciplines = [
  { id: "general", label: "General" },
  { id: "civil", label: "Civil" },
  { id: "building_design", label: "Building design" },
  { id: "life_safety", label: "Life safety" },
  { id: "structural", label: "Structural" },
  { id: "mechanical", label: "Mechanical" },
  { id: "electrical", label: "Electrical" },
  { id: "plumbing", label: "Plumbing" },
  { id: "fire_alarm", label: "Fire alarm" },
  { id: "fire_sprinkler", label: "Fire sprinkler" },
  { id: "fire_protection", label: "Fire protection" },
] as const;

/** A review send names an already persisted reviewer message. */
export const ReviewRequest = Schema.Struct({
  conversationId: ConversationId,
  messageId: Schema.String.check(Schema.isUUID()),
  discipline: ReviewDiscipline,
});

/** Frozen request content survives pause/reopen without consulting newer messages. */
export const ExecutionReviewContext = Schema.Struct({
  request: ReviewRequest,
  instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  instructionRevision: Schema.String,
});

/** Renderer-safe setup contains no credentials or credential locations. */
export class ExecutionSetup extends Schema.Class<ExecutionSetup>("ExecutionSetup")({
  configured: Schema.Boolean,
  provider: Schema.NullOr(Schema.Literals(["meta", "baseten"])),
  model: Schema.NullOr(Schema.String),
  segmentation: Schema.Boolean,
  promptVersion: Schema.String,
  instructionRevision: Schema.String,
}) {}

/** Public execution identifiers reveal neither journal locations nor provider sessions. */
export const RunId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RunId"));

/** Run controls use optimistic versions independently of source and fact versions. */
export const ExecutionVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A terminal model answer does not imply that its proposed evidence was accepted. */
export const ExecutionState = Schema.Literals([
  "running",
  "pausing",
  "paused",
  "cancelled",
  "completed",
  "failed",
  "uncertain",
  "incompatible",
]);

/** Reservations bound calls, text input tokens, and output tokens; image token accounting is unknown. */
export class ExecutionBudget extends Schema.Class<ExecutionBudget>("ExecutionBudget")({
  maxCalls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  maxInputTokens: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 64000 })),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 8192 })),
}) {}

/** Renderer-safe status separates the route from unresolved provider evidence. */
export class ExecutionStatus extends Schema.Class<ExecutionStatus>("ExecutionStatus")({
  runId: RunId,
  projectId: ProjectId,
  findingId: FindingId,
  state: ExecutionState,
  version: ExecutionVersion,
  route: Schema.Literals(["offline", "recorded", "live"]),
  provider: Schema.Literals(["meta", "baseten"]),
  model: Schema.String,
  admittedCalls: ExecutionVersion,
  reservedInputTokens: ExecutionVersion,
  reservedOutputTokens: ExecutionVersion,
  unresolvedAttempts: ExecutionVersion,
  uncertaintyAcknowledged: Schema.Boolean,
  costUsd: Schema.NullOr(Schema.Finite),
  imageInputTokens: Schema.Null,
}) {}

/** Event cursors survive renderer disconnects and backend restarts. */
export class ExecutionEvent extends Schema.Class<ExecutionEvent>("ExecutionEvent")({
  sequence: Schema.Int,
  runId: RunId,
  state: ExecutionState,
  version: ExecutionVersion,
}) {}

/** Safe failures contain no model prompts, credentials, paths, or SDK errors. */
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  reason: Schema.Literals([
    "input",
    "conflict",
    "storage",
    "unavailable",
    "uncertain",
    "incompatible",
    "budget",
    "cancelled",
  ]),
  message: Schema.String,
}) {}

/** Starting work names a selected finding and a bounded admission policy. */
export const StartExecution = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  findingId: FindingId,
  budget: ExecutionBudget,
  reviewRequest: Schema.optionalKey(ReviewRequest),
});

/** Public controls deliberately omit retry, credentials, compaction, and raw transcripts. */
export class ExecutionRpc extends RpcGroup.make(
  Rpc.make("ExecutionSetup", {
    payload: Schema.Struct({}),
    success: ExecutionSetup,
    error: ExecutionError,
  }),
  Rpc.make("StartExecution", {
    payload: StartExecution,
    success: ExecutionStatus,
    error: ExecutionError,
  }),
  Rpc.make("ExecutionStatus", {
    payload: { projectId: ProjectId, runId: RunId },
    success: ExecutionStatus,
    error: ExecutionError,
  }),
  Rpc.make("ControlExecution", {
    payload: {
      projectId: ProjectId,
      runId: RunId,
      expectedVersion: ExecutionVersion,
      action: Schema.Literals(["pause", "resume", "cancel"]),
      commandId: CommandId,
    },
    success: ExecutionStatus,
    error: ExecutionError,
  }),
  Rpc.make("AcknowledgeUncertainExecution", {
    payload: {
      projectId: ProjectId,
      runId: RunId,
      expectedVersion: ExecutionVersion,
      commandId: CommandId,
      possibleChargeAcknowledged: Schema.Literal(true),
    },
    success: ExecutionStatus,
    error: ExecutionError,
  }),
  Rpc.make("ExecutionEvents", {
    payload: { projectId: ProjectId, afterSequence: ExecutionVersion },
    success: Schema.Array(ExecutionEvent),
    error: ExecutionError,
  }),
  Rpc.make("ObserveExecution", {
    payload: { projectId: ProjectId, afterSequence: ExecutionVersion },
    success: ExecutionEvent,
    error: ExecutionError,
    stream: true,
  }),
) {}
