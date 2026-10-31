import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  PubSub,
  Redacted,
  Match,
  Option,
  Schema,
  Semaphore,
  Stream,
  Struct,
} from "effect";
import { SqlClient } from "effect/sql";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { rename, rm, writeFile } from "node:fs/promises";
import {
  CommandId,
  CommandReceipt,
  OperationId,
  ProjectId,
  Region,
  ReviewMessage,
  SheetId,
} from "#lib/review/contracts.ts";
import { ExecutionError, ReviewDiscipline, type ProviderFailure } from "#lib/review/execution.ts";
import { transformRegion } from "#lib/review/geometry.ts";
import {
  PacketReview,
  PacketScope,
  SteerPacketReview,
  PacketCoverage,
  PacketCitation,
  PacketFinding,
  PacketFindingSummary,
  FirmChecklist,
  type PacketFindingDecision,
  PacketPriorComment,
  PacketSheetNotes,
  type PacketPromptUsage,
  type PacketSource,
  type PacketSheetReview,
  StartPacketReview,
  selectPacketReviewScope,
  type PacketActivityTool,
  type PacketActivityStage,
} from "#lib/review/packet.ts";
import { reviewModels } from "#lib/review/models.ts";
import { initialReview } from "#lib/review/initial-review.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import type { createReviewOperations } from "../review/operations.ts";
import type { ExecutionImage } from "../review/execution-port.ts";
import { executionPersistence } from "../review/execution-store.ts";
import {
  createAdmittedModels,
  promptCacheKey,
  reviewModelCapabilities,
  type ProviderConfiguration,
} from "../inference/provider.ts";
import { openReviewJournal, journalFormat } from "../inference/journal.ts";
import { ResponseReceipt } from "../inference/response.ts";
import {
  packetReviewPrompt,
  packetPromptVersion,
  reviewInstructionRevision,
} from "../review/prompts/review-prompt.ts";
import { calculate, CalculationInput } from "./calculations.ts";
import { readSource, searchSources, sourceKey } from "./sources.ts";
import {
  assertAssignedSheet,
  assertPermitted,
  assertSetupSheet,
  defaultSetupLimits,
  permits,
  toolRole,
  type PacketToolRole,
  type SetupLimits,
} from "./capabilities.ts";
import { renderPacketReport } from "./report.ts";
import { SamInspectionRequest } from "#lib/review/segmentation.ts";
import { preparePacketSamRequest, decodePacketSamFocus, decodePacketSamResponse } from "./sam.ts";
import { citationHasSourceSupport } from "./citations.ts";
import { FindingSummaryText, RecordFindingSummary } from "#lib/review/finding-summary.ts";
import { EarlierReview, jurisdictionHistory, jurisdictionValue } from "./jurisdiction.ts";
import {
  codeIndexVersion,
  codeReference,
  floridaCodeIndex,
  searchCodeReferences,
} from "../review/code-index/code-index.ts";
import {
  initializePacketCoverage,
  packetCoverageProgress,
  samePacketSheetSource,
} from "#lib/review/packet-coverage.ts";

const promptVersion = packetPromptVersion;

/**
 * Three-sheet reviews finished as one conversation on 2026-10-29; a 29-sheet review recorded
 * 220 of 1,276 checks in 33 minutes. Run in parallel at 16 sheets, it recorded all 1,276 using
 * about 1.5M of Meta's 4M tokens a minute, so Meta reviews start every sheet at once. The Baseten
 * key allows 100 requests and 2M tokens a minute (2026-10-31); 16 sheet reviewers send about 40
 * requests a minute, and the shared request pacer holds any burst inside the limit.
 */
export const defaultParallel = {
  minSheets: 4,
  concurrency: { meta: 32, baseten: 16 },
  setup: defaultSetupLimits,
} as const;

/** Which conversation made each model or SAM request, and which sheet each sheet reviewer owns. */
interface SheetAssignments {
  readonly sheets: Map<number, typeof SheetId.Type>;
  readonly requests: Map<number, number>;
  /** Model requests on the wire in this process. They stay uncertain in SQL until they settle. */
  readonly inFlight: Set<string>;
  /** Settles when a sheet reviewer's first model request ends, so its prompt prefix is cached. */
  readonly warmed: PromiseWithResolvers<void>;
}

/**
 * Sheet reviewers share their instructions, tools and project context. Peers wait this long at
 * most for the first reviewer's opening request to cache that prefix.
 */
const prefixWarmupMs = 90_000;

/** Add one completed response's token usage to a running total. */
const addPromptUsage = (
  total: typeof PacketPromptUsage.Type | undefined,
  usage: { readonly input: number; readonly cacheRead: number; readonly output: number },
): typeof PacketPromptUsage.Type => ({
  calls: (total?.calls ?? 0) + 1,
  input: (total?.input ?? 0) + usage.input,
  cacheRead: (total?.cacheRead ?? 0) + usage.cacheRead,
  output: (total?.output ?? 0) + usage.output,
});

const attemptKey = (taskId: number, attempt: number) => `${taskId}:${attempt}`;

/** Admission's answer when coordinator setup has used its request limit. */
const setupEnded = Symbol("setupEnded");

const ReceiptUsage = Schema.fromJsonString(
  Schema.Struct({
    usage: Schema.Struct({ input: Schema.Finite, cacheRead: Schema.Finite, output: Schema.Finite }),
  }),
);

const UnresolvedAttempts = Schema.Array(
  Schema.Struct({ task_id: Schema.Int, attempt: Schema.Int }),
);

/**
 * Each parallel reviewer owns its transcript, so only an unresolved attempt in the same
 * conversation could be resent. An unknown owner or requester stays blocking.
 */
const blocksRequest = (
  assignments: SheetAssignments,
  unresolved: typeof UnresolvedAttempts.Type,
  conversation: number | undefined,
) =>
  unresolved.some((attempt) => {
    if (assignments.inFlight.has(attemptKey(attempt.task_id, attempt.attempt))) return false;
    const owner = assignments.requests.get(attempt.task_id);

    return owner === undefined || conversation === undefined || owner === conversation;
  });

type SheetChange = Partial<
  Pick<
    typeof PacketSheetReview.Type,
    "conversationId" | "state" | "notes" | "providerFailure" | "promptUsage"
  >
>;

/** Change one sheet reviewer's record; a review without parallel stages is unchanged. */
const changeSheet = (review: PacketReview, sheetId: string, change: SheetChange) =>
  review.parallel === undefined
    ? review
    : new PacketReview(
        Struct.assign(review, {
          parallel: {
            ...review.parallel,
            sheets: review.parallel.sheets.map((entry) =>
              entry.sheetId === sheetId ? { ...entry, ...change } : entry,
            ),
          },
        }),
      );

/** Advance a parallel review from its sheet stage to coordination. */
const changeStage = (review: PacketReview, stage: "coordination") =>
  review.parallel === undefined
    ? review
    : new PacketReview(Struct.assign(review, { parallel: { ...review.parallel, stage } }));

/** The project facts and sources every sheet reviewer starts from, as setup left them. */
const setupSnapshot = (review: PacketReview) => ({
  sheetIds: review.inspectedThisReviewSheetIds ?? [],
  projectConfiguration: review.projectConfiguration,
  sources: review.sources.map(({ id, url, title }) => ({ id, url, title })),
});

/**
 * End coordinator setup and fix its snapshot. Sheet reviewers' openings are built from the snapshot,
 * so a peer's later source or a steered configuration change cannot alter their shared prefix.
 */
const startSheets = (review: PacketReview) =>
  review.parallel?.stage !== "setup"
    ? review
    : new PacketReview(
        Struct.assign(review, {
          parallel: { ...review.parallel, stage: "sheets" as const, setup: setupSnapshot(review) },
        }),
      );

// A technical finding written after finish_sheet requires fresh presentation and notes.
const invalidateSheetNotes = (review: PacketReview, sheetId: string) =>
  review.parallel === undefined
    ? review
    : new PacketReview({
        ...review,
        parallel: {
          ...review.parallel,
          sheets: review.parallel.sheets.map((entry) =>
            entry.sheetId === sheetId
              ? {
                  ...Struct.omit(entry, ["notes"]),
                  state: entry.state === "completed" ? ("running" as const) : entry.state,
                }
              : entry,
          ),
        },
      });

const error = (reason: ExecutionError["reason"], message: string) =>
  new ExecutionError({ reason, message });

const Row = Schema.Struct({
  id: Schema.String,
  project_id: ProjectId,
  conversation_id: Schema.String,
  command_id: CommandId,
  fingerprint: Schema.String,
  source_version: Schema.Int,
  owner_generation: Schema.String,
  journal_id: Schema.String,
  engine: Schema.String,
  payload: Schema.fromJsonString(PacketReview),
});

type Row = typeof Row.Type;

const Attempt = Schema.Struct({
  fingerprint: Schema.String,
  status: Schema.Literals(["uncertain", "completed"]),
  sent: Schema.Int,
  response_json: Schema.NullOr(Schema.String),
});

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32000));
const Id = Schema.String.check(Schema.isUUID());
const ToolResult = Schema.Struct({ value: Schema.Json });
const PriorCommentInput = PacketPriorComment.mapFields(Struct.omit(["revisionTargetSheetIds"]));

const ChecklistRow = Schema.Struct({
  revision: Schema.Int,
  text: Schema.String,
  saved_at: Schema.Finite,
});

const deviceNoun =
  "(?:receptacles?|outlets?|luminaires?|light(?:ing)? fixtures?|fixtures?|lights?|switch(?:es)?|sprinkler heads?|sprinklers?|diffusers?|detectors?|devices?|water closets?|lavator(?:y|ies)|urinals?|sinks?)";

// "One receptacle" usually identifies a device, so spelled quantities start at two.
const quantity =
  "(?:\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|a dozen)";

// Room, circuit, sheet and code-section numbers before a device noun are identifiers, not counts.
const deviceCount = new RegExp(
  `\\b(?:(?:counts?|quantit(?:y|ies)|qty|number) of (?:[\\w-]+ ){0,3}${deviceNoun}|${deviceNoun} (?:counts?|quantit(?:y|ies)|totals?)|(?<!(?:room|rm|circuit|ckt|panel|sheet|detail|note|section|level|floor|unit|suite|type|no)\\.? |[\\d.#-])${quantity} (?:[\\w-]+ ){0,2}${deviceNoun})\\b`,
  "i",
);

/** Whether a finding states a drawn device or fixture count, which SAM should help establish. */
export const claimsDeviceCount = (text: string) => deviceCount.test(text);

/** SAM masks are for the reviewer's view; model-facing findings omit them. */
const withoutFocus = (findings: PacketReview["findings"]) =>
  findings.map((finding) => Struct.omit(finding, ["focus"]));

const clip = (region: Region, box: Region) => {
  const x = Math.max(region.x, box.x);
  const y = Math.max(region.y, box.y);
  const width = Math.min(region.x + region.width, box.x + box.width) - x;
  const height = Math.min(region.y + region.height, box.y + box.height) - y;

  return width > 0 && height > 0 ? new Region({ x, y, width, height }) : undefined;
};

/** A finding zoom covers its first location region that is at most half of its sheet. */
const focusTarget = (
  locations: (typeof PacketFinding.Type)["locations"],
  sheets: PacketReview["sheets"],
) =>
  locations.flatMap((location) => {
    const sheet = sheets.find((item) => item.id === location.sheetId);
    const region = sheet && location.region && clip(location.region, sheet.box);

    return sheet && region && region.width * region.height * 2 <= sheet.box.width * sheet.box.height
      ? [{ sheet, region }]
      : [];
  })[0];

// Both technical text and its display summary use the same missing-content evidence gate.
const requireAbsenceSupport = (
  review: PacketReview,
  finding: Pick<typeof PacketFinding.Type, "title" | "observed" | "locations" | "absenceCheck">,
) => {
  const claimsAbsence =
    /\b(?:missing|absent|omitted|not (?:provided|supplied|included|shown|present|located|found)|(?:could|can) ?not (?:locate|find)|unable to (?:locate|find)|lacks|lacking|truncated|clipped|cut off|does not (?:contain|include|show)|no .{0,70}(?:provided|shown|included|calculations?|matri(?:x|ces)|schedules?|tables?))\b/i.test(
      `${finding.title} ${finding.observed}`,
    );

  if (claimsAbsence) {
    const check = finding.absenceCheck;

    if (
      !check ||
      review.sheets.some(
        (sheet) =>
          !check.searchedSheetIds.includes(sheet.id) ||
          !(review.inspectedThisReviewSheetIds ?? []).includes(sheet.id),
      )
    )
      throw error(
        "input",
        "Before claiming missing content, inspect every frozen source page in this review and provide absenceCheck with searchedSheetIds, searchDescription, contradictingEvidence and permitStageBasis. Read calculations, schedules and matrices at detail scale; otherwise record Needs input without claiming absence.",
      );

    if (
      !finding.locations.some((location) =>
        (review.detailInspectedSheetIds ?? []).includes(location.sheetId),
      )
    )
      throw error(
        "input",
        "A missing-content claim needs a targeted source detail inspection at its actual file and page location.",
      );

    if (check.contradictingEvidence.trim())
      throw error(
        "input",
        "Source content contradicts this absence claim. Describe the supplied content and any specific inadequacy instead of recording it as missing.",
      );
  }
};

const CitationInput = Schema.Struct({
  ...PacketCitation.mapFields(Struct.omit(["reference"])).fields,
  codeReferenceId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});

type Runtime = {
  harness: Harness;
  root: Conversation;
  /** Sheet reviewer conversations of a parallel review, keyed by Pi conversation number. */
  children: Map<number, Conversation>;
  /** Marked before the harness closes, so a replaced run stops recording sheet progress. */
  lease: { closed: boolean };
  done: Promise<void>;
  steering: {
    accepting: boolean;
    pending: Set<Promise<void>>;
    unanswered: boolean;
    admissions: Map<string, { identity: string; result: Promise<PacketReview> }>;
  };
};

interface Configuration {
  readonly owner: DataDirectoryOwnership["Service"];
  readonly queries: Semaphore.Semaphore;
  readonly review: ReturnType<typeof createReviewOperations>;
  readonly providers: ReadonlyArray<ProviderConfiguration>;
  /** Packets with at least minSheets sheets review each sheet in its own conversation. */
  readonly parallel?: {
    readonly minSheets: number;
    readonly concurrency: Readonly<Record<"meta" | "baseten", number>>;
    /** Coordinator setup's sheet and request limits; defaults to `defaultSetupLimits`. */
    readonly setup?: SetupLimits;
  };
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
}

/** Project-first durable Moke reviews, with frozen source inventory and persistent tool records. */
export class PacketReviews extends Context.Service<
  PacketReviews,
  {
    readonly steer: (
      input: typeof SteerPacketReview.Type,
    ) => Effect.Effect<PacketReview, ExecutionError>;
    readonly start: (
      input: typeof StartPacketReview.Type,
    ) => Effect.Effect<PacketReview, ExecutionError>;
    readonly list: (
      projectId: typeof ProjectId.Type,
    ) => Effect.Effect<ReadonlyArray<PacketReview>, ExecutionError>;
    readonly get: (
      projectId: typeof ProjectId.Type,
      reviewId: string,
    ) => Effect.Effect<PacketReview, ExecutionError>;
    readonly observe: (
      projectId: typeof ProjectId.Type,
    ) => Stream.Stream<PacketReview, ExecutionError>;
    readonly control: (input: {
      projectId: typeof ProjectId.Type;
      reviewId: string;
      expectedVersion: number;
      action: "pause" | "resume" | "cancel";
      maxCalls?: number | null;
      commandId: typeof CommandId.Type;
    }) => Effect.Effect<PacketReview, ExecutionError>;
    readonly complete: (input: {
      projectId: typeof ProjectId.Type;
      reviewId: string;
      findingId: string;
      completed: boolean;
      expectedVersion: number;
    }) => Effect.Effect<PacketReview, ExecutionError>;
    readonly decide: (input: {
      projectId: typeof ProjectId.Type;
      reviewId: string;
      findingId: string;
      decision: Pick<typeof PacketFindingDecision.Type, "verdict" | "reason"> | null;
      expectedVersion: number;
    }) => Effect.Effect<PacketReview, ExecutionError>;
    readonly checklist: Effect.Effect<typeof FirmChecklist.Type | null, ExecutionError>;
    readonly saveChecklist: (input: {
      text: string;
      expectedRevision: number;
    }) => Effect.Effect<typeof FirmChecklist.Type, ExecutionError>;
    readonly exportReport: (
      projectId: typeof ProjectId.Type,
      reviewId: string,
      destination: string,
    ) => Effect.Effect<void, ExecutionError>;
    readonly close: Effect.Effect<boolean, ExecutionError>;
    readonly quiesce: Effect.Effect<void, ExecutionError>;
  }
