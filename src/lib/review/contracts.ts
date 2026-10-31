import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ReviewDiscipline } from "./disciplines.ts";

const Identifier = Schema.String.check(Schema.isUUID());

/** Stable identifiers are distinct across project, source, and result boundaries. */
export const ProjectId = Identifier.pipe(Schema.brand("ProjectId"));

/** A document revision identifies immutable original bytes. */
export const RevisionId = Identifier.pipe(Schema.brand("RevisionId"));

/** A sheet is qualified by its project and immutable revision. */
export const SheetId = Identifier.pipe(Schema.brand("SheetId"));

/** Content-addressed files are exposed by opaque IDs, never filesystem paths. */
export const ArtifactId = Identifier.pipe(Schema.brand("ArtifactId"));

/** A finding keeps its identity across input corrections and check runs. */
export const FindingId = Identifier.pipe(Schema.brand("FindingId"));

/** Each accepted or proposed input has an append-only identity. */
export const FactId = Identifier.pipe(Schema.brand("FactId"));

/** A deterministic evaluation never overwrites an earlier evaluation. */
export const CheckId = Identifier.pipe(Schema.brand("CheckId"));

/** A conversation groups reviewer instructions without making them evidence. */
export const ConversationId = Identifier.pipe(Schema.brand("ConversationId"));

/** Redelivered commands return their original committed receipt. */
export const CommandId = Identifier.pipe(Schema.brand("CommandId"));

/** A render job identifies repeatable source work independently of its file. */
export const OperationId = Identifier.pipe(Schema.brand("OperationId"));

const Label = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const Reason = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const MessageText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
const ReviewNote = Schema.Trim.check(Schema.isMaxLength(2000));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 }));
const Coordinate = Schema.Finite;
const Extent = Schema.Finite.check(Schema.isGreaterThan(0));

/** PDF page coordinates; width and height are positive, with no display rounding. */
export class Region extends Schema.Class<Region>("Region")({
  x: Coordinate,
  y: Coordinate,
  width: Extent,
  height: Extent,
}) {}

/** Affine map [a,b,c,d,e,f]: x'=ax+cy+e, y'=bx+dy+f. */
export const Affine = Schema.Tuple([
  Coordinate,
  Coordinate,
  Coordinate,
  Coordinate,
  Coordinate,
  Coordinate,
]);

/** The exact source region and reviewer-visible assertion for a count. */
export class Evidence extends Schema.Class<Evidence>("Evidence")({
  sheetId: SheetId,
  region: Region,
  statement: Reason,
}) {}

/** A project owns all of its source, input versions, conversations, and results. */
export class Project extends Schema.Class<Project>("Project")({
  id: ProjectId,
  name: Label,
  version: Version,
  sourceVersion: Version,
  factVersion: Version,
  createdAt: Schema.String,
}) {}

/** Originals are immutable; importing a revision never replaces its predecessor. */
export class Revision extends Schema.Class<Revision>("Revision")({
  id: RevisionId,
  projectId: ProjectId,
  artifactId: ArtifactId,
  name: Label,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  pageCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  importedAt: Schema.String,
}) {}

/** Labels and sheet correspondence require reviewer confirmation. */
export class Sheet extends Schema.Class<Sheet>("Sheet")({
  id: SheetId,
  projectId: ProjectId,
  revisionId: RevisionId,
  pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
  label: Label,
  confirmed: Schema.Boolean,
  discipline: Schema.optionalKey(Schema.NullOr(ReviewDiscipline)),
  box: Region,
  rotation: Schema.Literals([0, 90, 180, 270]),
  userUnit: Extent,
  coverage: Schema.Literals(["unreviewed", "partial", "reviewer_complete"]),
}) {}

/** Advisory stored-PDF names are separate from sheet verification and count coverage. */
export class SheetLabelSuggestion extends Schema.Class<SheetLabelSuggestion>(
  "SheetLabelSuggestion",
)({
  sheetId: SheetId,
  currentLabel: Label,
  proposedLabel: Schema.NullOr(Label),
  status: Schema.Literals(["suggested", "unresolved", "preserved"]),
}) {}

