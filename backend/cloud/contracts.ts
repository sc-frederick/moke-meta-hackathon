import { Effect, Schema } from "effect";
import { InferenceConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudReviewError,
  CloudReviewId,
  CloudReviewPhase,
  CloudReviewRequest,
  CloudPacketProgress,
} from "#lib/review/cloud.ts";
import { ExecutionStatus } from "#lib/review/execution.ts";
import {
  packetPromptVersion,
  reviewInstructionRevision,
  reviewPromptVersion,
} from "../review/prompts/review-prompt.ts";
import { packageEngineFormat } from "#lib/review/packages.ts";

/** Version handshake covers the worker protocol, engine, and review instructions. */
export const cloudEngineIdentity = {
  protocol: 2,
  engine: packageEngineFormat,
  prompt: reviewPromptVersion,
  instructions: reviewInstructionRevision,
  packetPrompt: packetPromptVersion,
} as const;

/** A different cloud build is refused before any paid inference is admitted. */
export const CloudEngineIdentity = Schema.Struct({
  protocol: Schema.Literal(cloudEngineIdentity.protocol),
  engine: Schema.Literal(cloudEngineIdentity.engine),
  prompt: Schema.Literal(cloudEngineIdentity.prompt),
  instructions: Schema.Literal(cloudEngineIdentity.instructions),
  packetPrompt: Schema.Literal(cloudEngineIdentity.packetPrompt),
});

/** Credentials are supplied to the exec process separately from its source package. */
export const CloudWorkerRequest = Schema.Struct({
  id: CloudReviewId,
  identity: CloudEngineIdentity,
  request: CloudReviewRequest,
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 60_000, maximum: 3_600_000 }),
    Schema.isMultipleOf(1000),
  ),
});

/** The worker writes one atomic, bounded progress record without prompts or secrets. */
export const CloudWorkerProgress = Schema.Struct({
  id: CloudReviewId,
  identity: CloudEngineIdentity,
  phase: Schema.Literals(["accepted", "running", "ready", "failed"]),
  execution: Schema.NullOr(ExecutionStatus),
  packet: Schema.optionalKey(CloudPacketProgress),
  message: Schema.String.check(Schema.isMaxLength(1000)),
});

/** Persistent local intent is saved before every ambiguous external dispatch. */
export const CloudReviewRecord = Schema.Struct({
  id: CloudReviewId,
  revision: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  syncFailure: Schema.NullOr(CloudReviewError).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  fingerprint: Schema.String,
  request: CloudReviewRequest,
  phase: CloudReviewPhase,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  sandboxId: Schema.NullOr(Schema.String),
  inputSnapshotId: Schema.NullOr(Schema.String),
  resultSnapshotId: Schema.NullOr(Schema.String),
  sandboxName: Schema.String,
  appName: Schema.String,
  environment: Schema.String,
  sourceVersion: Schema.Int,
  factVersion: Schema.Int,
  projectVersion: Schema.Int,
  execution: Schema.NullOr(ExecutionStatus),
  packet: Schema.optionalKey(CloudPacketProgress),
  message: Schema.String,
});

/** Persisted record type stays private to cloud application and adapters. */
export type CloudReviewRecord = typeof CloudReviewRecord.Type;

/** Provider injection uses the canonical application route and a separately supplied secret. */
export const CloudProvider = InferenceConfiguration;

/** The chosen chat connection plus optional tool-provider connections contain placeholder keys only. */
export const CloudProviders = Schema.NonEmptyArray(CloudProvider);

/** Warm candidates are single-use, versioned, and must outlive the entire admitted job. */
export const WarmSandbox = Schema.Struct({
  sandboxId: Schema.String.check(Schema.isMinLength(1)),
  imageName: Schema.String,
  identity: CloudEngineIdentity,
  expiresAt: Schema.Finite,
});

/** JSON avoids the SDK queue's integer truncation of millisecond timestamps. */
export const WarmSandboxMessage = Schema.fromJsonString(WarmSandbox);