>()("app/PacketReviews") {
  /** The parent owns the runtime, SQL semaphore and document services. */
  static layer(config: Configuration) {
    return Layer.effect(
      PacketReviews,
      Effect.gen(function* () {
        const store = executionPersistence(
          join(config.owner.canonicalDirectory, "app.sqlite"),
          config.queries,
        );

        const setupLimits = config.parallel?.setup ?? defaultSetupLimits;
        const updates = yield* PubSub.unbounded<PacketReview>();
        const runtimes = new Map<string, Runtime>();
        // Early finishes are returned to the reviewer a bounded number of times per review.
        const finishRejections = new Map<string, number>();
        const samControllers = new Map<string, Set<AbortController>>();
        const starting = new Map<string, Promise<void>>();
        let closing = false;
        const now = DateTime.toEpochMillis;
        let callbackEntry = config.runPromise;

        const run: Configuration["runPromise"] = (operation, options) =>
          callbackEntry(operation, options);

        const query = store.query;

        const asExecution = <A, E>(operation: Effect.Effect<A, E>) =>
          operation.pipe(
            Effect.mapError((cause) =>
              cause instanceof ExecutionError
                ? cause
                : error("input", "The review source or record is unavailable."),
            ),
          );

        const callback = <A>(work: () => Promise<A>) =>
          Effect.tryPromise({
            try: work,
            catch: (cause) =>
              cause instanceof ExecutionError
                ? cause
                : error("unavailable", "The review operation could not finish."),
          });

        const load = Effect.fn("PacketReviews.load")(function* (
          projectId: typeof ProjectId.Type,
          reviewId: string,
        ) {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
            yield* sql`SELECT * FROM packet_reviews WHERE id=${reviewId} AND project_id=${projectId}`,
          );

          if (!rows[0]) return yield* error("input", "This review is not in the selected project.");

          return rows[0];
        });

        const save = Effect.fn("PacketReviews.save")(function* (row: Row, value: PacketReview) {
          const sql = yield* SqlClient.SqlClient;

          const timestamp = now(yield* DateTime.now);
          const wasRunning = row.payload.state === "running";

          const activeDurationMs =
            row.payload.activeDurationMs ??
            (wasRunning ? 0 : Math.max(0, row.payload.changedAt - row.payload.startedAt));

          const activeSince =
            row.payload.activeSince ?? (wasRunning ? row.payload.startedAt : null);

          const next = new PacketReview({
            ...value,
            activity: value.state === "running" ? (value.activity ?? null) : null,
            activeDurationMs:
              activeDurationMs +
              (wasRunning && value.state !== "running" && activeSince !== null
                ? Math.max(0, timestamp - activeSince)
                : 0),
            activeSince: value.state === "running" ? (wasRunning ? activeSince : timestamp) : null,
            version: row.payload.version + 1,
            changedAt:
              value.state === row.payload.state && value.state !== "running"
                ? row.payload.changedAt
                : timestamp,
          });

          yield* sql`UPDATE packet_reviews SET payload=${JSON.stringify(next)} WHERE id=${row.id}`;

          return next;
        });

        const publish = (value: PacketReview) =>
          PubSub.publish(updates, value).pipe(Effect.as(value));

        const get = (projectId: typeof ProjectId.Type, reviewId: string) =>
          query(load(projectId, reviewId)).pipe(Effect.map((row) => row.payload));

        const list = (projectId: typeof ProjectId.Type) =>
          query(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
                yield* sql`SELECT * FROM packet_reviews WHERE project_id=${projectId} ORDER BY rowid DESC LIMIT 100`,
              );

              return rows.map((row) => row.payload);
            }),
          );

        const latestChecklist = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ChecklistRow))(
            yield* sql`SELECT revision,text,saved_at FROM firm_checklist_revisions ORDER BY revision DESC LIMIT 1`,
          );

          const row = rows[0];

          return row === undefined
            ? null
            : Schema.decodeUnknownSync(FirmChecklist)({
                revision: row.revision,
                text: row.text,
                savedAt: row.saved_at,
              });
        });

        const checklist = query(latestChecklist);

        /** Recent reviews from other conversations, without source text or coverage. */
        const earlierReviews = Effect.fn("PacketReviews.earlier")(function* (
          reviewId: string,
          conversationId: string,
        ) {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* sql`SELECT json_object(
              'id', id,
              'projectName', json_extract(payload,'$.projectName'),
              'changedAt', json_extract(payload,'$.changedAt'),
              'projectConfiguration', json(json_extract(payload,'$.projectConfiguration')),
              'sources', (SELECT json_group_array(json_object('url',json_extract(value,'$.url'),'title',json_extract(value,'$.title'),'status',json_extract(value,'$.status'),'official',json(CASE WHEN json_extract(value,'$.official') THEN 'true' ELSE 'false' END),'retrievedAt',json_extract(value,'$.retrievedAt'))) FROM json_each(payload,'$.sources')),
              'citations', (SELECT json_group_array(json_object('jurisdiction',json_extract(value,'$.jurisdiction'),'document',json_extract(value,'$.document'),'edition',json_extract(value,'$.edition'),'section',json_extract(value,'$.section'),'status',json_extract(value,'$.status'))) FROM json_each(payload,'$.citations')),
              'priorComments', (SELECT json_group_array(json_object('agency',json_extract(value,'$.agency'),'comment',json_extract(value,'$.comment'),'status',json_extract(value,'$.status'))) FROM json_each(payload,'$.priorComments'))
            ) AS review FROM packet_reviews
            WHERE id<>${reviewId} AND conversation_id<>${conversationId}
            ORDER BY rowid DESC LIMIT 200`;

          return yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ review: Schema.fromJsonString(EarlierReview) })),
          )(rows).pipe(Effect.map((decoded) => decoded.map((entry) => entry.review)));
        });

        const assertActive = Effect.fn("PacketReviews.admit")(function* (
          row: Row,
          drainAdmitted = false,
        ) {
          yield* asExecution(config.owner.assertHeld);

          if (
            closing ||
            row.owner_generation !== config.owner.generation ||
            (row.payload.state !== "running" && !(drainAdmitted && row.payload.state === "paused"))
          )
            return yield* error("cancelled", "This review is no longer running.");
          const sql = yield* SqlClient.SqlClient;

          const project =
            yield* sql`SELECT json_extract(payload,'$.sourceVersion') AS version FROM review_projects WHERE id=${row.project_id}`;

          const version = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ version: Schema.Int })),
          )(project);

          if (version[0]?.version !== row.source_version)
            return yield* error(
              "conflict",
              "The packet changed. Pause this review and start a review of the updated documents.",
            );
        });

        const settleInterrupted = Effect.fn("PacketReviews.interrupted")(function* (row: Row) {
          const sql = yield* SqlClient.SqlClient;

          const unresolved =
            yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain' LIMIT 1`;

          const state = unresolved.length ? "uncertain" : "paused";

          const message = unresolved.length
            ? "A request was interrupted with an unresolved outcome. It will not be sent again."
            : "Review paused. Resume explicitly to continue.";

          if (row.payload.state === state && row.payload.error !== null) return row.payload;

          return yield* save(row, new PacketReview({ ...row.payload, state, error: message }));
        });

        const mutate = (
          projectId: typeof ProjectId.Type,
          reviewId: string,
          transform: (value: PacketReview) => PacketReview,
          active = true,
        ) =>
          query(
            Effect.gen(function* () {
              const row = yield* load(projectId, reviewId);

              if (active) yield* assertActive(row);

              const next = yield* Effect.try({
                try: () => transform(row.payload),
                catch: (cause) =>
                  cause instanceof ExecutionError
                    ? cause
                    : error("input", "The review update is invalid."),
              });

              return next === row.payload ? next : yield* save(row, next);
            }),
          ).pipe(Effect.flatMap(publish));

        const receipt = (row: Row, taskId: number, attempt: number) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return (yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
              yield* sql`SELECT fingerprint,status,sent,response_json FROM packet_review_attempts WHERE review_id=${row.id} AND task_id=${taskId} AND attempt=${attempt} AND kind='model'`,
            ))[0];
          });

        const appendMessage = Effect.fn("PacketReviews.message")(function* (
          row: Row,
          text: string,
        ) {
          const sql = yield* SqlClient.SqlClient;

          const commandId = Schema.decodeUnknownSync(CommandId)(stableId(row.id, 0, "reply"));
          const fingerprint = JSON.stringify(["packet-reply", row.id, text]);

          const previous =
            yield* sql`SELECT fingerprint FROM review_commands WHERE command_id=${commandId}`;

          const saved = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ fingerprint: Schema.String })),
          )(previous);

          if (saved[0]) {
            if (saved[0].fingerprint !== fingerprint)
              return yield* error("conflict", "The final response identity changed.");

            return;
          }

          const versions = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ version: Schema.Int })),
          )(yield* sql`SELECT version FROM review_projects WHERE id=${row.project_id}`);

          const message = new ReviewMessage({
            id: stableId(row.id, 0, "reply-message"),
            projectId: row.project_id,
            conversationId: Schema.decodeUnknownSync(StartPacketReview.fields.conversationId)(
              row.conversation_id,
            ),
            role: "application",
            text,
            createdAt: new Date(now(yield* DateTime.now)).toISOString(),
          });

          yield* sql`INSERT INTO review_records(project_id,id,kind,payload) VALUES (${row.project_id},${message.id},'message',${JSON.stringify(message)})`;
          yield* sql`UPDATE review_projects SET version=version+1,payload=json_set(payload,'$.version',version+1) WHERE id=${row.project_id}`;

          const receipt = new CommandReceipt({
            commandId,
            projectId: row.project_id,
            entityId: message.id,
            version: (versions[0]?.version ?? 0) + 1,
          });

          yield* sql`INSERT INTO review_commands(command_id,project_id,fingerprint,receipt) VALUES (${commandId},${row.project_id},${fingerprint},${JSON.stringify(receipt)})`;
          yield* sql`INSERT INTO review_events(project_id,command_id,kind,message,created_at) VALUES (${row.project_id},${commandId},'packet_review','MOKE review response saved.',${message.createdAt})`;
        });

        const recordTool = async (
          row: Row,
          taskId: number,
          operation: string,
          transform: (review: PacketReview) => PacketReview,
          value: Schema.Json,
        ) => {
          const result = await run(
            query(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;

                const previous =
                  yield* sql`SELECT result_json FROM packet_review_tools WHERE review_id=${row.id} AND task_id=${taskId} AND operation=${operation}`;

                const decoded = yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ result_json: Schema.fromJsonString(ToolResult) })),
                )(previous);

                if (decoded[0])
                  return {
                    review: (yield* load(row.project_id, row.id)).payload,
                    value: decoded[0].result_json.value,
                  };
                const current = yield* load(row.project_id, row.id);
                yield* assertActive(current);

                const next = yield* Effect.try({
                  try: () => transform(current.payload),
                  catch: (cause) =>
                    cause instanceof ExecutionError
                      ? cause
                      : error("input", "The review tool update is invalid."),
                });

                const review = yield* save(current, next);
                const result = Schema.decodeUnknownSync(ToolResult)({ value });
                yield* sql`INSERT INTO packet_review_tools(review_id,task_id,operation,result_json) VALUES (${row.id},${taskId},${operation},${JSON.stringify(result)})`;

                return { review, value: result.value };
              }),
            ),
          );

          await run(publish(result.review));

          return result.value;
        };

        const descriptor = (schema: Schema.Top) => {
          const doc = Schema.toJsonSchemaDocument(schema);

          return Type.Unsafe<unknown>({ ...doc.schema, $defs: doc.definitions });
        };

        const stableId = (reviewId: string, taskId: number, operation: string) => {
          const bytes = createHash("sha256").update(`${reviewId}:${taskId}:${operation}`).digest();
          bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
          bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
          const hex = bytes.subarray(0, 16).toString("hex");

          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        };

        const registryFor = (row: Row, assignments: SheetAssignments) => {
          const registry = createRegistry();
          // Images rendered since each conversation's latest model request.
          const imageCounts = new Map<number, number>();
          const nudged = new Set<number>();

          const outsideSheet = (
            conversationId: number,
            ...sheetIds: ReadonlyArray<string | null>
          ) => assertAssignedSheet(assignments.sheets.get(conversationId), sheetIds);

          const toolRoleOf = (review: PacketReview, conversationId: number) =>
            toolRole(review, assignments.sheets.get(conversationId));

          const stages = {
            inventory_packet: "inventory",
            render_sheet: "rendering",
            search_sources: "research",
            search_code: "research",
            read_source: "research",
            calculate: "calculation",
            record_project: "recording",
            record_coverage: "recording",
            record_coverage_batch: "recording",
            record_citation: "recording",
            record_finding: "recording",
            record_finding_summary: "recording",
            record_prior_comment: "recording",
            ask_reviewer: "recording",
            finish_setup: "recording",
            finish_review: "recording",
            finish_sheet: "recording",
            segment_objects: "segmentation",
          } as const satisfies Record<
            typeof PacketActivityTool.Type,
            typeof PacketActivityStage.Type
          >;

          /** Authorize a tool for its conversation's current role, then record its activity. */
          const withActivity = async <A>(
            taskId: number,
            conversationId: number,
            tool: typeof PacketActivityTool.Type,
            work: () => Promise<A>,
            sheet?: PacketReview["sheets"][number],
          ) => {
            const id = stableId(row.id, taskId, `activity:${tool}`);
            const startedAt = now(await run(DateTime.now));

            const activity = {
              id,
              tool,
              stage: stages[tool],
              status: "active" as const,
              startedAt,
              finishedAt: null,
            };

            const contextual =
              sheet === undefined
                ? activity
                : {
                    ...activity,
                    sheetId: sheet.id,
                    sheetLabel: (sheet.label || `Page ${sheet.pageIndex + 1}`).slice(0, 200),
                  };

            await run(
              mutate(row.project_id, row.id, (review) => {
                assertPermitted(toolRoleOf(review, conversationId), tool);

                return new PacketReview(Struct.assign(review, { activity: contextual }));
              }),
            );

            try {
              return await work();
            } finally {
              const finishedAt = now(await run(DateTime.now));
              await run(
                mutate(
                  row.project_id,
                  row.id,
                  (review) =>
                    review.activity?.id !== id || review.activity.status !== "active"
                      ? review
                      : new PacketReview(
                          Struct.assign(review, {
                            activity: {
                              ...review.activity,
                              status: "finished" as const,
                              finishedAt,
                            },
                          }),
                        ),
                  false,
                ),
              );
            }
          };

          const tool = <S extends Schema.Top & Schema.ConstraintCodec<unknown, unknown>, O>(
            name: typeof PacketActivityTool.Type,
            description: string,
            schema: S,
            work: (
              taskId: number,
              input: S["Type"],
              api: { readonly conversationId: number },
            ) => Promise<O>,
            // A round of only terminating tools ends the run without another model request.
            terminate = false,
          ) =>
            defineTool({
              name,
              description,
              parameters: descriptor(schema),
              executionMode: "sequential",
              replay: "safe",
              async execute(raw, api) {
                const input = Schema.decodeUnknownSync(Schema.toCodecJson(schema), {
                  onExcessProperty: "error",
                })(raw);

                const value = await withActivity(api.taskId, api.conversationId, name, () =>
                  work(api.taskId, input, api),
                );

                const output = [{ type: "text" as const, text: JSON.stringify(value) }];

                return terminate ? { output, control: { terminate: true } } : { output };
              },
            });

          const upsert = <T extends { readonly id: string }>(items: ReadonlyArray<T>, item: T) => [
            ...items.filter((entry) => entry.id !== item.id),
            item,
          ];

          const meta = config.providers.find(
            (provider) => (provider.provider ?? "meta") === "meta",
          );

          /** This review's own available retrieval of a source, never an earlier review's copy. */
          const savedSource = Effect.fn("PacketReviews.savedSource")(function* (key: string) {
            const sql = yield* SqlClient.SqlClient;

            const reads = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
            )(
              yield* sql`SELECT json_extract(result_json,'$.value.id') AS id,json_extract(result_json,'$.value.url') AS url FROM packet_review_tools WHERE review_id=${row.id} AND operation='source' AND json_extract(result_json,'$.value.status')='available'`,
            );

            const id = reads.find((entry) => sourceKey(entry.url) === key)?.id;

            return id === undefined
              ? undefined
              : (yield* load(row.project_id, row.id)).payload.sources.find(
                  (source) => source.id === id,
                );
          });

          // Parallel reviewers reading one source share a single retrieval and its source id.
          const sourceReads = new Map<string, Promise<typeof PacketSource.Type>>();

          /** Retrieve a source once per review; unavailable or failed reads stay retryable. */
          const retrieveSource = (url: string) => {
            const key = sourceKey(url);
            const shared = sourceReads.get(key);

            if (shared !== undefined) return shared;

            const read = (async () =>
              (await run(query(savedSource(key)))) ??
              (await run(readSource(url, config.review.sourceOptions))))();

            sourceReads.set(key, read);
            void read.then(
              (source) => {
                if (source.status === "available") sourceReads.set(sourceKey(source.url), read);
                else sourceReads.delete(key);
              },
              () => sourceReads.delete(key),
            );

            return read;
          };

          /**
           * One durable SAM path for model requests and host finding zooms. Intent is saved before
           * dispatch, an unresolved outcome is never resent, and a pause drains the receipt. A sheet
           * reviewer segments only its own sheet, and its unresolved SAM request stops only that
           * reviewer.
           */
          const segment = async (
            taskId: number,
            conversationId: number,
            image: ExecutionImage,
            request: SamInspectionRequest,
            sheet: PacketReview["sheets"][number] | undefined,
            counted: boolean,
          ) => {
            if (!meta) throw error("unavailable", "SAM is not configured for this review.");
            outsideSheet(conversationId, image.sheetId);

            return await withActivity(
              taskId,
              conversationId,
              "segment_objects",
              async () => {
                const prepared = await run(preparePacketSamRequest(image, request));

                const previous = await run(
                  query(
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;

                      const saved = (yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
                        yield* sql`SELECT fingerprint,status,sent,response_json FROM packet_review_attempts WHERE review_id=${row.id} AND task_id=${taskId} AND attempt=1 AND kind='sam'`,
                      ))[0];

                      if (saved) {
                        if (
                          saved.fingerprint !== prepared.fingerprint ||
                          saved.status !== "completed" ||
                          saved.response_json === null
                        )
                          return yield* error(
                            "uncertain",
                            "An unresolved SAM request cannot be sent again.",
                          );

                        return saved.response_json;
                      }

                      const fresh = yield* load(row.project_id, row.id);
                      yield* assertActive(fresh);

                      if (
                        fresh.payload.maxCalls !== null &&
                        fresh.payload.admittedCalls >= fresh.payload.maxCalls
                      )
                        return yield* error(
                          "budget",
                          "The optional review call budget was reached before SAM.",
                        );

                      const unresolved = yield* Schema.decodeUnknownEffect(UnresolvedAttempts)(
                        yield* sql`SELECT task_id,attempt FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain'`,
                      );

                      // Peer sheet reviewers' requests do not block this one's SAM call.
                      if (blocksRequest(assignments, unresolved, conversationId))
                        return yield* error(
                          "uncertain",
                          "Resolve the earlier provider request before SAM.",
                        );
                      yield* sql`INSERT INTO packet_review_attempts(review_id,task_id,attempt,kind,fingerprint,status,sent) VALUES (${row.id},${taskId},1,'sam',${prepared.fingerprint},'uncertain',0)`;
                      yield* Effect.sync(() => assignments.requests.set(taskId, conversationId));
                      yield* save(
                        fresh,
                        new PacketReview({
                          ...fresh.payload,
                          admittedCalls: fresh.payload.admittedCalls + 1,
                        }),
                      );

                      return null;
                    }),
                  ),
                );

                if (previous !== null) return { raw: previous, prepared, replayed: true };

                await run(get(row.project_id, row.id).pipe(Effect.flatMap(publish)));

                const controller = new AbortController();
                const controllers = samControllers.get(row.id) ?? new Set<AbortController>();
                controllers.add(controller);
                samControllers.set(row.id, controllers);
                const dispatchedAt = performance.now();
                let answered: Response | undefined;

                try {
                  await run(
                    query(
                      Effect.gen(function* () {
                        const fresh = yield* load(row.project_id, row.id);
                        yield* assertActive(fresh, true);
                        const sql = yield* SqlClient.SqlClient;
                        yield* sql`UPDATE packet_review_attempts SET sent=1 WHERE review_id=${row.id} AND task_id=${taskId} AND attempt=1 AND kind='sam' AND sent=0`;
                      }),
                    ),
                  );

                  const response = await (meta.transport ?? globalThis.fetch)(prepared.route, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${Redacted.value(meta.apiKey)}`,
                      "Content-Type": "application/json",
                    },
                    body: prepared.body,
                    redirect: "error",
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
                  });

                  answered = response;

                  if (!response.ok || !response.body)
                    throw error("uncertain", "SAM did not return a usable response.");
                  const chunks: Uint8Array[] = [];
                  let bytes = 0;
                  const reader = response.body.getReader();

                  try {
                    while (true) {
                      const part = await reader.read();

                      if (part.done) break;
                      bytes += part.value.length;

                      if (bytes > 8 * 1024 * 1024) {
                        await reader.cancel();
                        throw error("uncertain", "SAM response exceeded its receipt bound.");
                      }

                      chunks.push(part.value);
                    }
                  } finally {
                    reader.releaseLock();
                  }

                  const raw = Buffer.concat(chunks).toString("utf8");
                  await run(decodePacketSamResponse(raw, image));
                  await run(
                    query(
                      Effect.gen(function* () {
                        const fresh = yield* load(row.project_id, row.id);

                        if (fresh.owner_generation !== config.owner.generation)
                          return yield* error(
                            "conflict",
                            "SAM receipt belongs to an earlier owner.",
                          );
                        const sql = yield* SqlClient.SqlClient;
                        yield* sql`UPDATE packet_review_attempts SET status='completed',response_json=${raw} WHERE review_id=${row.id} AND task_id=${taskId} AND attempt=1 AND kind='sam' AND sent=1`;
                        const segmented = fresh.payload.segmentedSheetIds ?? [];

                        // Device-count findings need a model-requested SAM inspection of their sheet.
                        if (counted && !segmented.includes(image.sheetId))
                          yield* save(
                            fresh,
                            new PacketReview(
                              Struct.assign(fresh.payload, {
                                segmentedSheetIds: [...segmented, image.sheetId],
                              }),
                            ),
                          );
                      }),
                    ),
                  );
                  await run(get(row.project_id, row.id).pipe(Effect.flatMap(publish)));
                  await run(
                    query(
                      Effect.gen(function* () {
                        yield* assertActive(yield* load(row.project_id, row.id), true);
                      }),
                    ),
                  );

                  return { raw, prepared, replayed: false };
                } catch (cause) {
                  // An HTTP refusal is reported apart from a request whose outcome is unknown; the
                  // receipt of either stays unresolved and is never sent again.
                  const failure: typeof ProviderFailure.Type = {
                    category:
                      answered !== undefined
                        ? answered.ok
                          ? "response"
                          : "http"
                        : controller.signal.aborted
                          ? "aborted"
                          : cause instanceof Error && cause.name === "TimeoutError"
                            ? "timeout"
                            : "network",
                    phase: answered === undefined ? "dispatch" : "response",
                    elapsedMs: Math.max(0, performance.now() - dispatchedAt),
                    httpStatus: answered?.status ?? null,
                  };

                  const sheetId = assignments.sheets.get(conversationId);

                  await run(
                    query(
                      Effect.gen(function* () {
                        const fresh = yield* load(row.project_id, row.id);
                        const sql = yield* SqlClient.SqlClient;

                        const completed =
                          yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND task_id=${taskId} AND attempt=1 AND kind='sam' AND status='completed' AND response_json IS NOT NULL`;

                        if (completed.length || fresh.owner_generation !== config.owner.generation)
                          return fresh.payload;

                        // Its unresolved receipt blocks this sheet reviewer's next request only;
                        // peers and the coordinator continue, and the review ends uncertain.
                        if (sheetId !== undefined)
                          return yield* save(
                            fresh,
                            changeSheet(fresh.payload, sheetId, {
                              state: "failed",
                              providerFailure: failure,
                            }),
                          );

                        return yield* save(
                          fresh,
                          new PacketReview({
                            ...fresh.payload,
                            state: fresh.payload.state === "cancelled" ? "cancelled" : "uncertain",
                            providerFailure: failure,
                            error:
                              "A SAM request has an unresolved outcome. Its saved intent prevents automatic repetition.",
                          }),
                        );
                      }),
                    ).pipe(Effect.flatMap(publish)),
                  );
                  throw cause;
                } finally {
                  controllers.delete(controller);
                }
              },
              sheet,
            );
          };

          /**
           * Zoom into a recorded finding's problem area and segment it with SAM from the finding
           * region. The finding stands without the zoom; an unresolved SAM outcome still stops its
           * sheet reviewer, or a coordinator's review, through the shared dispatch.
           */
          const focusFinding = async (
            taskId: number,
            conversationId: number,
            findingId: string,
          ) => {
            if (!meta) return undefined;
            const review = await run(get(row.project_id, row.id));
            const finding = review.findings.find((entry) => entry.id === findingId);
            const target = finding && focusTarget(finding.locations, review.sheets);

            if (!finding || !target) return undefined;

            if (finding.focus !== undefined)
              return {
                artifactId: finding.focus.artifactId,
                segments: finding.focus.segments.length,
              };
            const { sheet, region } = target;
            const pad = Math.max(36, 0.25 * Math.max(region.width, region.height));

            const crop =
              clip(
                new Region({
                  x: region.x - pad,
                  y: region.y - pad,
                  width: region.width + 2 * pad,
                  height: region.height + 2 * pad,
                }),
                sheet.box,
              ) ?? region;

            try {
              const artifact = await run(
                asExecution(
                  config.review.render({
                    projectId: row.project_id,
                    sheetId: sheet.id,
                    operationId: Schema.decodeUnknownSync(OperationId)(
                      stableId(row.id, taskId, "focus-render"),
                    ),
                    region: crop,
                    // About 1,400 pixels on the long side, inside SAM's 2,048-pixel guidance limit.
                    dpi: Math.max(
                      24,
                      Math.min(200, Math.floor((1400 * 72) / Math.max(crop.width, crop.height))),
                    ),
                  }),
                ),
              );

              const image = await run(config.review.port.readImage(artifact));
              const pixels = transformRegion(image.pdfToPixels, region);

              const box = {
                left: Math.max(0, Math.floor(pixels.x)),
                top: Math.max(0, Math.floor(pixels.y)),
                right: Math.min(image.width, Math.ceil(pixels.x + pixels.width)),
                bottom: Math.min(image.height, Math.ceil(pixels.y + pixels.height)),
              };

              // A live E-3 receptacle zoom: box alone 0.48 confidence, box with centre point 0.62.
              const request = Schema.decodeUnknownSync(SamInspectionRequest)({
                artifactId: artifact.id,
                prompt: {
                  kind: "guided",
                  box,
                  points: [
                    {
                      x: Math.round((box.left + box.right) / 2),
                      y: Math.round((box.top + box.bottom) / 2),
                      label: "positive",
                    },
                  ],
                },
              });

              const sam = await segment(taskId, conversationId, image, request, sheet, false);
              const decoded = await run(decodePacketSamFocus(sam.raw, image));

              const focus = {
                artifactId: artifact.id,
                sheetId: sheet.id,
                region,
                width: image.width,
                height: image.height,
                box,
                model: "sam-3.1" as const,
                responseId: decoded.responseId,
                segments: decoded.segments,
              };

              // Saving the same zoom again is harmless, so a drained pause may still record it.
              await run(
                query(
                  Effect.gen(function* () {
                    const fresh = yield* load(row.project_id, row.id);
                    yield* assertActive(fresh, true);

                    return yield* save(
                      fresh,
                      new PacketReview(
                        Struct.assign(fresh.payload, {
                          evidenceIds: [...new Set([...fresh.payload.evidenceIds, artifact.id])],
                          findings: fresh.payload.findings.map((entry) =>
                            entry.id === findingId ? { ...entry, focus } : entry,
                          ),
                        }),
                      ),
                    );
                  }),
                ).pipe(Effect.flatMap(publish)),
              );

              return { artifactId: artifact.id, segments: focus.segments.length };
            } catch (cause) {
              return {
                skipped: cause instanceof ExecutionError ? cause.message : "SAM focus unavailable.",
              };
            }
          };

          const tools = [
            tool(
              "inventory_packet",
              "Read the complete frozen document inventory, review scope, prior findings, coverage and reviewer request.",
              Schema.Struct({}),
              async (_task, _input, api) => {
                const review = await run(get(row.project_id, row.id));
                const assigned = assignments.sheets.get(api.conversationId);

                // A sheet reviewer needs its own rows, not the whole ledger.
                return assigned === undefined
                  ? Struct.assign(review, { findings: withoutFocus(review.findings) })
                  : {
                      request: review.request,
                      scope: review.scope,
                      sheets: review.sheets,
                      projectConfiguration: review.projectConfiguration,
                      sources: review.sources.map(({ id, url, title }) => ({ id, url, title })),
                      coverage: review.coverage.filter((entry) => entry.sheetId === assigned),
                      findings: withoutFocus(
                        review.findings.filter((finding) =>
                          finding.locations.some((location) => location.sheetId === assigned),
                        ),
                      ),
                    };
              },
            ),
            defineTool({
              name: "render_sheet",
              description:
                "Open an original PDF page or focused crop at a legible scale. Coordinates are original PDF points, bottom-left origin. Returned transforms map actual delivered pixels to the page. Every assigned sheet must be inspected; use crops to read details and retain focused evidence.",
              parameters: descriptor(
                Schema.Struct({ sheetId: SheetId, region: Schema.optionalKey(Region) }),
              ),
              replay: "safe",
              executionMode: "sequential",
              async execute(raw, api) {
                const input = Schema.decodeUnknownSync(
                  Schema.toCodecJson(
                    Schema.Struct({ sheetId: SheetId, region: Schema.optionalKey(Region) }),
                  ),
                )(raw);

                const current = await run(
                  query(
                    Effect.gen(function* () {
                      const loaded = yield* load(row.project_id, row.id);
                      yield* assertActive(loaded);

                      return loaded.payload;
                    }),
                  ),
                );

                outsideSheet(api.conversationId, input.sheetId);

                if (toolRoleOf(current, api.conversationId) === "setup")
                  assertSetupSheet(current, input.sheetId, setupLimits);

                if (
                  row.payload.provider === "baseten" &&
                  (imageCounts.get(api.conversationId) ?? 0) >= 8
                )
                  throw error(
                    "input",
                    "The current source batch already contains eight images. Inspect those results before requesting more pages or details; Muse Spark Open accepts eight images per request.",
                  );

                const sheet = row.payload.sheets.find((item) => item.id === input.sheetId);

                if (!sheet) throw error("input", "That page is outside the frozen packet.");

                return await withActivity(
                  api.taskId,
                  api.conversationId,
                  "render_sheet",
                  async () => {
                    const artifact = await run(
                      asExecution(
                        config.review.render({
                          projectId: row.project_id,
                          sheetId: sheet.id,
                          operationId: Schema.decodeUnknownSync(OperationId)(
                            stableId(row.id, api.taskId, "render"),
                          ),
                          region: input.region ?? sheet.box,
                          dpi: input.region ? 200 : 96,
                        }),
                      ),
                    );

                    const image = await run(config.review.port.readImage(artifact));
                    await recordTool(
                      row,
                      api.taskId,
                      "render",
                      (review) =>
                        new PacketReview({
                          ...review,
                          inspectedSheetIds: [...new Set([...review.inspectedSheetIds, sheet.id])],
                          inspectedThisReviewSheetIds: [
                            ...new Set([...(review.inspectedThisReviewSheetIds ?? []), sheet.id]),
                          ],
                          detailInspectedSheetIds:
                            input.region &&
                            (input.region.width < sheet.box.width ||
                              input.region.height < sheet.box.height)
                              ? [...new Set([...(review.detailInspectedSheetIds ?? []), sheet.id])]
                              : (review.detailInspectedSheetIds ?? []),
                          evidenceIds: [...new Set([...review.evidenceIds, artifact.id])],
                        }),
                      { artifactId: artifact.id },
                    );

                    imageCounts.set(
                      api.conversationId,
                      (imageCounts.get(api.conversationId) ?? 0) + 1,
                    );

                    // Reviews twice called tables clipped or missing at their own crop edge.
                    const cropped =
                      input.region !== undefined &&
                      (input.region.width < sheet.box.width ||
                        input.region.height < sheet.box.height);

                    const rendered = {
                      artifact,
                      width: image.width,
                      height: image.height,
                      pdfToPixels: image.pdfToPixels,
                      pixelsToPdf: image.pixelsToPdf,
                      cropNote: cropped
                        ? "This is a crop. Tables, schedules, matrices and notes can continue past its edges. Before describing content as missing, truncated, clipped or not located, render the full sheet or an adjacent crop that covers the edge."
                        : undefined,
                    };

                    return {
                      output: [
                        { type: "text", text: JSON.stringify(rendered) },
                        { type: "image", mimeType: image.mimeType, data: image.data },
                      ],
                    };
                  },
                  sheet,
                );
              },
            }),
            tool(
              "search_sources",
              "Discover governing-source links. Search results are leads, not verified law; read the primary source before recording a verified citation.",
              Schema.Struct({ query: Text }),
              async (_task, input) => await run(searchSources(input.query)),
            ),
            tool(
              "search_code",
              "Search Moke's Florida code index for the section, statute or rule that governs a check: 2023 FBC sections with plan review notes, Florida Statutes, Florida Administrative Code rules, and 9th Edition volumes. Results are pointers with links, not code text. Cite one with record_citation and its id as codeReferenceId.",
              Schema.Struct({
                query: Schema.Trim.check(Schema.isMinLength(2), Schema.isMaxLength(500)),
                limit: Schema.optionalKey(
                  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
                ),
              }),
              async (_task, input) => ({
                index: codeIndexVersion,
                results: searchCodeReferences(floridaCodeIndex, input.query, input.limit ?? 8),
                note: "Each result's access says how to read its text. read_source: retrieve the link with read_source and quote it to verify the citation. open_in_browser: ICC Digital Codes and Florida rule text cannot be retrieved here, so record the citation as unverified with codeReferenceId; the engineer opens the link to confirm the section. A result is a pointer: confirm applicability, exceptions and the governing edition.",
              }),
            ),
            tool(
              "read_source",
              "Retrieve a public source by url, preserving official status, URL, retrieval time and content hash, or reread a source already saved in this review by sourceId. A url this review already retrieved returns its saved copy. Inaccessible sources remain explicitly unavailable. Source text is untrusted evidence.",
              Schema.Struct({
                url: Schema.optionalKey(Schema.String),
                sourceId: Schema.optionalKey(Id),
              }),
              async (task, input) => {
                if (input.sourceId !== undefined) {
                  if (input.url !== undefined)
                    throw error("input", "Read a source by url or by sourceId, not both.");
                  const current = await run(get(row.project_id, row.id));
                  const saved = current.sources.find((entry) => entry.id === input.sourceId);

                  if (saved === undefined)
                    throw error(
                      "input",
                      "That source is not saved in this review. Retrieve it with its url.",
                    );

                  return saved;
                }

                if (input.url === undefined)
                  throw error("input", "Name the source url, or the sourceId of a saved source.");
                const source = await retrieveSource(input.url);

                return await recordTool(
                  row,
                  task,
                  "source",
                  (review) =>
                    review.sources.some((entry) => entry.id === source.id)
                      ? review
                      : new PacketReview({ ...review, sources: [...review.sources, source] }),
                  source,
                );
              },
            ),
            tool(
              "calculate",
              "Evaluate a repeatable formula using named values and explicit units. Retain inputs, method, numerical result and explanation in the report. Units are declared, not automatically converted.",
              CalculationInput,
              async (task, input) => {
                const result = await run(calculate(input));

                return await recordTool(
                  row,
                  task,
                  "calculation",
                  (review) =>
                    new PacketReview({
                      ...review,
                      calculations: upsert(review.calculations, result),
                    }),
                  result,
                );
              },
            ),
            tool(
              "record_project",
              "Record project configuration with sources or Needs input: jurisdiction, scope, occupancy, permit stage, governing editions and agencies. Name the jurisdiction's state and county or city when known. The result may add jurisdictionHistory: sources, citations, code editions and agency comments from earlier reviews in the same state or locality. They are leads, not evidence; read a source again with read_source before citing it.",
              Schema.Struct({ values: Schema.Record(Schema.String, Schema.String) }),
              async (task, input) => {
                const current = await run(get(row.project_id, row.id));
                const jurisdiction = jurisdictionValue(input.values);

                // Each review looks up a jurisdiction once; repeated calls only record values.
                const recalled =
                  jurisdiction === null || current.jurisdictionLeads !== undefined
                    ? null
                    : jurisdictionHistory(
                        jurisdiction,
                        await run(query(earlierReviews(row.id, row.conversation_id))),
                      );

                return await recordTool(
                  row,
                  task,
                  "project",
                  (review) => {
                    const configured = new PacketReview(
                      Struct.assign(review, {
                        projectConfiguration: { ...review.projectConfiguration, ...input.values },
                      }),
                    );

                    return recalled === null
                      ? configured
                      : new PacketReview(
                          Struct.assign(configured, { jurisdictionLeads: recalled.leads }),
                        );
                  },
                  recalled === null || recalled.leads.reviews.length === 0
                    ? input.values
                    : { recorded: input.values, jurisdictionHistory: recalled.history },
                );
              },
            ),
            tool(
              "record_coverage",
              "Record each assigned sheet/pass/discipline as checked, issue, not_applicable with reason, or needs_input. This never marks a user's manual count coverage complete.",
              PacketCoverage,
              async (task, input, api) => {
                outsideSheet(api.conversationId, input.sheetId);

                return await recordTool(
                  row,
                  task,
                  "coverage",
                  (review) => {
                    if (!review.sheets.some((sheet) => sheet.id === input.sheetId))
                      throw error("input", "Coverage page is outside the packet.");

                    if (
                      (input.status === "checked" || input.status === "issue") &&
                      !review.inspectedSheetIds.includes(input.sheetId)
                    )
                      throw error(
                        "input",
                        "Open the original sheet image before claiming inspection.",
                      );

                    if (
                      (input.status === "not_applicable" || input.status === "needs_input") &&
                      !input.note.trim()
                    )
                      throw error("input", "Coverage needs a specific reason or missing input.");

                    return new PacketReview({
                      ...review,
                      coverage: [
                        ...review.coverage.filter(
                          (entry) =>
                            entry.sheetId !== input.sheetId ||
                            entry.pass !== input.pass ||
                            entry.discipline !== input.discipline,
                        ),
                        input,
                      ],
                    });
                  },
                  input,
                );
              },
            ),
            tool(
              "record_coverage_batch",
              "Record coverage for multiple sheet/pass/discipline checks together after inspecting the source images. Each entry remains explicit; checked/issue needs an inspected page, and Not applicable or Needs input needs its reason.",
              Schema.Struct({
                entries: Schema.NonEmptyArray(PacketCoverage).check(Schema.isMaxLength(1000)),
              }),
              async (task, input, api) => {
                for (const entry of input.entries) outsideSheet(api.conversationId, entry.sheetId);

                return await recordTool(
                  row,
                  task,
                  "coverage_batch",
                  (review) => {
                    let coverage = [...review.coverage];

                    for (const entry of input.entries) {
                      if (!review.sheets.some((sheet) => sheet.id === entry.sheetId))
                        throw error("input", "Coverage page is outside the frozen packet.");

                      if (
                        (entry.status === "checked" || entry.status === "issue") &&
                        !review.inspectedSheetIds.includes(entry.sheetId)
                      )
                        throw error(
                          "input",
                          "Inspect each original sheet image before claiming coverage.",
                        );

                      if (
                        (entry.status === "not_applicable" || entry.status === "needs_input") &&
                        !entry.note.trim()
                      )
                        throw error(
                          "input",
                          "Record the specific reason or missing input for this check.",
                        );
                      coverage = [
                        ...coverage.filter(
                          (prior) =>
                            prior.sheetId !== entry.sheetId ||
                            prior.pass !== entry.pass ||
                            prior.discipline !== entry.discipline,
                        ),
                        entry,
                      ];
                    }

                    return new PacketReview({ ...review, coverage });
                  },
                  input.entries,
                );
              },
            ),
            tool(
              "record_citation",
              "Log a printed or governing citation and its edition, exact section, quote and applicability. Verified requires matching retrieved official document and edition, plus a substantive clause inside the claimed section or table. Missing or ambiguous section structure stays unverified. Pass codeReferenceId from search_code to attach the section's link.",
              CitationInput,
              async (task, { codeReferenceId, ...fields }) => {
                const indexed =
                  codeReferenceId === undefined ? undefined : codeReference(codeReferenceId);

                if (codeReferenceId !== undefined && indexed === undefined)
                  throw error(
                    "input",
                    "Unknown code reference. Use an id returned by search_code.",
                  );

                const input =
                  indexed === undefined
                    ? fields
                    : {
                        ...fields,
                        reference: {
                          id: indexed.id,
                          document: indexed.document,
                          edition: indexed.edition,
                          title: indexed.title,
                          url: indexed.url,
                          access: indexed.access,
                        },
                      };

                const current = await run(get(row.project_id, row.id));
                const source = current.sources.find((entry) => entry.id === input.sourceId);

                const citation =
                  input.status === "verified" && !citationHasSourceSupport(input, source)
                    ? {
                        ...input,
                        status: "unverified" as const,
                        // Note text must stay trimmed; an empty note previously left a trailing space.
                        note: [
                          "Retrieved official text does not support the claimed document, edition and substantive quote within that section.",
                          input.note,
                        ]
                          .filter((part) => part.length > 0)
                          .join(" ")
                          .slice(0, 32000),
                      }
                    : input;

                return await recordTool(
                  row,
                  task,
                  "citation",
                  (review) => {
                    return new PacketReview({
                      ...review,
                      citations: upsert(review.citations, citation),
                    });
                  },
                  citation,
                );
              },
            ),
            tool(
              "record_finding",
              "Save the complete source-specific technical finding, including necessary values, qualifications and evidence. Do not shorten or omit technical facts to fit a display limit. Give each location the tight PDF region of the problem area; when SAM is available the host renders a zoom of the first region under half its sheet and segments it for the reviewer. Reuse an existing issue ID for follow-up. The result includes the host-owned summary state and revision; if Pending, use record_finding_summary. Completed and the reviewer's decision are user-owned and cannot be set by this tool.",
              Schema.Struct({
                ...Struct.omit(PacketFinding.fields, ["summary", "decision", "focus"]),
                id: Schema.optionalKey(Id),
                completed: Schema.optionalKey(Schema.Boolean),
              }),
              async (task, input, api) => {
                if (input.absenceCheck && assignments.sheets.has(api.conversationId))
                  throw error(
                    "input",
                    "A sheet reviewer cannot search the whole set. List the suspected missing item under suspectedGaps in finish_sheet; the coordinator checks it.",
                  );

                // A sheet reviewer's finding stays on its sheet, with evidence rendered from it.
                outsideSheet(
                  api.conversationId,
                  ...input.locations.map((location) => location.sheetId),
                );

                if (assignments.sheets.has(api.conversationId))
                  for (const artifactId of input.evidenceIds)
                    outsideSheet(
                      api.conversationId,
                      (await run(config.review.artifact(row.project_id, artifactId))).sheetId,
                    );
                const id = input.id ?? stableId(row.id, task, "finding");
                const revision = stableId(row.id, task, "finding-summary");
                const sheetId = assignments.sheets.get(api.conversationId) ?? null;

                const summary = Option.match(
                  Schema.decodeUnknownOption(FindingSummaryText)(
                    Struct.pick(input, ["title", "observed", "correction"]),
                  ),
                  {
                    onNone: () => PacketFindingSummary.cases.Pending.make({ revision, sheetId }),
                    onSome: (text) =>
                      PacketFindingSummary.cases.Ready.make({ revision, sheetId, ...text }),
                  },
                );

                const saved = await recordTool(
                  row,
                  task,
                  "finding",
                  (review) => {
                    const existing = review.findings.find((entry) => entry.id === id);
                    const target = focusTarget(input.locations, review.sheets);

                    // Reusing an id cannot adopt a peer sheet's or the coordinator's finding.
                    if (
                      sheetId !== null &&
                      existing !== undefined &&
                      ((existing.summary?.sheetId ?? sheetId) !== sheetId ||
                        existing.locations.some((location) => location.sheetId !== sheetId))
                    )
                      throw error(
                        "input",
                        "That finding belongs to another sheet or to the coordinator. Note it in finish_sheet; the coordinator updates findings across sheets.",
                      );

                    // A follow-up keeps its zoom while the focused problem area is unchanged.
                    const kept =
                      existing?.focus !== undefined &&
                      target !== undefined &&
                      existing.focus.sheetId === target.sheet.id &&
                      JSON.stringify(existing.focus.region) === JSON.stringify(target.region)
                        ? { focus: existing.focus }
                        : {};

                    const recorded = {
                      ...input,
                      ...kept,
                      id,
                      summary,
                      completed: existing?.completed ?? false,
                    };

                    const finding =
                      existing?.decision === undefined
                        ? recorded
                        : { ...recorded, decision: existing.decision };

                    if (
                      meta !== undefined &&
                      claimsDeviceCount(`${finding.title} ${finding.observed}`) &&
                      !finding.locations.some((location) =>
                        (review.segmentedSheetIds ?? []).includes(location.sheetId),
                      )
                    )
                      throw error(
                        "input",
                        "A drawn device or fixture count needs SAM evidence from this review. Render a focused crop of the counted area on one of this finding's sheets, call segment_objects with a concept prompt naming the symbol, check every candidate against the source and look for symbols SAM missed, then record the finding.",
                      );

                    if (
                      finding.locations.some(
                        (location) => !review.sheets.some((sheet) => sheet.id === location.sheetId),
                      ) ||
                      finding.evidenceIds.some((artifact) => !review.evidenceIds.includes(artifact))
                    )
                      throw error(
                        "input",
                        "Finding evidence must come from this packet's inspected source regions.",
                      );

                    requireAbsenceSupport(review, finding);

                    if (!finding.evidenceIds.length && !finding.evidenceNote.trim())
                      throw error(
                        "input",
                        "Provide focused evidence or explain why the missing material cannot be pictured.",
                      );

                    if (
                      finding.status === "Confirmed" &&
                      ["Code", "Permit condition", "Agency request"].includes(
                        finding.classification,
                      ) &&
                      !finding.citationIds.some((citation) =>
                        review.citations.some(
                          (entry) => entry.id === citation && entry.status === "verified",
                        ),
                      )
                    )
                      throw error(
                        "input",
                        "An unsupported regulatory claim must remain Needs input until its governing source is verified.",
                      );

                    const updated = new PacketReview({
                      ...review,
                      finished: false,
                      findings: upsert(review.findings, finding),
                    });

                    return Match.value(summary).pipe(
                      Match.tagsExhaustive({
                        Pending: () =>
                          sheetId === null ? updated : invalidateSheetNotes(updated, sheetId),
                        Ready: () => updated,
                      }),
                    );
                  },
                  { id, summary },
                );

                const focus = await focusFinding(task, api.conversationId, id);

                return focus === undefined ? saved : { id, summary, samFocus: focus };
              },
            ),
            tool(
              "record_finding_summary",
              "Save a short display title, one observation sentence and one action-led correction for the exact id and revision returned by record_finding. This never changes the full technical record, evidence or status. Correct rejected summaries before finishing.",
              RecordFindingSummary,
              async (task, input, api) =>
                await recordTool(
                  row,
                  task,
                  "finding-summary",
                  (review) => {
                    const finding = review.findings.find((entry) => entry.id === input.id);

                    if (!finding?.summary || finding.summary.revision !== input.revision)
                      throw error(
                        "input",
                        "The technical finding changed. Read its current id and summary revision before summarizing it.",
                      );
                    requireAbsenceSupport(review, {
                      ...finding,
                      title: input.title,
                      observed: input.observed,
                    });
                    const assigned = assignments.sheets.get(api.conversationId);

                    if (assigned !== undefined && finding.summary.sheetId !== assigned)
                      throw error("input", "Summarize only your own sheet's technical findings.");

                    return new PacketReview({
                      ...review,
                      findings: upsert(review.findings, {
                        ...finding,
                        summary: PacketFindingSummary.cases.Ready.make({
                          revision: input.revision,
                          sheetId: finding.summary.sheetId,
                          title: input.title,
                          observed: input.observed,
                          correction: input.correction,
                        }),
                      }),
                    });
                  },
                  { id: input.id },
                ),
            ),
            tool(
              "record_prior_comment",
              "Track an agency comment, response and changed source. Resolved requires current inspection of its persisted revision target. Target sheet IDs are assigned by the host and cannot be changed by this tool. User completion does not close it.",
              PriorCommentInput,
              async (task, input) => {
                const snapshot = await run(asExecution(config.review.snapshot(row.project_id, 0)));
                const current = await run(get(row.project_id, row.id));
                const previous = current.priorComments.find((comment) => comment.id === input.id);

                const changed = current.sheets.filter(
                  (sheet) => !(current.baselineSheetIds ?? []).includes(sheet.id),
                );

                const targets = previous
                  ? (previous.revisionTargetSheetIds ?? [])
                  : (changed.length ? changed : current.sheets).map((sheet) => sheet.id);

                const comment = { ...input, revisionTargetSheetIds: targets };

                return await recordTool(
                  row,
                  task,
                  "prior_comment",
                  (review) => {
                    if (
                      comment.evidenceIds.some((id) => !review.evidenceIds.includes(id)) ||
                      (comment.status === "Resolved" &&
                        (!comment.changedSources.trim() ||
                          !comment.evidenceIds.some((id) => {
                            const artifact = snapshot.artifacts.find((item) => item.id === id);

                            return (
                              artifact?.sheetId != null &&
                              (review.inspectedThisReviewSheetIds ?? []).includes(
                                artifact.sheetId,
                              ) &&
                              review.sheets.some(
                                (sheet) =>
                                  targets.includes(sheet.id) &&
                                  sheet.id === artifact.sheetId &&
                                  sheet.revisionId === artifact.revisionId,
                              )
                            );
                          })))
                    )
                      throw error(
                        "input",
                        "Comment closure needs a named changed source and revision evidence inspected in this review.",
                      );

                    return new PacketReview({
                      ...review,
                      priorComments: upsert(review.priorComments, comment),
                    });
                  },
                  comment,
                );
              },
            ),
            tool(
              "ask_reviewer",
              "Record a specific missing source or question and continue any independent checks.",
              Schema.Struct({ question: Text }),
              async (task, input) =>
                await recordTool(
                  row,
                  task,
                  "question",
                  (review) =>
                    new PacketReview({
                      ...review,
                      missingInputs: [...new Set([...review.missingInputs, input.question])],
                    }),
                  input,
                ),
            ),
            tool(
              "finish_setup",
              "Coordinator setup only: end setup once the project configuration and governing sources are recorded. List project facts you could not establish in needsInput; each is recorded as Needs input, never guessed. The sheet reviewers start from the configuration and sources saved now.",
              Schema.Struct({
                needsInput: Schema.Array(
                  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
                ).check(Schema.isMaxLength(50)),
              }),
              async (task, input) =>
                await recordTool(
                  row,
                  task,
                  "finish_setup",
                  (review) =>
                    startSheets(
                      review.parallel?.stage !== "setup"
                        ? review
                        : new PacketReview(
                            Struct.assign(review, {
                              projectConfiguration: {
                                ...review.projectConfiguration,
                                ...Object.fromEntries(
                                  input.needsInput
                                    .filter(
                                      (item) => !Object.hasOwn(review.projectConfiguration, item),
                                    )
                                    .map((item) => [item, "Needs input"]),
                                ),
                              },
                            }),
                          ),
                    ),
                  { setup: "saved", needsInput: input.needsInput },
                ),
              true,
            ),
            tool(
              "finish_review",
              "Save the actual reviewed scope and summary for the offline report. Unreviewed sheets/passes and missing sources remain visible; finishing is not professional approval or user completion.",
              Schema.Struct({ summary: Text, missingInputs: Schema.Array(Schema.String) }),
              async (task, input, api) => {
                if (assignments.sheets.has(api.conversationId))
                  throw error(
                    "input",
                    "Sheet reviewers finish with finish_sheet. The coordinator finishes the review.",
                  );

                return await recordTool(
                  row,
                  task,
                  "finish",
                  (review) => {
                    const pending = review.findings.filter(
                      (finding) => finding.summary?._tag === "Pending",
                    );

                    if (pending.length)
                      throw error(
                        "input",
                        `Short summaries are pending for ${pending.map((finding) => finding.id).join(", ")}. Full technical findings are saved. Call record_finding_summary with their current revisions, then finish_review.`,
                      );

                    if (review.parallel !== undefined && review.parallel.stage !== "coordination")
                      throw error(
                        "input",
                        "The sheet reviewers have not reported yet. End this turn with a short reply; you finish the review in the coordination stage.",
                      );
                    const progress = packetCoverageProgress(review);

                    const unopened = review.sheets.filter(
                      (sheet) => !review.inspectedSheetIds.includes(sheet.id),
                    );

                    const unrecorded = progress.total - progress.recorded;
                    const rejected = finishRejections.get(review.id) ?? 0;

                    // A review that stops early leaves most of its scope unreviewed. Without a
                    // user call budget, ask once for the remaining work; then record the gaps.
                    // Two refusals made the reviewer stop without finishing at all.
                    if (
                      (unopened.length > 0 || unrecorded > 0) &&
                      review.maxCalls === null &&
                      rejected < 1
                    ) {
                      finishRejections.set(review.id, rejected + 1);

                      throw error(
                        "input",
                        `Coverage is incomplete, so this review is not finished yet. ${unopened.length} of ${review.sheets.length} requested sheets were never opened${
                          unopened.length
                            ? ` (${unopened
                                .slice(0, 20)
                                .map((sheet) => sheet.label || `page ${sheet.pageIndex + 1}`)
                                .join(", ")}${unopened.length > 20 ? ", …" : ""})`
                            : ""
                        } and ${unrecorded} of ${progress.total} required passes are unrecorded. Open each remaining sheet with render_sheet and record its passes with record_coverage_batch, using not_applicable with a reason for disciplines that do not apply. Then call finish_review again. That next call is accepted, and any remaining gaps are recorded in the report.`,
                      );
                    }

                    return new PacketReview({
                      ...review,
                      summary: input.summary,
                      missingInputs: [
                        ...new Set([...review.missingInputs, ...input.missingInputs]),
                      ],
                      finished: true,
                    });
                  },
                  input,
                );
              },
            ),
            tool(
              "finish_sheet",
              "Sheet reviewers only: after recording your sheet's coverage and findings, save the notes the coordinator compares across sheets.",
              PacketSheetNotes,
              async (task, input, api) => {
                const assigned = assignments.sheets.get(api.conversationId);

                if (assigned === undefined)
                  throw error(
                    "input",
                    "Only sheet reviewers call finish_sheet. The coordinator finishes with finish_review.",
                  );

                return await recordTool(
                  row,
                  task,
                  "finish_sheet",
                  (review) => {
                    if (
                      review.findings.some(
                        (finding) =>
                          finding.summary?._tag === "Pending" &&
                          finding.summary.sheetId === assigned,
                      )
                    )
                      throw error(
                        "input",
                        "Short summaries are pending for this sheet. Full technical findings are saved. Call record_finding_summary before finish_sheet.",
                      );

                    return changeSheet(review, assigned, { notes: input });
                  },
                  input,
                );
              },
            ),
          ];

          if (meta)
            tools.push(
              defineTool({
                name: "segment_objects",
                description:
                  "Use SAM 3.1 on an inspected source crop to locate geometric candidates, for example every receptacle, switch, luminaire or plumbing fixture symbol in a plan area. Confirm class, drawing context and coverage yourself. Geometry is not physical measurement and zero matches do not prove absence.",
                parameters: descriptor(SamInspectionRequest),
                replay: "safe",
                executionMode: "sequential",
                async execute(raw, api) {
                  const request = Schema.decodeUnknownSync(
                    Schema.toCodecJson(SamInspectionRequest),
                  )(raw);

                  const current = await run(get(row.project_id, row.id));
                  assertPermitted(toolRoleOf(current, api.conversationId), "segment_objects");

                  if (!current.evidenceIds.includes(request.artifactId))
                    throw error(
                      "input",
                      "Render this packet's source region before segmenting it.",
                    );

                  const snapshot = await run(
                    asExecution(config.review.snapshot(row.project_id, 0)),
                  );

                  const artifact = snapshot.artifacts.find(
                    (item) => item.id === request.artifactId,
                  );

                  if (!artifact) throw error("input", "SAM source artifact is unavailable.");
                  const image = await run(config.review.port.readImage(artifact));

                  const sam = await segment(
                    api.taskId,
                    api.conversationId,
                    image,
                    request,
                    current.sheets.find((sheet) => sheet.id === artifact.sheetId),
                    true,
                  );

                  const result = await run(decodePacketSamResponse(sam.raw, image));

                  return {
                    output: [
                      {
                        type: "text",
                        text: JSON.stringify(
                          sam.replayed
                            ? result
                            : {
                                ...result,
                                artifactId: image.artifactId,
                                submittedSha256: sam.prepared.submittedSha256,
                                promptSha256: sam.prepared.promptSha256,
                              },
                        ),
                      },
                    ],
                  };
                },
              }),
            );
          registry.install(
            defineExtension({
              name: "moke-packet-review-v1",
              tools,
              hooks: [
                hook(GenerationTask, {
                  // Admission scopes unresolved provider attempts to the conversation that made them.
                  beforeRequest: (_request, api) => {
                    assignments.requests.set(api.taskId, api.conversationId);

                    return undefined;
                  },
                  // A sheet reviewer that stops without notes is asked once to save them.
                  onYield: async (_answer, api) => {
                    const sheetId = assignments.sheets.get(api.conversationId);

                    if (nudged.has(api.conversationId)) return undefined;
                    const review = await run(get(row.project_id, row.id));

                    const pending = review.findings.filter(
                      (finding) =>
                        finding.summary?._tag === "Pending" &&
                        (sheetId === undefined || finding.summary.sheetId === sheetId),
                    );

                    if (review.state === "running" && pending.length) {
                      nudged.add(api.conversationId);

                      return {
                        continue: `Full technical findings are saved, but short summaries are pending: ${JSON.stringify(pending.map((finding) => ({ id: finding.id, summary: finding.summary })))}. Call record_finding_summary for each, then finish your review.`,
                      };
                    }

                    if (sheetId === undefined) return undefined;

                    if (
                      review.state !== "running" ||
                      review.parallel?.sheets.some(
                        (entry) => entry.sheetId === sheetId && entry.notes !== undefined,
                      )
                    )
                      return undefined;
                    nudged.add(api.conversationId);

                    return {
                      continue:
                        "Record any remaining coverage for your sheet, then call finish_sheet with your notes. The coordinator needs them to compare sheets.",
                    };
                  },
                }),
              ],
            }),
          );

          return {
            registry,
            /** A role's tools in registry order; each role keeps one list for its cached prefix. */
            toolsFor: (role: PacketToolRole) => tools.filter((entry) => permits(role, entry.name)),
            nextRequest: (conversationId: number | undefined) => {
              if (conversationId === undefined) imageCounts.clear();
              else imageCounts.delete(conversationId);
            },
          };
        };

        const updateSheet = (row: Row, sheetId: string, change: SheetChange, active = true) =>
          mutate(row.project_id, row.id, (review) => changeSheet(review, sheetId, change), active);

        /**
         * Coordinator setup, then one conversation per sheet, `concurrency` at a time, then
         * cross-sheet coordination. Stable request IDs let a restart rejoin each stage's work.
         */
        const reviewInParallel = async (work: {
          readonly row: Row;
          readonly harness: Harness;
          readonly storage: Awaited<ReturnType<typeof openReviewJournal>>;
          readonly root: Conversation;
          readonly children: Map<number, Conversation>;
          readonly assignments: SheetAssignments;
          readonly toolsFor: ReturnType<typeof registryFor>["toolsFor"];
          readonly agent: {
            readonly model: ReturnType<typeof createAdmittedModels>["model"];
            readonly thinkingLevel: "xhigh" | "high";
          };
          readonly input: { readonly followUpInstructions: ReadonlyArray<unknown> };
          readonly requestId: string;
          readonly lease: { readonly closed: boolean };
        }): Promise<{ readonly status: string }> => {
          const { row, root, harness } = work;
          const replaced = { status: "unanswered" } as const;
          const requestId = (part: string) => `${work.requestId}:${part}`;

          const stage = (next: "sheets" | "coordination") =>
            run(
              mutate(row.project_id, row.id, (review) =>
                next === "sheets" ? startSheets(review) : changeStage(review, next),
              ),
            );

          // A run replaced by resume or closed for shutdown records nothing further.
          const sheetState = (sheetId: string, change: SheetChange, active = true) =>
            work.lease.closed
              ? Promise.resolve()
              : run(updateSheet(row, sheetId, change, active)).then(() => undefined);

          let review = await run(get(row.project_id, row.id));

          if (review.parallel?.stage === "setup") {
            const setup = await (
              await root.submit(
                {
                  type: "input",
                  requestId: work.requestId,
                  content: JSON.stringify({ ...work.input, stage: "setup", setupLimits }),
                },
                BACKGROUND_CONTEXT,
              )
            ).wait(BACKGROUND_CONTEXT);

            if (work.lease.closed) return setup;
            review = await run(get(row.project_id, row.id));

            // finish_setup or the setup request limit has already saved the snapshot; a final
            // reply without finish_setup ends setup the same way.
            if (review.parallel?.stage === "setup") {
              if (setup.status !== "done") return setup;
              review = await stage("sheets");
            }
          }

          if (review.parallel?.stage === "sheets") {
            // Stored conversation numbers resolve to the journal's own conversation IDs.
            const known = new Map<number, ConversationId>();

            for (const record of (
              await work.storage.scanConversations({}, 10_000, undefined, BACKGROUND_CONTEXT)
            ).items)
              known.set(record.id, record.id);

            const prompt = packetReviewPrompt(review.scope, {
              provider: review.provider,
              role: "sheet",
              firmChecklist: review.firmChecklist,
            });

            const setup = review.parallel.setup ?? setupSnapshot(review);

            // Fields shared by every sheet reviewer come first, most stable first, so the
            // provider can serve them from the prefix the first reviewer cached. They come from
            // the setup snapshot, not from facts peers record while the sheets are reviewed.
            const opening = {
              stage: "sheet",
              request: review.request,
              scope: review.scope,
              inventory: review.sheets.map(({ id, label, pageIndex, documentName }) => ({
                id,
                label,
                pageIndex,
                documentName,
              })),
              projectConfiguration: setup.projectConfiguration,
              sources: setup.sources,
            };

            const reviewSheet = async (sheetId: string) => {
              const current = await run(get(row.project_id, row.id));
              const sheet = current.sheets.find((item) => item.id === sheetId);
              const entry = current.parallel?.sheets.find((item) => item.sheetId === sheetId);

              if (
                work.lease.closed ||
                current.state !== "running" ||
                sheet === undefined ||
                entry === undefined
              )
                return;

              const stored =
                entry.conversationId === null ? undefined : known.get(entry.conversationId);

              const conversation =
                (stored === undefined
                  ? undefined
                  : await harness.conversation(stored, BACKGROUND_CONTEXT)) ??
                (await harness.createConversation(
                  {
                    ownership: { kind: "ownerless" },
                    agent: {
                      model: work.agent.model,
                      instructions: prompt,
                      thinkingLevel: work.agent.thinkingLevel,
                      tools: work.toolsFor("sheet"),
                    },
                  },
                  BACKGROUND_CONTEXT,
                ));

              work.assignments.sheets.set(conversation.id, sheet.id);
              work.children.set(conversation.id, conversation);
              await sheetState(sheet.id, { conversationId: conversation.id, state: "running" });

              const settled = await (
                await conversation.submit(
                  {
                    type: "input",
                    requestId: requestId(`sheet:${sheet.id}`),
                    content: JSON.stringify({
                      ...opening,
                      continuation:
                        entry.conversationId === null
                          ? null
                          : "Continue this sheet from its recorded coverage and findings. Do not repeat completed checks.",
                      sheet: {
                        id: sheet.id,
                        label: sheet.label,
                        pageIndex: sheet.pageIndex,
                        documentName: sheet.documentName,
                        discipline: sheet.discipline ?? null,
                      },
                      requiredChecks: packetCoverageProgress(current)
                        .gaps.filter((gap) => gap.sheetId === sheet.id)
                        .map(({ discipline, pass, reason }) => ({ discipline, pass, reason })),
                      previousFindings: withoutFocus(
                        current.findings.filter((finding) =>
                          finding.locations.some((location) => location.sheetId === sheet.id),
                        ),
                      ),
                      previousComments: current.priorComments.filter((comment) =>
                        (comment.revisionTargetSheetIds ?? []).includes(sheet.id),
                      ),
                    }),
                  },
                  BACKGROUND_CONTEXT,
                )
              ).wait(BACKGROUND_CONTEXT);

              const after = await run(get(row.project_id, row.id));

              const reported = after.parallel?.sheets.find((item) => item.sheetId === sheet.id);
              const stopped = reported?.state === "failed";

              const pendingSummaries = after.findings.some(
                (finding) =>
                  finding.summary?._tag === "Pending" && finding.summary.sheetId === sheet.id,
              );

              const notes = pendingSummaries ? undefined : reported?.notes;

              await sheetState(
                sheet.id,
                {
                  // A sheet without notes when the review pauses or stops waits for resume. One
                  // that ends without finish_sheet has handed the coordinator nothing to compare.
                  state: stopped
                    ? "failed"
                    : after.state !== "running" && notes === undefined
                      ? "queued"
                      : settled.status === "done" && notes !== undefined
                        ? "completed"
                        : "failed",
                },
                false,
              );
            };

            const queue = review.parallel.sheets
              .filter((entry) => entry.state !== "completed")
              .map((entry) => entry.sheetId);

            const next = async () => {
              for (let sheetId = queue.shift(); sheetId !== undefined; sheetId = queue.shift())
                await reviewSheet(sheetId).catch(() =>
                  sheetState(sheetId, { state: "failed" }, false).catch(() => undefined),
                );
            };

            // Started together, every reviewer would miss the cache. One goes first; the rest
            // start once its opening request settles, reusing the prefix it cached.
            const first = next();
            let timer: ReturnType<typeof setTimeout> | undefined;

            await Promise.race([
              work.assignments.warmed.promise,
              first,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, prefixWarmupMs);
              }),
            ]);
            clearTimeout(timer);

            await Promise.all([
              first,
              ...Array.from(
                { length: Math.min(review.parallel.concurrency - 1, queue.length) },
                next,
              ),
            ]);

            review = await run(get(row.project_id, row.id));

            if (review.state !== "running" || work.lease.closed) return replaced;
            review = await stage("coordination");
          }

          const progress = packetCoverageProgress(review);
          const gaps = new Map<string, number>();

          for (const gap of progress.gaps) gaps.set(gap.sheetId, (gaps.get(gap.sheetId) ?? 0) + 1);

          // Coordination gets the whole review's tools; the list stays fixed for this stage.
          await root.configure({ tools: work.toolsFor("coordination") }, BACKGROUND_CONTEXT);

          return await (
            await root.submit(
              {
                type: "input",
                requestId: requestId("coordination"),
                content: JSON.stringify({
                  stage: "coordination",
                  request: review.request,
                  scope: review.scope,
                  sheetReviews: (review.parallel?.sheets ?? []).map((entry) => ({
                    sheetId: entry.sheetId,
                    label: review.sheets.find((sheet) => sheet.id === entry.sheetId)?.label ?? "",
                    state: entry.state,
                    unsettledChecks: gaps.get(entry.sheetId) ?? 0,
                    notes: entry.notes ?? null,
                  })),
                  coverage: {
                    total: progress.total,
                    recorded: progress.recorded,
                    settled: progress.settled,
                  },
                  findings: review.findings.map(
                    ({ id, title, severity, discipline, locations, decision }) => ({
                      id,
                      title,
                      severity,
                      discipline,
                      sheetIds: locations.map((location) => location.sheetId),
                      decision: decision === undefined ? null : decision,
                    }),
                  ),
                  followUpInstructions: work.input.followUpInstructions,
                }),
              },
              BACKGROUND_CONTEXT,
            )
          ).wait(BACKGROUND_CONTEXT);
        };

        const launch = async (row: Row, existing: boolean, resumeRequestId?: string) => {
          if (runtimes.has(row.id) || starting.has(row.id)) return;
          const launched = Promise.withResolvers<void>();
          starting.set(row.id, launched.promise);

          try {
            const provider = config.providers.find(
              (item) => (item.provider ?? "meta") === row.payload.provider,
            );

            if (!provider)
              throw error("unavailable", "The selected model's provider is not connected.");

            const capabilities = reviewModelCapabilities(row.payload.model);

            const assignments: SheetAssignments = {
              sheets: new Map(),
              requests: new Map(),
              inFlight: new Set(),
              warmed: Promise.withResolvers(),
            };

            const roleOf = (taskId: number) => {
              if (row.payload.parallel === undefined) return "review" as const;
              const conversation = assignments.requests.get(taskId);

              return conversation !== undefined && assignments.sheets.has(conversation)
                ? ("sheet" as const)
                : ("coordinator" as const);
            };

            // One key per shared prefix: every sheet reviewer of a project shares one, and the
            // coordinator's setup and coordination turns share another.
            const cacheKeys = new Map(
              (["review", "coordinator", "sheet"] as const).map((role) => [
                role,
                promptCacheKey(
                  role,
                  row.payload.model,
                  row.project_id,
                  packetReviewPrompt(row.payload.scope, {
                    provider: row.payload.provider,
                    role,
                    firmChecklist: row.payload.firmChecklist,
                  }),
                ),
              ]),
            );

            for (const entry of row.payload.parallel?.sheets ?? [])
              if (entry.conversationId !== null)
                assignments.sheets.set(entry.conversationId, entry.sheetId);

            const toolRegistry = registryFor(row, assignments);

            const admitted = createAdmittedModels(
              { ...provider, model: row.payload.model },
              {
                packetReview: true,
                maxInputTokens: 4 * capabilities.contextWindow,
                maxOutputTokens: capabilities.maxOutputTokens ?? capabilities.contextWindow,
                cacheKey: (phase) => cacheKeys.get(roleOf(phase["task.id"])),
                begin: (phase, fingerprint) =>
                  run(
                    query(
                      Effect.gen(function* () {
                        const current = yield* load(row.project_id, row.id);
                        yield* assertActive(current);
                        const saved = yield* receipt(current, phase["task.id"], phase.attempt);

                        if (saved) {
                          if (
                            saved.fingerprint !== fingerprint ||
                            saved.status !== "completed" ||
                            saved.response_json === null
                          )
                            return yield* error(
                              "uncertain",
                              "This provider attempt is unresolved or changed; it will not be sent again.",
                            );

                          return saved.response_json;
                        }

                        // Until a sheet reviewer starts, every admitted call is the coordinator's
                        // setup work, including any after finish_setup in the same run. At the
                        // limit setup ends with what it recorded; unknown facts stay unrecorded.
                        const parallel = current.payload.parallel;

                        if (
                          parallel !== undefined &&
                          parallel.stage !== "coordination" &&
                          parallel.sheets.every((entry) => entry.conversationId === null) &&
                          current.payload.admittedCalls >= setupLimits.requests
                        ) {
                          if (parallel.stage === "setup")
                            yield* save(current, startSheets(current.payload));

                          return setupEnded;
                        }

                        const sql = yield* SqlClient.SqlClient;

                        const unresolved = yield* Schema.decodeUnknownEffect(UnresolvedAttempts)(
                          yield* sql`SELECT task_id,attempt FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain'`,
                        );

                        if (
                          blocksRequest(
                            assignments,
                            unresolved,
                            assignments.requests.get(phase["task.id"]),
                          )
                        )
                          return yield* error(
                            "uncertain",
                            "An earlier provider attempt is unresolved.",
                          );

                        if (
                          current.payload.maxCalls !== null &&
                          current.payload.admittedCalls >= current.payload.maxCalls
                        ) {
                          return yield* error(
                            "budget",
                            "The optional review call budget was reached.",
                          );
                        }

                        yield* sql`INSERT INTO packet_review_attempts(review_id,task_id,attempt,kind,fingerprint,status,sent) VALUES (${row.id},${phase["task.id"]},${phase.attempt},'model',${fingerprint},'uncertain',0)`;
                        yield* Effect.sync(() =>
                          assignments.inFlight.add(attemptKey(phase["task.id"], phase.attempt)),
                        );
                        yield* save(
                          current,
                          new PacketReview({
                            ...current.payload,
                            admittedCalls: current.payload.admittedCalls + 1,
                          }),
                        );

                        return null;
                      }),
                    ),
                  )
                    .then(async (receipt) => {
                      if (receipt === null || receipt === setupEnded)
                        await run(get(row.project_id, row.id).pipe(Effect.flatMap(publish)));

                      // This request is never sent; its run ends and the sheet reviewers start.
                      if (receipt === setupEnded)
                        throw error(
                          "cancelled",
                          "Setup reached its request limit. The sheet reviewers continue from the recorded configuration.",
                        );
                      toolRegistry.nextRequest(assignments.requests.get(phase["task.id"]));

                      return receipt;
                    })
                    .catch(async (cause) => {
                      if (cause instanceof ExecutionError && cause.reason === "budget")
                        await run(
                          mutate(
                            row.project_id,
                            row.id,
                            (review) =>
                              new PacketReview({
                                ...review,
                                state: "paused",
                                error:
                                  "The optional call budget was reached. Add calls on resume to continue.",
                              }),
                            false,
                          ),
                        );
                      throw cause;
                    }),
                send: (phase) =>
                  run(
                    query(
                      Effect.gen(function* () {
                        const current = yield* load(row.project_id, row.id);
                        yield* assertActive(current, true);
                        const saved = yield* receipt(current, phase["task.id"], phase.attempt);

                        if (saved?.sent !== 0 || saved.status !== "uncertain")
                          return yield* error(
                            "uncertain",
                            "Provider dispatch identity is no longer fresh.",
                          );
                        const sql = yield* SqlClient.SqlClient;
                        yield* sql`UPDATE packet_review_attempts SET sent=1 WHERE review_id=${row.id} AND task_id=${phase["task.id"]} AND attempt=${phase.attempt} AND kind='model'`;
                      }),
                    ),
                  ),
                complete: (phase, response) =>
                  run(
                    query(
                      Effect.gen(function* () {
                        const current = yield* load(row.project_id, row.id);

                        if (current.owner_generation !== config.owner.generation)
                          return yield* error(
                            "conflict",
                            "Provider receipt belongs to an earlier owner.",
                          );
                        const saved = yield* receipt(current, phase["task.id"], phase.attempt);

                        if (saved?.sent !== 1 || saved.status !== "uncertain")
                          return yield* error(
                            "uncertain",
                            "Provider receipt did not match its dispatch.",
                          );
                        const sql = yield* SqlClient.SqlClient;
                        yield* sql`UPDATE packet_review_attempts SET status='completed',response_json=${response} WHERE review_id=${row.id} AND task_id=${phase["task.id"]} AND attempt=${phase.attempt} AND kind='model'`;

                        const { usage } = yield* Schema.decodeUnknownEffect(ReceiptUsage)(
                          response,
                        ).pipe(
                          Effect.mapError(() =>
                            error("uncertain", "Provider receipt usage could not be read."),
                          ),
                        );

                        const conversation = assignments.requests.get(phase["task.id"]);

                        const sheetId =
                          conversation === undefined
                            ? undefined
                            : assignments.sheets.get(conversation);

                        const totals = new PacketReview({
                          ...current.payload,
                          promptUsage: addPromptUsage(current.payload.promptUsage, usage),
                        });

                        yield* save(
                          current,
                          sheetId === undefined
                            ? totals
                            : changeSheet(totals, sheetId, {
                                promptUsage: addPromptUsage(
                                  totals.parallel?.sheets.find((entry) => entry.sheetId === sheetId)
                                    ?.promptUsage,
                                  usage,
                                ),
                              }),
                        );
                      }),
                    ),
                  ),
                end: async (uncertain, diagnostic, phase) => {
                  if (phase !== undefined)
                    assignments.inFlight.delete(attemptKey(phase["task.id"], phase.attempt));

                  const conversation =
                    phase === undefined ? undefined : assignments.requests.get(phase["task.id"]);

                  const sheetId =
                    conversation === undefined ? undefined : assignments.sheets.get(conversation);

                  // Waiting peers may start once any sheet reviewer's request has settled.
                  if (sheetId !== undefined) assignments.warmed.resolve();

                  // An unresolved request stops only the sheet reviewer that sent it.
                  if (uncertain && sheetId !== undefined)
                    await run(
                      mutate(
                        row.project_id,
                        row.id,
                        (review) =>
                          changeSheet(
                            review,
                            sheetId,
                            diagnostic === undefined
                              ? { state: "failed" }
                              : { state: "failed", providerFailure: diagnostic },
                          ),
                        false,
                      ),
                    );
                  else if (uncertain)
                    await run(
                      mutate(
                        row.project_id,
                        row.id,
                        (review) =>
                          new PacketReview({
                            ...review,
                            state: review.state === "cancelled" ? "cancelled" : "uncertain",
                            providerFailure: diagnostic ?? null,
                            error: Match.value(diagnostic?.category).pipe(
                              Match.when(
                                "timeout",
                                () =>
                                  "The provider request timed out. Findings and coverage were saved. The request may have been charged and will not be sent again.",
                              ),
                              Match.when(
                                "http",
                                () =>
                                  `The provider returned HTTP ${diagnostic?.httpStatus ?? "error"}${Match.value(
                                    diagnostic?.detail,
                                  ).pipe(
                                    Match.when("image_limit", () => " (too many images)"),
                                    Match.when("context_limit", () => " (context limit)"),
                                    Match.orElse(() => ""),
                                  )}. Findings and coverage were saved. The request may have been charged and will not be sent again.`,
                              ),
                              Match.orElse(
                                () =>
                                  "The provider did not return a complete response. Findings and coverage were saved. The request may have been charged and will not be sent again.",
                              ),
                            ),
                          }),
                        false,
                      ),
                    );
                  else await run(get(row.project_id, row.id).pipe(Effect.flatMap(publish)));
                },
              },
            );

            const storage = await openReviewJournal(
              config.owner.canonicalDirectory,
              row.journal_id,
              existing,
            );

            let harness: Harness;

            try {
              harness = await Harness.open(
                storage,
                {
                  models: admitted.models,
                  registry: toolRegistry.registry,
                  telemetry: admitted.telemetry,
                  settings: {
                    retry: { enabled: false, maxRetries: 0 },
                    stream: { transport: "sse", maxRetries: 0 },
                    compaction: {
                      enabled: true,
                      reserveTokens: Math.min(
                        131072,
                        Math.floor(admitted.capabilities.contextWindow / 4),
                      ),
                      backgroundTokens: 0,
                    },
                    toolExecution: "sequential",
                    // Settle queued steering before the host waits for its admission leases.
                    afterFailedRun: "withdraw",
                  },
                },
                BACKGROUND_CONTEXT,
              );
            } catch (cause) {
              await storage.close(BACKGROUND_CONTEXT);
              throw cause;
            }

            const thinkingLevel = row.payload.provider === "meta" ? "xhigh" : "high";

            // A parallel coordinator starts with setup's tools; coordination widens them once.
            const root = await harness.root(BACKGROUND_CONTEXT, {
              agent: {
                model: admitted.model,
                instructions: packetReviewPrompt(row.payload.scope, {
                  provider: row.payload.provider,
                  role: row.payload.parallel === undefined ? "review" : "coordinator",
                  firmChecklist: row.payload.firmChecklist,
                }),
                thinkingLevel,
                tools: toolRegistry.toolsFor(
                  row.payload.parallel === undefined ? "review" : "setup",
                ),
              },
            });

            // Explicit resume carries unresolved instructions into its own durable input.
            // A stopped Pi submission can remain `unanswered` even when its text is in the journal.
            const resumedInstructions = existing
              ? (row.payload.steering ?? []).filter((item) => item.status !== "applied")
              : [];

            const resumedInstructionIds = new Set(
              resumedInstructions.map((item) => item.commandId),
            );

            if (resumedInstructionIds.size)
              await run(
                mutate(
                  row.project_id,
                  row.id,
                  (review) =>
                    new PacketReview(
                      Struct.assign(review, {
                        steering: (review.steering ?? []).map((item) =>
                          resumedInstructionIds.has(item.commandId)
                            ? { ...item, status: "queued" as const }
                            : item,
                        ),
                      }),
                    ),
                ),
              );

            const input = {
              continuation: existing
                ? "Continue the saved review from its coverage and findings. Do not repeat completed checks; retain stable issue IDs."
                : null,
              request: row.payload.request,
              conversation: row.payload.conversationContext ?? [],
              inventory: row.payload.sheets,
              scope: row.payload.scope,
              previousFindings: withoutFocus(row.payload.findings),
              previousComments: row.payload.priorComments,
              followUpInstructions: resumedInstructions.map(({ commandId, text }) => ({
                commandId,
                text,
              })),
            };

            const steering: Runtime["steering"] = {
              accepting: true,
              pending: new Set(),
              unanswered: false,
              admissions: new Map(),
            };

            const children = new Map<number, Conversation>();
            const lease = { closed: false };

            const work: Promise<{ readonly status: string }> =
              row.payload.parallel === undefined
                ? (
                    await root.submit(
                      {
                        type: "input",
                        requestId: resumeRequestId ?? row.id,
                        content: JSON.stringify(input),
                      },
                      BACKGROUND_CONTEXT,
                    )
                  ).wait(BACKGROUND_CONTEXT)
                : reviewInParallel({
                    row,
                    harness,
                    storage,
                    root,
                    children,
                    assignments,
                    toolsFor: toolRegistry.toolsFor,
                    agent: { model: admitted.model, thinkingLevel },
                    input,
                    requestId: resumeRequestId ?? row.id,
                    lease,
                  });

            const done = work
              .then(async (result) => {
                steering.accepting = false;

                while (steering.pending.size) await Promise.all(steering.pending);

                const value = await run(
                  query(
                    Effect.gen(function* () {
                      const current = yield* load(row.project_id, row.id);

                      if (
                        current.owner_generation !== config.owner.generation ||
                        current.payload.state !== "running"
                      )
                        return current.payload;
                      const sql = yield* SqlClient.SqlClient;

                      const unresolved =
                        yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain' LIMIT 1`;

                      let summary = current.payload.summary;

                      if (!summary) {
                        const rows = yield* Schema.decodeUnknownEffect(
                          Schema.Array(
                            Schema.Struct({
                              response_json: Schema.fromJsonString(ResponseReceipt),
                            }),
                          ),
                        )(
                          yield* sql`SELECT response_json FROM packet_review_attempts WHERE review_id=${row.id} AND kind='model' AND status='completed' ORDER BY task_id DESC LIMIT 1`,
                        );

                        summary =
                          rows[0]?.response_json.content
                            .flatMap((part) => (part.type === "text" ? [part.text] : []))
                            .join("\n")
                            .trim()
                            .slice(0, 32000) ?? "";
                      }

                      const pendingSummaries = current.payload.findings.some(
                        (finding) => finding.summary?._tag === "Pending",
                      );

                      const state = unresolved.length
                        ? "uncertain"
                        : result.status === "done" &&
                            current.payload.finished &&
                            !pendingSummaries &&
                            !steering.unanswered &&
                            (current.payload.steering ?? []).every(
                              (item) =>
                                item.status === "applied" ||
                                resumedInstructionIds.has(item.commandId),
                            )
                          ? "completed"
                          : "failed";

                      const stoppedSheets = (current.payload.parallel?.sheets ?? []).filter(
                        (entry) => entry.providerFailure !== undefined,
                      );

                      // A sheet reviewer's provider failure explains an uncertain parallel review.
                      const inheritedFailure = current.payload.providerFailure
                        ? undefined
                        : stoppedSheets[0]?.providerFailure;

                      const payload =
                        inheritedFailure === undefined
                          ? current.payload
                          : new PacketReview(
                              Struct.assign(current.payload, { providerFailure: inheritedFailure }),
                            );

                      const review = yield* save(
                        current,
                        new PacketReview({
                          ...payload,
                          state,
                          summary,
                          steering: (current.payload.steering ?? []).map((item) =>
                            resumedInstructionIds.has(item.commandId) || item.status !== "applied"
                              ? {
                                  ...item,
                                  status:
                                    state === "completed"
                                      ? ("applied" as const)
                                      : ("unanswered" as const),
                                }
                              : item,
                          ),
                          error:
                            state === "failed"
                              ? pendingSummaries
                                ? "Full technical findings are saved, but short summaries remain pending. The review is incomplete."
                                : current.payload.finished
                                  ? "The review stopped before finishing. Saved findings and coverage remain available."
                                  : "The reviewer stopped without recording a completed source review. Saved findings, coverage and the partial summary remain available."
                              : state === "uncertain" && stoppedSheets.length > 0
                                ? `${stoppedSheets.length} of ${current.payload.parallel?.sheets.length ?? 0} sheet reviewers stopped on an unresolved provider request. Their sheets keep their gaps; those requests may have been charged and will not be sent again.`
                                : current.payload.error,
                        }),
                      );

                      if (summary) yield* appendMessage(current, summary);

                      return review;
                    }),
                  ),
                );

                await run(publish(value));
              })
              .catch(async () => {
                await run(
                  mutate(
                    row.project_id,
                    row.id,
                    (review) =>
                      review.state === "running"
                        ? new PacketReview({
                            ...review,
                            state: "failed",
                            steering: (review.steering ?? []).map((item) =>
                              resumedInstructionIds.has(item.commandId)
                                ? { ...item, status: "unanswered" as const }
                                : item,
                            ),
                            error:
                              "The review stopped. Its records remain available; unresolved provider work is not retried.",
                          })
                        : review,
                    false,
                  ),
                ).catch(() => undefined);
              });

            runtimes.set(row.id, { harness, root, children, lease, done, steering });
          } finally {
            starting.delete(row.id);
            launched.resolve();
          }
        };

        const start = Effect.fn("PacketReviews.start")(function* (
          input: typeof StartPacketReview.Type,
        ) {
          const request = yield* Schema.decodeUnknownEffect(StartPacketReview)(input).pipe(
            Effect.mapError(() => error("input", "The packet review request is invalid.")),
          );

          const fingerprint = JSON.stringify(request);

          const previous = yield* query(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              return (yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
                yield* sql`SELECT * FROM packet_reviews WHERE command_id=${request.commandId}`,
              ))[0];
            }),
          );

          if (previous) {
            if (previous.fingerprint !== fingerprint)
              return yield* error(
                "conflict",
                "This request identity already refers to a different review.",
              );

            return previous.payload;
          }

          if (closing) return yield* error("cancelled", "The review service is closing.");
          const state = yield* asExecution(config.review.snapshot(request.projectId, 0));
          const project = state.project;

          const message = state.messages.find(
            (item) =>
              item.id === request.messageId &&
              item.conversationId === request.conversationId &&
              item.role === "reviewer",
          );

          if (
            !project ||
            !message ||
            !state.conversations.some((item) => item.id === request.conversationId)
          )
            return yield* error(
              "input",
              "Save the request in this project's conversation before starting review.",
            );

          // A preset identity is recorded only for the exact preset text.
          if (request.preset !== undefined && message.text !== initialReview.text)
            return yield* error(
              "input",
              "The saved request does not match its Initial Review preset.",
            );

          if (!state.sheets.length)
            return yield* error("input", "Import the drawing packet before starting its review.");
          const model = reviewModels.find((item) => item.id === request.model);

          if (
            !model ||
            !config.providers.some((item) => (item.provider ?? "meta") === model.provider)
          )
            return yield* error(
              "unavailable",
              "Connect the selected model's provider before starting review. Your message is saved.",
            );

          const selection = request.selection;

          if (
            selection &&
            !state.revisions.some((revision) => revision.id === selection.revisionId)
          )
            return yield* error("input", "Choose an imported revision for this review.");

          if (selection?.mode === "discipline" && request.discipline === "auto")
            return yield* error("input", "Choose a discipline for this scope.");

          const scope = Match.value(selection?.mode).pipe(
            Match.when("whole_set", () => PacketScope.cases.WholeSet.make({})),
            Match.when("selected_sheets", () => PacketScope.cases.SelectedSheets.make({})),
            Match.when("discipline", () =>
              PacketScope.cases.Discipline.make({
                discipline: Schema.decodeUnknownSync(ReviewDiscipline)(request.discipline),
              }),
            ),
            Match.orElse(() => selectPacketReviewScope(message.text, request.discipline)),
          );

          const candidates = selection
            ? state.sheets.filter((sheet) => sheet.revisionId === selection.revisionId)
            : state.sheets;

          if (
            selection?.mode === "selected_sheets" &&
            selection.sheetIds.some((id) => !candidates.some((sheet) => sheet.id === id))
          )
            return yield* error("input", "Selected sheets must belong to the chosen revision.");

          const selectedSheets = Match.value(selection?.mode).pipe(
            Match.when("selected_sheets", () =>
              candidates.filter((sheet) => selection?.sheetIds.includes(sheet.id)),
            ),
            Match.when("discipline", () =>
              candidates.filter((sheet) => sheet.discipline === request.discipline),
            ),
            Match.orElse(() => candidates),
          );

          if (!selectedSheets.length)
            return yield* error(
              "input",
              "No sheets match this scope. Select sheets or assign their discipline first.",
            );

          const earlier = (yield* list(request.projectId)).find(
            (item) => item.conversationId === request.conversationId,
          );

          // The review keeps the checklist it started with, through resumes and cloud runs.
          const firm = yield* checklist;

          const sheets = selectedSheets.map((sheet) => {
            const revision = state.revisions.find((item) => item.id === sheet.revisionId);

            if (!revision) throw error("input", "A packet source revision is missing.");

            return {
              id: sheet.id,
              revisionId: sheet.revisionId,
              label: sheet.label,
              pageIndex: sheet.pageIndex,
              box: sheet.box,
              sha256: revision.sha256,
              documentName: revision.name,
              discipline: sheet.discipline ?? null,
            };
          });

          const timestamp = now(yield* DateTime.now);

          const unchanged = sheets.filter((sheet) =>
            earlier?.sheets.some((previous) => samePacketSheetSource(previous, sheet)),
          );

          const revisionTargets = sheets
            .filter((sheet) => !unchanged.some((previous) => previous.id === sheet.id))
            .map((sheet) => sheet.id);

          const unmarked = new PacketReview({
            id: randomUUID(),
            projectId: project.id,
            projectName: project.name,
            conversationId: request.conversationId,
            requestId: request.messageId,
            request: message.text,
            scope,
            model: request.model,
            provider: model.provider,
            state: "running",
            version: 0,
            startedAt: timestamp,
            changedAt: timestamp,
            activeDurationMs: 0,
            activeSince: timestamp,
            providerFailure: null,
            maxCalls: request.maxCalls,
            admittedCalls: 0,
            promptVersion,
            instructionRevision: reviewInstructionRevision,
            sheets,
            inspectedSheetIds: (earlier?.inspectedSheetIds ?? []).filter((id) =>
              unchanged.some((sheet) => sheet.id === id),
            ),
            baselineSheetIds: unchanged.map((sheet) => sheet.id),
            inspectedThisReviewSheetIds: [],
            evidenceIds: earlier?.evidenceIds ?? [],
            conversationContext: state.messages
              .filter((item) => item.conversationId === request.conversationId)
              .slice(-24)
              .map(({ role, text }) => ({ role, text })),
            projectConfiguration: earlier?.projectConfiguration ?? {},
            coverage: initializePacketCoverage(
              scope,
              sheets,
              earlier ? { sheets: earlier.sheets, coverage: earlier.coverage } : undefined,
            ),
            sources: earlier?.sources ?? [],
            citations: earlier?.citations ?? [],
            calculations: earlier?.calculations ?? [],
            findings: earlier?.findings ?? [],
            priorComments: (earlier?.priorComments ?? []).map((comment) =>
              (comment.status === "Open" || comment.status === "Partly resolved") &&
              revisionTargets.length > 0
                ? { ...comment, revisionTargetSheetIds: revisionTargets }
                : comment,
            ),
            summary: "",
            missingInputs: [],
            error: null,
            finished: false,
          });

          const checked =
            firm === null || firm.text === ""
              ? unmarked
              : new PacketReview(
                  Struct.assign(unmarked, {
                    firmChecklist: { revision: firm.revision, text: firm.text },
                  }),
                );

          // A preset's identity is recorded beside the prompt version and instruction revision.
          const planned =
            request.preset === undefined
              ? checked
              : new PacketReview(Struct.assign(checked, { preset: request.preset }));

          const parallel = config.parallel ?? defaultParallel;
          const unsettled = new Set(packetCoverageProgress(planned).gaps.map((gap) => gap.sheetId));

          // Large packets review each sheet that still has unsettled checks in its own conversation.
          const review =
            sheets.length < parallel.minSheets
              ? planned
              : new PacketReview(
                  Struct.assign(planned, {
                    parallel: {
                      stage: "setup" as const,
                      concurrency: parallel.concurrency[model.provider],
                      sheets: sheets.map((sheet) => ({
                        sheetId: sheet.id,
                        conversationId: null,
                        state: unsettled.has(sheet.id)
                          ? ("queued" as const)
                          : ("completed" as const),
                      })),
                    },
                  }),
                );

          const started = yield* query(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              const prior = (yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
                yield* sql`SELECT * FROM packet_reviews WHERE command_id=${request.commandId}`,
              ))[0];

              if (prior) {
                if (prior.fingerprint !== fingerprint)
                  return yield* error(
                    "conflict",
                    "This request identity belongs to another review.",
                  );

                return { row: prior, created: false };
              }

              const conflict =
                yield* sql`SELECT id FROM packet_reviews WHERE project_id=${project.id} AND conversation_id=${request.conversationId} AND json_extract(payload,'$.state') IN ('running','paused','uncertain') LIMIT 1`;

              if (conflict.length)
                return yield* error(
                  "conflict",
                  "Resolve the running, paused or uncertain review in this conversation before starting another.",
                );

              const row = {
                id: review.id,
                project_id: project.id,
                conversation_id: request.conversationId,
                command_id: request.commandId,
                fingerprint,
                source_version: project.sourceVersion,
                owner_generation: config.owner.generation,
                journal_id: randomUUID(),
                engine: journalFormat,
                payload: JSON.stringify(review),
              };

              yield* asExecution(config.owner.assertHeld);
              yield* sql`INSERT INTO packet_reviews ${sql.insert(row)}`;

              return { row: Schema.decodeUnknownSync(Row)(row), created: true };
            }),
          );

          const row = started.row;

          if (!started.created) return row.payload;
          yield* publish(review);
          yield* callback(() => launch(row, false)).pipe(
            Effect.catch((cause) =>
              mutate(
                project.id,
                review.id,
                (value) => new PacketReview({ ...value, state: "failed", error: cause.message }),
                false,
              ).pipe(Effect.andThen(Effect.fail(cause))),
            ),
          );

          return yield* get(project.id, review.id);
        });

        const steer = Effect.fn("PacketReviews.steer")(function* (
          input: typeof SteerPacketReview.Type,
        ) {
          const request = yield* Schema.decodeUnknownEffect(SteerPacketReview)(input).pipe(
            Effect.mapError(() => error("input", "The follow-up instruction is invalid.")),
          );

          return yield* callback(async () => {
            await starting.get(request.reviewId);
            const runtime = runtimes.get(request.reviewId);
            const identity = JSON.stringify(request);
            const concurrent = runtime?.steering.admissions.get(request.commandId);

            if (concurrent) {
              if (concurrent.identity !== identity)
                throw error("conflict", "This instruction identity already has different input.");

              return concurrent.result;
            }

            const result = (async () => {
              const admission = Promise.withResolvers<void>();
              runtime?.steering.pending.add(admission.promise);

              const update = (status: "queued" | "applied" | "unanswered") =>
                mutate(
                  request.projectId,
                  request.reviewId,
                  (review) =>
                    new PacketReview(
                      Struct.assign(review, {
                        steering: (review.steering ?? []).map((item) =>
                          item.commandId === request.commandId
                            ? {
                                ...item,
                                status:
                                  review.state === "cancelled" && item.status !== "applied"
                                    ? "unanswered"
                                    : status,
                              }
                            : item,
                        ),
                      }),
                    ),
                  false,
                );

              let stagedIntent = false;
              let submitted: Awaited<ReturnType<Conversation["submit"]>> | undefined;

              const release = () => {
                admission.resolve();
                runtime?.steering.pending.delete(admission.promise);
              };

              try {
                const staged = await run(
                  query(
                    Effect.gen(function* () {
                      const row = yield* load(request.projectId, request.reviewId);

                      if (row.conversation_id !== request.conversationId)
                        return yield* error(
                          "input",
                          "The instruction belongs to another conversation.",
                        );

                      const prior = row.payload.steering?.find(
                        (item) => item.commandId === request.commandId,
                      );

                      if (prior && prior.text !== request.text)
                        return yield* error(
                          "conflict",
                          "This instruction identity already has different text.",
                        );

                      if (prior && prior.status !== "pending")
                        return { review: row.payload, submit: false };
                      yield* assertActive(row);

                      if (!runtime?.steering.accepting || row.engine !== journalFormat)
                        return yield* error(
                          "conflict",
                          "This review is no longer active here. Your draft was not sent.",
                        );

                      if (prior) return { review: row.payload, submit: true };
                      const sql = yield* SqlClient.SqlClient;

                      const entry = new ReviewMessage({
                        id: request.commandId,
                        projectId: request.projectId,
                        conversationId: request.conversationId,
                        role: "reviewer",
                        text: request.text,
                        createdAt: new Date(now(yield* DateTime.now)).toISOString(),
                      });

                      yield* sql`INSERT INTO review_records(project_id,id,kind,payload) VALUES (${request.projectId},${entry.id},'message',${JSON.stringify(entry)})`;
                      yield* sql`UPDATE review_projects SET version=version+1,payload=json_set(payload,'$.version',version+1) WHERE id=${request.projectId}`;

                      const review = yield* save(
                        row,
                        new PacketReview(
                          Struct.assign(row.payload, {
                            summary: "",
                            finished: false,
                            steering: [
                              ...(row.payload.steering ?? []),
                              {
                                commandId: request.commandId,
                                text: request.text,
                                status: "pending" as const,
                              },
                            ],
                          }),
                        ),
                      );

                      return { review, submit: true };
                    }),
                  ),
                );

                stagedIntent = staged.submit;

                await run(publish(staged.review));

                if (!staged.submit || !runtime) {
                  release();

                  return staged.review;
                }

                // Pi admits asynchronously and an idle steer starts another run. The pending lease
                // owns that continuation through settlement; provider admission still enforces this
                // review's persisted budget/cancellation. Completion must include its outcome.
                const submission = await runtime.root.submit(
                  {
                    type: "input",
                    requestId: request.commandId,
                    content: request.text,
                    whenBusy: "steer",
                  },
                  BACKGROUND_CONTEXT,
                );

                submitted = submission;

                const queued = await run(update("queued"));
                void submission
                  .wait(BACKGROUND_CONTEXT)
                  .then((settled) => {
                    if (settled.status !== "done") runtime.steering.unanswered = true;

                    return run(update(settled.status === "done" ? "applied" : "unanswered"));
                  })
                  .catch(() => {
                    runtime.steering.unanswered = true;

                    return run(update("unanswered"));
                  })
                  .finally(release);

                return queued;
              } catch (cause) {
                // A receipt/update failure after Pi admission must still drain the owned run.
                await submitted?.wait(BACKGROUND_CONTEXT).catch(() => undefined);

                if (stagedIntent && runtime) {
                  runtime.steering.unanswered = true;
                  await run(update("unanswered")).catch(() => undefined);
                }

                release();
                throw cause;
              }
            })();

            runtime?.steering.admissions.set(request.commandId, { identity, result });

            try {
              return await result;
            } finally {
              runtime?.steering.admissions.delete(request.commandId);
            }
          });
        });

        const control = Effect.fn("PacketReviews.control")(function* (input: {
          projectId: typeof ProjectId.Type;
          reviewId: string;
          expectedVersion: number;
          action: "pause" | "resume" | "cancel";
          commandId: typeof CommandId.Type;
          maxCalls?: number | null;
        }) {
          // Close the old scheduler while the persisted review is still paused. Otherwise its
          // completion callback could overwrite a newly resumed run with the old abort outcome.
          if (input.action === "resume") {
            const current = yield* get(input.projectId, input.reviewId);
            const runtime = runtimes.get(input.reviewId);

            if (
              runtime &&
              current.state === "paused" &&
              current.version === input.expectedVersion
            ) {
              yield* query(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;

                  const pending =
                    yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${input.reviewId} AND status='uncertain' LIMIT 1`;

                  if (pending.length)
                    return yield* error(
                      "conflict",
                      "MOKE is still finishing the request it sent before the pause. Its result will be kept; try Resume again in a minute.",
                    );
                }),
              );
              yield* callback(async () => {
                runtime.lease.closed = true;
                await runtime.harness.close(BACKGROUND_CONTEXT);
                await runtime.done;
                runtimes.delete(input.reviewId);
              });
            }
          }

          const value = yield* query(
            Effect.gen(function* () {
              const row = yield* load(input.projectId, input.reviewId);
              const sql = yield* SqlClient.SqlClient;
              const identity = JSON.stringify(input);
              const operation = `control:${input.commandId}`;

              const saved = (yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    result_json: Schema.fromJsonString(
                      Schema.Struct({ fingerprint: Schema.String, value: PacketReview }),
                    ),
                  }),
                ),
              )(
                yield* sql`SELECT result_json FROM packet_review_tools WHERE review_id=${row.id} AND task_id=0 AND operation=${operation}`,
              ))[0];

              if (saved) {
                if (saved.result_json.fingerprint !== identity)
                  return yield* error(
                    "conflict",
                    "This control identity already refers to another action.",
                  );

                return { row, next: saved.result_json.value, replay: true };
              }

              const compatibleControl =
                input.expectedVersion <= row.payload.version &&
                ((input.action === "pause" && ["running", "paused"].includes(row.payload.state)) ||
                  (input.action === "cancel" &&
                    ["running", "paused", "uncertain"].includes(row.payload.state)));

              if (row.payload.version !== input.expectedVersion && !compatibleControl)
                return yield* error(
                  "conflict",
                  "Review progress changed. Refresh before controlling it.",
                );

              if (input.action !== "resume" && !compatibleControl)
                return yield* error(
                  "conflict",
                  "This review is already terminal. Refresh its saved result.",
                );

              if (
                input.action === "resume" &&
                (row.payload.state !== "paused" ||
                  row.engine !== journalFormat ||
                  row.payload.promptVersion !== promptVersion)
              )
                return yield* error(
                  "incompatible",
                  "Only a compatible paused review can resume. Uncertain work must not be resent.",
                );

              if (
                input.action === "resume" &&
                input.maxCalls !== undefined &&
                input.maxCalls !== null &&
                (!Number.isSafeInteger(input.maxCalls) ||
                  input.maxCalls <= row.payload.admittedCalls)
              )
                return yield* error(
                  "input",
                  "The resumed call budget must exceed calls already admitted.",
                );

              if (input.action === "resume") {
                const sql = yield* SqlClient.SqlClient;

                const unresolved =
                  yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain' LIMIT 1`;

                if (unresolved.length)
                  return yield* error(
                    "uncertain",
                    "An unresolved provider attempt prevents resuming this review.",
                  );
                yield* sql`UPDATE packet_reviews SET owner_generation=${config.owner.generation} WHERE id=${row.id}`;
              }

              const next = yield* save(
                row,
                new PacketReview({
                  ...row.payload,
                  state: Match.value(input.action).pipe(
                    Match.when("resume", () => "running" as const),
                    Match.when("pause", () => "paused" as const),
                    Match.when("cancel", () => "cancelled" as const),
                    Match.exhaustive,
                  ),
                  steering: (row.payload.steering ?? []).map((item) =>
                    input.action === "cancel" && item.status !== "applied"
                      ? { ...item, status: "unanswered" as const }
                      : item,
                  ),
                  maxCalls:
                    input.action === "resume" && input.maxCalls !== undefined
                      ? input.maxCalls
                      : row.payload.maxCalls,
                  error: input.action === "cancel" ? row.payload.error : null,
                }),
              );

              yield* sql`INSERT INTO packet_review_tools(review_id,task_id,operation,result_json) VALUES (${row.id},0,${operation},${JSON.stringify({ fingerprint: identity, value: next })})`;

              return {
                row: { ...row, owner_generation: config.owner.generation, payload: next },
                next,
                replay: false,
              };
            }),
          );

          if (value.replay) return value.next;
          yield* publish(value.next);

          if (input.action === "cancel")
            for (const controller of samControllers.get(input.reviewId) ?? []) controller.abort();
          const runtime = runtimes.get(input.reviewId);

          if (input.action === "cancel" && runtime)
            for (const conversation of [runtime.root, ...runtime.children.values()])
              void conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined);

          if (input.action === "resume") {
            if (runtime) {
              yield* callback(async () => {
                runtime.lease.closed = true;
                await runtime.harness.close(BACKGROUND_CONTEXT);
                runtimes.delete(input.reviewId);
              });
            }

            yield* callback(() => launch(value.row, true, input.commandId));
          }

          return yield* get(input.projectId, input.reviewId);
        });

        const complete = (input: {
          projectId: typeof ProjectId.Type;
          reviewId: string;
          findingId: string;
          completed: boolean;
          expectedVersion: number;
        }) =>
          mutate(
            input.projectId,
            input.reviewId,
            (review) => {
              if (review.version !== input.expectedVersion)
                throw error(
                  "conflict",
                  "Review progress changed; refresh the issue before updating completion.",
                );

              if (!review.findings.some((finding) => finding.id === input.findingId))
                throw error("input", "The finding is outside this review.");

              return new PacketReview({
                ...review,
                findings: review.findings.map((finding) =>
                  finding.id === input.findingId
                    ? { ...finding, completed: input.completed }
                    : finding,
                ),
              });
            },
            false,
          );

        const decide = (input: {
          projectId: typeof ProjectId.Type;
          reviewId: string;
          findingId: string;
          decision: Pick<typeof PacketFindingDecision.Type, "verdict" | "reason"> | null;
          expectedVersion: number;
        }) =>
          DateTime.now.pipe(
            Effect.flatMap((decided) =>
              mutate(
                input.projectId,
                input.reviewId,
                (review) => {
                  if (review.version !== input.expectedVersion)
                    throw error(
                      "conflict",
                      "Review progress changed; refresh the issue before saving your decision.",
                    );

                  if (!review.findings.some((finding) => finding.id === input.findingId))
                    throw error("input", "The finding is outside this review.");

                  return new PacketReview({
                    ...review,
                    findings: review.findings.map((finding) => {
                      if (finding.id !== input.findingId) return finding;
                      const { decision: _, ...undecided } = finding;

                      return input.decision === null
                        ? undecided
                        : {
                            ...finding,
                            decision: {
                              verdict: input.decision.verdict,
                              reason: input.decision.reason,
                              decidedAt: now(decided),
                            },
                          };
                    }),
                  });
                },
                false,
              ),
            ),
          );

        const saveChecklist = (input: { text: string; expectedRevision: number }) =>
          query(
            Effect.gen(function* () {
              yield* asExecution(config.owner.assertHeld);
              const sql = yield* SqlClient.SqlClient;
              const latest = yield* latestChecklist;

              if ((latest?.revision ?? 0) !== input.expectedRevision)
                return yield* error(
                  "conflict",
                  "The firm checklist changed since you opened it. Reopen settings to see the saved revision.",
                );

              if (latest !== null && latest.text === input.text) return latest;
              const savedAt = now(yield* DateTime.now);
              yield* sql`INSERT INTO firm_checklist_revisions(text,saved_at) VALUES (${input.text},${savedAt})`;

              const saved = yield* latestChecklist;

              if (saved === null)
                return yield* error("unavailable", "The checklist was not saved.");

              return saved;
            }),
          );

        const exportReport = (
          projectId: typeof ProjectId.Type,
          reviewId: string,
          destination: string,
        ) =>
          Effect.gen(function* () {
            const review = yield* get(projectId, reviewId);
            const state = yield* asExecution(config.review.snapshot(projectId, 0));
            const evidence = new Map<string, string>();

            for (const id of new Set(
              review.findings
                .flatMap((finding) =>
                  finding.focus === undefined
                    ? finding.evidenceIds
                    : [finding.focus.artifactId, ...finding.evidenceIds],
                )
                .concat(review.priorComments.flatMap((comment) => comment.evidenceIds)),
            )) {
              const artifact = state.artifacts.find(
                (entry) => entry.id === id && entry.mediaType === "image/png",
              );

              if (!artifact) continue;
              const image = yield* config.review.port.readImage(artifact);
              evidence.set(id, `data:${image.mimeType};base64,${image.data}`);
            }

            if (![".html", ".htm"].includes(extname(destination).toLowerCase()))
              return yield* error("input", "Choose an HTML filename for the review report.");
            yield* callback(async () => {
              const temporary = `${destination}.${randomUUID()}.tmp`;

              try {
                await writeFile(temporary, renderPacketReport(review, evidence), {
                  flag: "wx",
                  flush: true,
                });
                await rename(temporary, destination);
              } finally {
                await rm(temporary, { force: true });
              }
            });
          });

        const close = callback(async () => {
          closing = true;

          const rows = await run(
            query(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;

                return yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
                  yield* sql`SELECT * FROM packet_reviews WHERE owner_generation=${config.owner.generation} AND json_extract(payload,'$.state') IN ('running','paused','uncertain')`,
                );
              }),
            ),
          );

          for (const row of rows)
            await run(
              query(
                Effect.gen(function* () {
                  const current = yield* load(row.project_id, row.id);

                  if (!["running", "paused", "uncertain"].includes(current.payload.state))
                    return current.payload;

                  return yield* settleInterrupted(current);
                }),
              ).pipe(Effect.flatMap(publish)),
            );

          for (const controllers of samControllers.values())
            for (const controller of controllers) controller.abort();
          let timer: ReturnType<typeof setTimeout> | undefined;

          try {
            const done = Promise.all(starting.values())
              .then(() =>
                Promise.all(
                  [...runtimes.values()].map(async (runtime) => {
                    runtime.lease.closed = true;
                    await runtime.harness.close(BACKGROUND_CONTEXT);
                    await runtime.done;
                  }),
                ),
              )
              .then(() => true);

            const drained = await Promise.race([
              done,
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), 3000);
              }),
            ]);

            if (drained) {
              runtimes.clear();

              for (const row of rows)
                await run(
                  query(
                    Effect.gen(function* () {
                      const current = yield* load(row.project_id, row.id);

                      if (!["paused", "uncertain"].includes(current.payload.state))
                        return current.payload;

                      return yield* settleInterrupted(current);
                    }),
                  ).pipe(Effect.flatMap(publish)),
                );
            } else config.owner.retainUntilExit();

            return drained;
          } finally {
            if (timer) clearTimeout(timer);
          }
        });

        yield* query(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
              yield* sql`SELECT * FROM packet_reviews WHERE owner_generation<>${config.owner.generation} AND engine=${journalFormat} AND json_extract(payload,'$.state') IN ('running','paused','uncertain')`,
            );

            for (const row of rows) yield* settleInterrupted(row);
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            callbackEntry = Effect.runPromiseWith(yield* Effect.context<never>());
            yield* close.pipe(
              Effect.tapError(() => Effect.sync(config.owner.retainUntilExit)),
              Effect.ignore,
            );
          }),
        );

        return PacketReviews.of({
          start,
          steer,
          list,
          get,
          control,
          complete,
          decide,
          checklist,
          saveChecklist,
          exportReport,
          observe: (projectId) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(updates);
                const current = yield* list(projectId);

                return Stream.concat(
                  Stream.fromIterable(current.toReversed()),
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((review) => review.projectId === projectId),
                  ),
                );
              }),
            ),
          close,
          quiesce: close.pipe(
            Effect.flatMap((drained) =>
              drained
                ? Effect.sync(() => {
                    closing = false;
                  })
                : Effect.fail(
                    error(
                      "conflict",
                      "Packet reviews did not close safely. Reopen before exporting.",
                    ),
                  ),
            ),
          ),
        });
      }),
    );
  }
}