/** One read-only inspection proposes names without changing the existing inventory. */
export class SheetLabelSuggestions extends Schema.Class<SheetLabelSuggestions>(
  "SheetLabelSuggestions",
)({
  revisionId: RevisionId,
  proposals: Schema.Array(SheetLabelSuggestion).check(Schema.isMaxLength(200)),
}) {}

/** Name suggestions are scoped to an immutable revision owned by the requested project. */
export const SuggestSheetLabels = Schema.Struct({ projectId: ProjectId, revisionId: RevisionId });

/** Explicit reviewer metadata edits replace only generic page labels. */
export const SuggestedSheetLabel = Schema.Struct({ sheetId: SheetId, label: Label });

/** Image provenance includes both directions of the complete PDF-to-raster map. */
export class Artifact extends Schema.Class<Artifact>("Artifact")({
  id: ArtifactId,
  projectId: ProjectId,
  revisionId: RevisionId,
  sheetId: Schema.NullOr(SheetId),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  mediaType: Schema.Literals(["application/pdf", "image/png"]),
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 * 1024 * 1024 })),
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  region: Schema.NullOr(Region),
  dpi: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
  operationId: OperationId,
}) {}

/** Evidence acceptance is separate from evaluation, closure, and task completion. */
export class CountFact extends Schema.Class<CountFact>("CountFact")({
  id: FactId,
  projectId: ProjectId,
  findingId: FindingId,
  side: Schema.Literals(["drawn", "scheduled"]),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["proposed", "accepted", "rejected"]),
  value: Count,
  unit: Schema.Literal("count"),
  coverageConfirmed: Schema.Boolean,
  evidence: Evidence,
  actor: Schema.Literals(["reviewer", "muse", "recorded"]),
  origin: Schema.optionalKey(
    Schema.Struct({
      runId: Schema.String.check(Schema.isUUID()),
      journalId: Schema.String.check(Schema.isUUID()),
      commandId: CommandId,
      providerTaskId: Schema.Int,
      responseId: Schema.NullOr(Schema.String),
      route: Schema.Literals(["live", "recorded"]),
      provider: Schema.Literals(["meta", "baseten"]),
      model: Schema.String,
      promptVersion: Schema.Literals([
        "selected-finding-review-v1",
        "moke-selected-coordination-v2",
      ]),
      instructionRevision: Schema.optionalKey(Schema.String),
      discipline: Schema.optionalKey(Schema.String),
      reviewerMessageId: Schema.optionalKey(Identifier),
      sourceVersion: Schema.Int,
      factVersion: Schema.Int,
    }),
  ),
  rationale: ReviewNote,
  supersedes: Schema.NullOr(FactId),
  createdAt: Schema.String,
}) {}

/** Check outcomes describe the available evidence rather than reviewer task status. */
const CheckOutcome = Schema.Literals([
  "pending",
  "running",
  "needs_evidence",
  "supported_issue",
  "checked_no_issue",
  "stale",
  "outside_scope",
]);

/** An immutable calculation records exact input identities and repeatable arithmetic. */
export class CheckRun extends Schema.Class<CheckRun>("CheckRun")({
  id: CheckId,
  projectId: ProjectId,
  findingId: FindingId,
  ruleVersion: Schema.Literal("schedule-count-v1"),
  drawnFactId: Schema.NullOr(FactId),
  scheduledFactId: Schema.NullOr(FactId),
  drawnCount: Schema.NullOr(Count),
  scheduledCount: Schema.NullOr(Count),
  difference: Schema.NullOr(Schema.Int),
  outcome: CheckOutcome,
  explanation: Schema.String,
  createdAt: Schema.String,
}) {}

/** A coordination issue preserves history and independent completion axes. */
export class Finding extends Schema.Class<Finding>("Finding")({
  id: FindingId,
  projectId: ProjectId,
  title: Label,
  objectClass: Label,
  drawnSheetId: SheetId,
  scheduledSheetId: SheetId,
  applicabilityConfirmed: Schema.Boolean,
  latestCheckId: Schema.NullOr(CheckId),
  outcome: CheckOutcome,
  closed: Schema.Boolean,
  taskCompleted: Schema.Boolean,
}) {}

/** Conversation prose is never promoted to accepted engineering evidence. */
export class Conversation extends Schema.Class<Conversation>("Conversation")({
  id: ConversationId,
  projectId: ProjectId,
  title: Label,
  createdAt: Schema.String,
}) {}

