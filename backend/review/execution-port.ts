import { Effect, Schema } from "effect";
import {
  Affine,
  Artifact,
  ArtifactId,
  CheckRun,
  CommandId,
  CommandReceipt,
  CountFact,
  Evidence,
  Finding,
  FindingId,
  ProjectId,
  Region,
  Sheet,
  SheetId,
} from "../../src/lib/review/contracts.ts";
import { ExecutionError, ExecutionVersion, RunId } from "../../src/lib/review/execution.ts";
import { SamInspectionRequest, SamObservation } from "#lib/review/segmentation.ts";

/** Every tool is restricted to the finding and immutable inputs captured on start. */
export class ExecutionSelection extends Schema.Class<ExecutionSelection>("ExecutionSelection")({
  projectId: ProjectId,
  findingId: FindingId,
}) {}

/** Selected source evidence, with versions used by the mutation fence. */
export class ExecutionEvidence extends Schema.Class<ExecutionEvidence>("ExecutionEvidence")({
  sourceVersion: ExecutionVersion,
  factVersion: ExecutionVersion,
  finding: Finding,
  sheets: Schema.Array(Sheet),
  facts: Schema.Array(CountFact),
  checks: Schema.Array(CheckRun),
  artifacts: Schema.Array(Artifact),
  reviewerInstructions: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  ),
}) {}

/** Parent transactions must check this fence and commit mutation plus command receipt together. */
export class ExecutionFence extends Schema.Class<ExecutionFence>("ExecutionFence")({
  ...ExecutionSelection.fields,
  runId: RunId,
  journalId: Schema.String.check(Schema.isUUID()),
  ownerGeneration: Schema.String.check(Schema.isUUID()),
  sourceVersion: ExecutionVersion,
  factVersion: ExecutionVersion,
  commandId: CommandId,
}) {}

/** A proposed count never sets accepted state or confirms coverage. */
export const CountProposal = Schema.Struct({
  side: Schema.Literals(["drawn", "scheduled"]),
  value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 })),
  evidence: Evidence,
  rationale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
});

/** Targeted rendering requires an explicit explanation of the missing fact. */
export const DetailRequest = Schema.Struct({
  sheetId: SheetId,
  region: Region,
  missingFact: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});

/** Moke supplies bounded pixels and transforms for the exact resized image delivered to Muse. */
export class ExecutionImage extends Schema.Class<ExecutionImage>("ExecutionImage")({
  artifactId: ArtifactId,
  projectId: ProjectId,
  sheetId: SheetId,
  mimeType: Schema.Literal("image/png"),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2 * 1024 * 1024),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2048 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2048 })),
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
}) {}

/** Tool evidence carries actual pixels separately from its descriptive text. */
export interface ExecutionToolEvidence {
  readonly text: string;
  readonly images: ReadonlyArray<ExecutionImage>;
}

/** Application capability for an optional, separately admitted segmentation integration. */
interface SegmentationCapability {
  readonly segment: (
    fence: ExecutionFence,
    request: SamInspectionRequest,
  ) => Effect.Effect<SamObservation, ExecutionError>;
}

/** The parent implements domain authorization, atomic receipts, source work, and deterministic evaluation. */
export interface ExecutionPort {
  readonly inspect: (
    selection: ExecutionSelection,
  ) => Effect.Effect<ExecutionEvidence, ExecutionError>;
  readonly render: (
    fence: ExecutionFence,
    detail: typeof DetailRequest.Type,
  ) => Effect.Effect<Artifact, ExecutionError>;
  readonly readImage: (artifact: Artifact) => Effect.Effect<ExecutionImage, ExecutionError>;
  readonly propose: (
    fence: ExecutionFence,
    proposal: typeof CountProposal.Type,
  ) => Effect.Effect<CommandReceipt, ExecutionError>;
  readonly evaluate: (fence: ExecutionFence) => Effect.Effect<CheckRun, ExecutionError>;
  readonly message: (
    fence: ExecutionFence,
    text: string,
  ) => Effect.Effect<CommandReceipt, ExecutionError>;
  readonly segmentation?: SegmentationCapability;
}
