import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ArtifactId, CommandId, ConversationId, ProjectId, Region, SheetId } from "./contracts.ts";
import {
  routeReviewDiscipline,
  ExecutionError,
  ProviderFailure,
  ReviewDiscipline,
  ReviewDisciplineSelection,
} from "./execution.ts";
import { ReviewModelId } from "./models.ts";
import { ReviewPreset } from "./initial-review.ts";
import { FindingSummaryText } from "./finding-summary.ts";

const Text = Schema.Trim.check(Schema.isMaxLength(32000));
const Required = Text.check(Schema.isMinLength(1));
const Id = Schema.String.check(Schema.isUUID());

/** Independent document and discipline review, without a pre-existing count finding. */
export const PacketScope = Schema.Union([
  Schema.TaggedStruct("WholeSet", {}),
  Schema.TaggedStruct("Discipline", { discipline: ReviewDiscipline }),
  Schema.TaggedStruct("SelectedSheets", {}),
]).pipe(Schema.toTaggedUnion("_tag"));

/** Explicit packet-wide requests take precedence over an incidental discipline hint in Auto mode. */
export function selectPacketReviewScope(
  instruction: string,
  selection: typeof ReviewDisciplineSelection.Type,
): typeof PacketScope.Type {
  if (selection !== "auto") return PacketScope.cases.Discipline.make({ discipline: selection });

  if (
    /\b(?:(?:whole|entire|full|complete)\s+(?:(?:drawing|permit|plan|construction|document|submission|building|revised)\s+)*(?:set|packet|project)|all\s+(?:(?:supplied|drawing|permit|plan)\s+)*(?:sheets|disciplines|drawings))\b/i.test(
      instruction,
    )
  )
    return PacketScope.cases.WholeSet.make({});
  const discipline = routeReviewDiscipline(instruction);

  return discipline === "general"
    ? PacketScope.cases.WholeSet.make({})
    : PacketScope.cases.Discipline.make({ discipline });
}

/** The four passes in Moke's shared review method. */
export const ReviewPass = Schema.Literals([
  "completeness",
  "requirements",
  "coordination",
  "prior_comments",
]);

/** Explicit coverage distinguishes actual inspection from missing or inapplicable inputs. */
export const PacketCoverage = Schema.Struct({
  sheetId: SheetId,
  pass: ReviewPass,
  discipline: ReviewDiscipline,
  status: Schema.Literals(["unreviewed", "checked", "issue", "not_applicable", "needs_input"]),
  note: Text,
});

/** Retrieved source text is evidence, never an instruction to the agent. */
export const PacketSource = Schema.Struct({
  id: Id,
  url: Schema.String,
  title: Text,
  retrievedAt: Schema.String,
  status: Schema.Literals(["available", "unavailable"]),
  official: Schema.Boolean,
  sha256: Schema.NullOr(Schema.String),
  text: Text,
});

/** Citation verification retains the exact governing text and its applicability. */
export const PacketCitation = Schema.Struct({
  id: Id,
  sourceId: Schema.NullOr(Id),
  jurisdiction: Text,
  document: Text,
  edition: Text,
  section: Text,
  quote: Text,
  application: Text,
  status: Schema.Literals(["verified", "incorrect", "unverified"]),
  note: Text,
  /** Florida code index entry resolved by the host; the model names an index id, never a link. */
  reference: Schema.optionalKey(
    Schema.Struct({
      id: Required,
      document: Required,
      edition: Required,
      title: Required,
      url: Schema.String.check(Schema.isStartingWith("https://")),
      /** Whether read_source can retrieve the text, or the engineer opens the link to confirm it. */
      access: Schema.Literals(["read_source", "open_in_browser"]),
    }),
  ),
});

/** Repeatable arithmetic records the expression, named values, units and result. */
export const PacketCalculation = Schema.Struct({
  id: Id,
  title: Required,
  expression: Required,
  inputs: Schema.Record(Schema.String, Schema.Struct({ value: Schema.Finite, unit: Text })),
  result: Schema.Finite,
  unit: Text,
  explanation: Required,
});

