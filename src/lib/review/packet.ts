import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ArtifactId, CommandId, ConversationId, ProjectId, Region, SheetId } from "./contracts.ts";
import {
  routeReviewDiscipline,
  ExecutionError,
  ReviewDiscipline,
  ReviewDisciplineSelection,
} from "./execution.ts";
import { ReviewModelId } from "./models.ts";

const Text = Schema.Trim.check(Schema.isMaxLength(32000));
const Required = Text.check(Schema.isMinLength(1));
const Id = Schema.String.check(Schema.isUUID());

/** Independent document and discipline review, without a pre-existing count finding. */
export const PacketScope = Schema.Union([
  Schema.TaggedStruct("WholeSet", {}),
  Schema.TaggedStruct("Discipline", { discipline: ReviewDiscipline }),
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
});

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

/** Frozen source inventory identifies the exact PDF revision reviewed. */
export const PacketSheet = Schema.Struct({
  id: SheetId,
  revisionId: Id,
  label: Schema.String,
  pageIndex: Schema.Int,
  box: Region,
  sha256: Schema.String,
  documentName: Schema.String,
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
  maxCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  admittedCalls: Schema.Int,
  promptVersion: Schema.String,
  instructionRevision: Schema.String,
  sheets: Schema.Array(PacketSheet),
  inspectedSheetIds: Schema.Array(SheetId),
  baselineSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  inspectedThisReviewSheetIds: Schema.optionalKey(Schema.Array(SheetId)),
  evidenceIds: Schema.Array(ArtifactId),
  conversationContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ role: Schema.Literals(["reviewer", "application"]), text: Text })),
  ),
  projectConfiguration: Schema.Record(Schema.String, Schema.String),
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
}) {}

/** Operational limits are optional; model context and output capabilities come from its catalog. */
export const StartPacketReview = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  conversationId: ConversationId,
  messageId: Id,
  model: ReviewModelId,
  discipline: ReviewDisciplineSelection,
  maxCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});

/** Packet request, durable progress, explicit controls and user-owned completion. */
export class PacketReviewRpc extends RpcGroup.make(
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
) {}