/** Reviewer messages and application progress retain their own provenance. */
export class ReviewMessage extends Schema.Class<ReviewMessage>("ReviewMessage")({
  id: Identifier,
  projectId: ProjectId,
  conversationId: ConversationId,
  role: Schema.Literals(["reviewer", "application"]),
  text: MessageText,
  createdAt: Schema.String,
  origin: Schema.optionalKey(
    Schema.Struct({
      runId: Identifier,
      findingId: FindingId,
      elapsedMs: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
      promptVersion: Schema.String,
      instructionRevision: Schema.NullOr(Schema.String),
      discipline: Schema.NullOr(Schema.String),
    }),
  ),
}) {}

/** Persisted event cursors make reconnect independent of in-memory broadcasts. */
export class ReviewEvent extends Schema.Class<ReviewEvent>("ReviewEvent")({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  projectId: ProjectId,
  commandId: CommandId,
  kind: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
}) {}

/** Saved sheet matches and explicit removed or unresolved revision decisions. */
export class RevisionCorrespondence extends Schema.Class<RevisionCorrespondence>(
  "RevisionCorrespondence",
)({
  revisionId: RevisionId,
  oldSheetId: SheetId,
  newSheetId: Schema.NullOr(SheetId),
  confirmed: Schema.Boolean,
  content: Schema.Literals(["changed", "unchanged", "removed", "unresolved"]),
}) {}

/** A bounded workbench snapshot contains current records and immutable history. */
export class ReviewSnapshot extends Schema.Class<ReviewSnapshot>("ReviewSnapshot")({
  projects: Schema.Array(Project),
  project: Schema.NullOr(Project),
  revisions: Schema.Array(Revision),
  sheets: Schema.Array(Sheet),
  artifacts: Schema.Array(Artifact),
  findings: Schema.Array(Finding),
  facts: Schema.Array(CountFact),
  checks: Schema.Array(CheckRun),
  conversations: Schema.Array(Conversation),
  messages: Schema.Array(ReviewMessage),
  events: Schema.Array(ReviewEvent),
  sheetCorrespondence: Schema.optionalKey(Schema.Array(RevisionCorrespondence)),
}) {}

/** A command receipt is committed with its mutation and returned unchanged on replay. */
export class CommandReceipt extends Schema.Class<CommandReceipt>("CommandReceipt")({
  commandId: CommandId,
  projectId: ProjectId,
  entityId: Identifier,
  version: Version,
}) {}

/** Several full 200-page revisions; keeps sheet-list commands inside the backend request limit. */
const commandSheetLimit = 1000;

const ScopedCommand = {
  commandId: CommandId,
  projectId: ProjectId,
  expectedVersion: Version,
};