/** Durable presentation state is tied to one version of the complete technical finding. */
export const PacketFindingSummary = Schema.Union([
  Schema.TaggedStruct("Pending", { revision: Id, sheetId: Schema.NullOr(SheetId) }),
  Schema.TaggedStruct("Ready", {
    revision: Id,
    sheetId: Schema.NullOr(SheetId),
    ...FindingSummaryText.fields,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

/** The reviewer's call on a finding. Every value except `valid` dismisses it. */
export const PacketFindingVerdict = Schema.Literals([
  "valid",
  "false_alarm",
  "not_applicable",
  "duplicate",
]);

/** Labels shared by the workbench and the HTML report. */
export const packetVerdictLabels = {
  valid: "Valid",
  false_alarm: "False alarm",
  not_applicable: "Not applicable",
  duplicate: "Duplicate",
} as const satisfies Record<typeof PacketFindingVerdict.Type, string>;

/** Reviewer-owned; follow-up reviews read the reason so a dismissed issue is not raised again. */
export const PacketFindingDecision = Schema.Struct({
  verdict: PacketFindingVerdict,
  reason: Text.check(Schema.isMaxLength(2000)),
  decidedAt: Schema.Finite,
});

const FocusPixels = Schema.Struct({
  left: Schema.Finite,
  top: Schema.Finite,
  right: Schema.Finite,
  bottom: Schema.Finite,
});

/**
 * Host-rendered zoom of a finding's problem area, segmented by SAM from the finding region.
 * Pixels refer to the zoom artifact. Segments are geometry proposals, never verified symbols.
 */
export const PacketFindingFocus = Schema.Struct({
  artifactId: ArtifactId,
  sheetId: SheetId,
  region: Region,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  box: FocusPixels,
  model: Schema.Literal("sam-3.1"),
  responseId: Schema.NonEmptyString,
  segments: Schema.Array(
    Schema.Struct({
      confidence: Schema.NullOr(Schema.Finite),
      bounds: FocusPixels,
      mask: Schema.Struct({
        encoding: Schema.Literals(["one_bit", "lossless"]),
        payload: Schema.String.check(Schema.isMaxLength(65536)),
        width: Schema.Int.check(Schema.isGreaterThan(0)),
        height: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    }),
  ).check(Schema.isMaxLength(8)),
});

/** General review issues retain evidence and remain distinct from reviewer completion tracking. */
export const PacketFinding = Schema.Struct({
  id: Id,
  title: Required,
  discipline: ReviewDiscipline,
  severity: Schema.Literals(["Critical", "Major", "Minor"]),
  status: Schema.Literals(["Confirmed", "Needs input"]),
  classification: Schema.Literals([
    "Code",
    "Permit condition",
    "Agency request",
    "Drawing conflict",
    "Recommendation",
  ]),
  locations: Schema.Array(
    Schema.Struct({ sheetId: SheetId, detail: Required, region: Schema.NullOr(Region) }),
  ),
  observed: Required,
  correction: Required,
  evidenceIds: Schema.Array(ArtifactId),
  evidenceNote: Text,
  citationIds: Schema.Array(Id),
  calculationIds: Schema.Array(Id),
  priorCommentId: Schema.NullOr(Id),
  completed: Schema.Boolean,
  /** Host-owned presentation state; full technical fields above are never shortened. */
  summary: Schema.optionalKey(PacketFindingSummary),
  decision: Schema.optionalKey(PacketFindingDecision),
  /** Missing-content claims retain the complete source search and contradiction check. */
  absenceCheck: Schema.optionalKey(
    Schema.Struct({
      searchedSheetIds: Schema.Array(SheetId),
      searchDescription: Required,
      contradictingEvidence: Text,
      permitStageBasis: Required,
    }),
  ),
  /** Host-owned SAM zoom of the first focused location; the model cannot set it. */
  focus: Schema.optionalKey(PacketFindingFocus),
});

/** Present the validated summary when available, retaining historical findings verbatim. */
export function packetFindingText(
  finding: typeof PacketFinding.Type,
): Pick<typeof PacketFinding.Type, "title" | "observed" | "correction"> {
  return finding.summary?._tag === "Ready" ? finding.summary : finding;
}

/** Prior comments require source-based closure independently of a user's completion checkbox. */
export const PacketPriorComment = Schema.Struct({
  id: Id,
  agency: Text,
  date: Text,
  number: Text,
  comment: Required,
  response: Text,
  changedSources: Text,
  status: Schema.Literals(["Open", "Partly resolved", "Resolved", "Superseded"]),
  evidenceIds: Schema.Array(ArtifactId),
  /** Host-owned revision target; unchanged follow-ups cannot replace it with baseline evidence. */
  revisionTargetSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
});

/** The firm's own review checklist. Each save is a new revision; reviews keep the one they started with. */
export const FirmChecklist = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Text.check(Schema.isMaxLength(12000)),
  savedAt: Schema.Finite,
});

/** Earlier reviews in the same state or locality whose sources and comments were offered as leads. */
export const PacketJurisdictionLeads = Schema.Struct({
  jurisdiction: Text,
  reviews: Schema.Array(
    Schema.Struct({
      reviewId: Id,
      projectName: Schema.String,
      jurisdiction: Text,
      match: Schema.Literals(["locality", "state"]),
    }),
  ),
  sources: Schema.Int,
  citations: Schema.Int,
  editions: Schema.Int,
  agencyComments: Schema.Int,
});

/** Frozen source inventory identifies the exact PDF revision reviewed. */
export const PacketSheet = Schema.Struct({
  id: SheetId,
  revisionId: Id,
  label: Schema.String,
  pageIndex: Schema.Int,
  box: Region,
  sha256: Schema.String,
  documentName: Schema.String,
  discipline: Schema.optionalKey(Schema.NullOr(ReviewDiscipline)),
});

/** Host-admitted tool names; model arguments and provider errors never enter activity telemetry. */
export const PacketActivityTool = Schema.Literals([
  "inventory_packet",
  "render_sheet",
  "search_sources",
  "search_code",
  "read_source",
  "calculate",
  "record_project",
  "record_coverage",
  "record_coverage_batch",
  "record_citation",
  "record_finding",
  "record_finding_summary",
  "record_prior_comment",
  "ask_reviewer",
  "finish_setup",
  "finish_review",
  "finish_sheet",
  "segment_objects",
]);

/** Bounded host stages describe actual tool work independently of model reasoning. */
export const PacketActivityStage = Schema.Literals([
  "inventory",
  "rendering",
  "research",
  "calculation",
  "recording",
  "segmentation",
]);

/** Human-readable labels are controlled by the application rather than model output. */
export const packetActivityStageLabels = {
  inventory: "Reading drawing inventory",
  rendering: "Rendering drawing",
  research: "Checking sources",
  calculation: "Calculating",
  recording: "Recording review",
  segmentation: "Segmenting drawing objects",
} as const satisfies Record<typeof PacketActivityStage.Type, string>;

/** One host-owned tool activity, retaining completion so subsequent inference is not labelled active. */
export const PacketActivity = Schema.Struct({
  id: Id,
  tool: PacketActivityTool,
  stage: PacketActivityStage,
  sheetId: Schema.optionalKey(SheetId),
  sheetLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  status: Schema.Literals(["active", "finished"]),
  startedAt: Schema.Finite,
  finishedAt: Schema.NullOr(Schema.Finite),
});

/** What one sheet reviewer hands the coordinator for cross-sheet comparison. */
export const PacketSheetNotes = Schema.Struct({
  summary: Required,
  keyFacts: Schema.Array(Required).check(Schema.isMaxLength(100)),
  crossReferences: Schema.Array(Required).check(Schema.isMaxLength(100)),
  suspectedGaps: Schema.Array(Required).check(Schema.isMaxLength(100)),
});

/** Prompt tokens across completed model calls. `input` excludes cached tokens. */
export const PacketPromptUsage = Schema.Struct({
  calls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheRead: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Share of prompt tokens served from the provider cache, or null before any prompt tokens. */
export const cachedPromptShare = (usage: typeof PacketPromptUsage.Type | undefined) =>
  usage === undefined || usage.input + usage.cacheRead === 0
    ? null
    : usage.cacheRead / (usage.input + usage.cacheRead);

/** One sheet reviewer in a parallel review; notes carry its facts to the cross-sheet coordinator. */
export const PacketSheetReview = Schema.Struct({
  sheetId: SheetId,
  /** Pi conversation number inside this review's journal; null until the reviewer starts. */
  conversationId: Schema.NullOr(Schema.Int),
  state: Schema.Literals(["queued", "running", "completed", "failed"]),
  notes: Schema.optionalKey(PacketSheetNotes),
  providerFailure: Schema.optionalKey(ProviderFailure),
  promptUsage: Schema.optionalKey(PacketPromptUsage),
});

/** Project facts fixed when coordinator setup ends; every sheet reviewer's opening is built from them. */
export const PacketSetup = Schema.Struct({
  /** Sheets the coordinator opened in setup; before coordination it may reopen only these. */
  sheetIds: Schema.Array(SheetId),
  projectConfiguration: Schema.Record(Schema.String, Schema.String),
  sources: Schema.Array(
    Schema.Struct({
      id: PacketSource.fields.id,
      url: PacketSource.fields.url,
      title: PacketSource.fields.title,
    }),
  ),
});

/** Large reviews split into coordinator setup, concurrent sheet reviewers and cross-sheet coordination. */
export const PacketParallelReview = Schema.Struct({
  stage: Schema.Literals(["setup", "sheets", "coordination"]),
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  sheets: Schema.Array(PacketSheetReview),
  setup: Schema.optionalKey(PacketSetup),
});

/** Durable packet progress and report data sent to the trusted workbench. */
export class PacketReview extends Schema.Class<PacketReview>("PacketReview")({
  id: Id,
  projectId: ProjectId,
  projectName: Schema.String,
  conversationId: ConversationId,
  requestId: Id,
  request: Required,
  scope: PacketScope,
  model: ReviewModelId,
  provider: Schema.Literals(["meta", "baseten"]),
  state: Schema.Literals(["running", "paused", "completed", "cancelled", "failed", "uncertain"]),
  version: Schema.Int,
  startedAt: Schema.Number,
  changedAt: Schema.Number,
  /** Active work excludes paused, failed and cancelled waiting time. */
  activeDurationMs: Schema.optionalKey(Schema.Number),
  activeSince: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  providerFailure: Schema.optionalKey(Schema.NullOr(ProviderFailure)),
  activity: Schema.optionalKey(Schema.NullOr(PacketActivity)),
  maxCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  admittedCalls: Schema.Int,
  promptUsage: Schema.optionalKey(PacketPromptUsage),
  promptVersion: Schema.String,
  instructionRevision: Schema.String,
  /** Set when the reviewer's request is a versioned preset, such as the Initial Review button's. */
  preset: Schema.optionalKey(ReviewPreset),
  sheets: Schema.Array(PacketSheet),
  inspectedSheetIds: Schema.Array(SheetId),
  baselineSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  inspectedThisReviewSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  detailInspectedSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  /** Sheets with a completed segment_objects call in this review; device counts require one. */
  segmentedSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  evidenceIds: Schema.Array(ArtifactId),
  steering: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        commandId: CommandId,
        text: Required,
        status: Schema.Literals(["pending", "queued", "applied", "unanswered"]),
      }),
    ),
  ),
  conversationContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ role: Schema.Literals(["reviewer", "application"]), text: Text })),
  ),
  projectConfiguration: Schema.Record(Schema.String, Schema.String),
  /** The firm checklist in effect when this review started; absent when none was saved. */
  firmChecklist: Schema.optionalKey(
    Schema.Struct({ revision: FirmChecklist.fields.revision, text: FirmChecklist.fields.text }),
  ),
  jurisdictionLeads: Schema.optionalKey(PacketJurisdictionLeads),
  coverage: Schema.Array(PacketCoverage),
  sources: Schema.Array(PacketSource),
  citations: Schema.Array(PacketCitation),
  calculations: Schema.Array(PacketCalculation),
  findings: Schema.Array(PacketFinding),
  priorComments: Schema.Array(PacketPriorComment),
  summary: Text,
  missingInputs: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  finished: Schema.Boolean,
  parallel: Schema.optionalKey(PacketParallelReview),
}) {}

