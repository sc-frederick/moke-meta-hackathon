import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { FindingId, ProjectId } from "./contracts.ts";

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
  projectId: ProjectId,
  findingId: FindingId,
  budget: ExecutionBudget,
});

/** Public controls deliberately omit retry, credentials, compaction, and raw transcripts. */
export class ExecutionRpc extends RpcGroup.make(
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
    },
    success: ExecutionStatus,
    error: ExecutionError,
  }),
  Rpc.make("ExecutionEvents", {
    payload: { projectId: ProjectId, afterSequence: ExecutionVersion },
    success: Schema.Array(ExecutionEvent),
    error: ExecutionError,
  }),
) {}