/** Reviewer operations carry optimistic concurrency and stable redelivery identities. */
export const ReviewCommand = Schema.Union([
  Schema.TaggedStruct("CreateProject", { commandId: CommandId, name: Label }),
  Schema.TaggedStruct("CreateConversation", { ...ScopedCommand, title: Label }),
  Schema.TaggedStruct("PostMessage", {
    ...ScopedCommand,
    conversationId: ConversationId,
    text: MessageText,
  }),
  Schema.TaggedStruct("AssignSheetDiscipline", {
    ...ScopedCommand,
    sheetIds: Schema.NonEmptyArray(SheetId).check(Schema.isMaxLength(commandSheetLimit)),
    discipline: Schema.NullOr(ReviewDiscipline),
  }),
  Schema.TaggedStruct("ConfirmSheet", {
    ...ScopedCommand,
    sheetId: SheetId,
    label: Label,
    coverage: Sheet.fields.coverage,
  }),
  Schema.TaggedStruct("ApplySheetLabels", {
    ...ScopedCommand,
    revisionId: RevisionId,
    labels: Schema.NonEmptyArray(SuggestedSheetLabel).check(Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct("CreateFinding", {
    ...ScopedCommand,
    title: Label,
    objectClass: Label,
    drawnSheetId: SheetId,
    scheduledSheetId: SheetId,
    applicabilityConfirmed: Schema.Boolean,
  }),
  Schema.TaggedStruct("AcceptCount", {
    ...ScopedCommand,
    findingId: FindingId,
    side: CountFact.fields.side,
    value: Count,
    unit: Schema.Literal("count"),
    coverageConfirmed: Schema.Boolean,
    evidence: Evidence,
    rationale: ReviewNote,
  }),
  Schema.TaggedStruct("EvaluateFinding", { ...ScopedCommand, findingId: FindingId }),
  Schema.TaggedStruct("SetFindingStatus", {
    ...ScopedCommand,
    findingId: FindingId,
    closed: Schema.Boolean,
    taskCompleted: Schema.Boolean,
  }),
  Schema.TaggedStruct("AssociateRevision", {
    ...ScopedCommand,
    revisionId: RevisionId,
    correspondence: Schema.NonEmptyArray(
      Schema.Struct({
        oldSheetId: SheetId,
        newSheetId: Schema.NullOr(SheetId),
        confirmed: Schema.Boolean,
        content: Schema.Literals(["changed", "unchanged", "removed", "unresolved"]),
      }),
    ).check(Schema.isMaxLength(commandSheetLimit)),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

/** Invalid references and geometry are rejected before source work or promotion. */
export class ReviewInputError extends Schema.TaggedError<ReviewInputError>()("ReviewInputError", {
  message: Schema.String,
}) {}

/** A stale command cannot overwrite a newer correction or revision. */
export class ReviewConflict extends Schema.TaggedError<ReviewConflict>()("ReviewConflict", {
  message: Schema.String,
}) {}

/** Persistent state or evidence could not be read safely. */
export class ReviewStorageError extends Schema.TaggedError<ReviewStorageError>()(
  "ReviewStorageError",
  { message: Schema.String },
) {}

/** PDF processing failures distinguish rejected source data from storage faults. */
export class DocumentError extends Schema.TaggedError<DocumentError>()("DocumentError", {
  reason: Schema.Literals(["invalid", "encrypted", "limit", "cancelled", "unavailable"]),
  message: Schema.String,
}) {}

/** Known review failures survive both schema-validated RPC hops. */
export const ReviewError = Schema.Union([
  ReviewInputError,
  ReviewConflict,
  ReviewStorageError,
  DocumentError,
]);

/** A source render is bounded and tied to an immutable sheet and stable operation. */
export const RenderSource = Schema.Struct({
  projectId: ProjectId,
  sheetId: SheetId,
  operationId: OperationId,
  region: Region,
  dpi: Schema.Int.check(Schema.isBetween({ minimum: 24, maximum: 300 })),
});

/** Artifact chunks bound memory separately from the HTTP request-body limit. */
export class ArtifactChunk extends Schema.Class<ArtifactChunk>("ArtifactChunk")({
  artifactId: ArtifactId,
  offset: Schema.Int,
  totalBytes: Schema.Int,
  base64: Schema.String,
}) {}

/** Renderer capabilities expose project-scoped IDs and bounded media, never raw paths. */
export class ReviewRpc extends RpcGroup.make(
  Rpc.make("ReviewSnapshot", {
    payload: { projectId: Schema.NullOr(ProjectId), afterSequence: Version },
    success: ReviewSnapshot,
    error: ReviewError,
  }),
  Rpc.make("ReviewCommand", {
    payload: { command: ReviewCommand },
    success: CommandReceipt,
    error: ReviewError,
  }),
  Rpc.make("SuggestSheetLabels", {
    payload: SuggestSheetLabels,
    success: SheetLabelSuggestions,
    error: ReviewError,
  }),
  Rpc.make("RenderSource", { payload: RenderSource, success: Artifact, error: ReviewError }),
  Rpc.make("ReadArtifactChunk", {
    payload: {
      projectId: ProjectId,
      artifactId: ArtifactId,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 * 1024 })),
    },
    success: ArtifactChunk,
    error: ReviewError,
  }),
) {}

/** Import/export remain shell-selected file capabilities outside the renderer API. */
export class ReviewFilesRpc extends RpcGroup.make(
  Rpc.make("ImportReviewPdf", {
    payload: {
      ...ScopedCommand,
      source: Schema.NonEmptyString,
      name: Label,
    },
    success: CommandReceipt,
    error: ReviewError,
  }),
) {}