/** Operational limits are optional; model context and output capabilities come from its catalog. */
export const StartPacketReview = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  conversationId: ConversationId,
  messageId: Id,
  model: ReviewModelId,
  discipline: ReviewDisciplineSelection,
  selection: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.Literals(["whole_set", "selected_sheets", "discipline"]),
      revisionId: Id,
      sheetIds: Schema.Array(SheetId),
    }),
  ),
  maxCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The saved message is this preset's exact text; the review records the identity. */
  preset: Schema.optionalKey(ReviewPreset),
});

/** An idempotent instruction for the same conversation and its active durable review. */
export const SteerPacketReview = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  reviewId: Id,
  conversationId: ConversationId,
  text: Required,
});

/** Packet request, durable progress, explicit controls and user-owned completion. */
export class PacketReviewRpc extends RpcGroup.make(
  Rpc.make("SteerPacketReview", {
    payload: SteerPacketReview,
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("StartPacketReview", {
    payload: StartPacketReview,
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("ListPacketReviews", {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: Schema.Array(PacketReview),
    error: ExecutionError,
  }),
  Rpc.make("GetPacketReview", {
    payload: Schema.Struct({ projectId: ProjectId, reviewId: Id }),
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("ObservePacketReviews", {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: PacketReview,
    error: ExecutionError,
    stream: true,
  }),
  Rpc.make("ControlPacketReview", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Id,
      expectedVersion: Schema.Int,
      action: Schema.Literals(["pause", "resume", "cancel"]),
      maxCalls: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
      commandId: CommandId,
    }),
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("CompletePacketFinding", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Id,
      findingId: Id,
      completed: Schema.Boolean,
      expectedVersion: Schema.Int,
    }),
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("DecidePacketFinding", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Id,
      findingId: Id,
      /** Null clears an earlier decision. */
      decision: Schema.NullOr(
        Schema.Struct({
          verdict: PacketFindingVerdict,
          reason: PacketFindingDecision.fields.reason,
        }),
      ),
      expectedVersion: Schema.Int,
    }),
    success: PacketReview,
    error: ExecutionError,
  }),
  Rpc.make("GetFirmChecklist", {
    payload: Schema.Struct({}),
    success: Schema.NullOr(FirmChecklist),
    error: ExecutionError,
  }),
  Rpc.make("SaveFirmChecklist", {
    payload: Schema.Struct({
      text: FirmChecklist.fields.text,
      /** The revision the reviewer edited; 0 before the first save. */
      expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    success: FirmChecklist,
    error: ExecutionError,
  }),
) {}
