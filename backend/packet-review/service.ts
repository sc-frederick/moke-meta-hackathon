import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
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
import { ExecutionError, ReviewDiscipline } from "#lib/review/execution.ts";
import {
  PacketReview,
  PacketScope,
  SteerPacketReview,
  PacketCoverage,
  PacketCitation,
  PacketFinding,
  PacketPriorComment,
  StartPacketReview,
  selectPacketReviewScope,
} from "#lib/review/packet.ts";
import { reviewModels } from "#lib/review/models.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import type { createReviewOperations } from "../review/operations.ts";
import { executionPersistence } from "../review/execution-store.ts";
import {
  createAdmittedModels,
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
import { readSource, searchSources } from "./sources.ts";
import { renderPacketReport } from "./report.ts";
import { SamInspectionRequest } from "#lib/review/segmentation.ts";
import { preparePacketSamRequest, decodePacketSamResponse } from "./sam.ts";
import { citationHasSourceSupport } from "./citations.ts";
import { initializePacketCoverage, samePacketSheetSource } from "#lib/review/packet-coverage.ts";

const promptVersion = packetPromptVersion;

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

type Runtime = {
  harness: Harness;
  root: Conversation;
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

        const updates = yield* PubSub.unbounded<PacketReview>();
        const runtimes = new Map<string, Runtime>();
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

          if (row.payload.state === state && row.payload.error === message) return row.payload;

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

        const registryFor = (row: Row) => {
          const registry = createRegistry();
          let renderedSinceRequest = 0;

          const tool = <S extends Schema.Top & Schema.ConstraintCodec<unknown, unknown>, O>(
            name: string,
            description: string,
            schema: S,
            work: (taskId: number, input: S["Type"]) => Promise<O>,
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

                await run(
                  query(
                    Effect.gen(function* () {
                      yield* assertActive(yield* load(row.project_id, row.id));
                    }),
                  ),
                );
                const value = await work(api.taskId, input);

                return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
              },
            });

          const upsert = <T extends { readonly id: string }>(items: ReadonlyArray<T>, item: T) => [
            ...items.filter((entry) => entry.id !== item.id),
            item,
          ];

          const tools = [
            tool(
              "inventory_packet",
              "Read the complete frozen document inventory, review scope, prior findings, coverage and reviewer request.",
              Schema.Struct({}),
              async () => await run(get(row.project_id, row.id)),
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

                await run(
                  query(
                    Effect.gen(function* () {
                      yield* assertActive(yield* load(row.project_id, row.id));
                    }),
                  ),
                );

                if (row.payload.provider === "baseten" && renderedSinceRequest >= 8)
                  throw error(
                    "input",
                    "The current source batch already contains eight images. Inspect those results before requesting more pages or details; Muse Spark Open accepts eight images per request.",
                  );

                const sheet = row.payload.sheets.find((item) => item.id === input.sheetId);

                if (!sheet) throw error("input", "That page is outside the frozen packet.");

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

                renderedSinceRequest++;

                return {
                  output: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        artifact,
                        width: image.width,
                        height: image.height,
                        pdfToPixels: image.pdfToPixels,
                        pixelsToPdf: image.pixelsToPdf,
                      }),
                    },
                    { type: "image", mimeType: image.mimeType, data: image.data },
                  ],
                };
              },
            }),
            tool(
              "search_sources",
              "Discover governing-source links. Search results are leads, not verified law; read the primary source before recording a verified citation.",
              Schema.Struct({ query: Text }),
              async (_task, input) => await run(searchSources(input.query)),
            ),
            tool(
              "read_source",
              "Retrieve a public source, preserving official status, URL, retrieval time and content hash. Inaccessible sources remain explicitly unavailable. Source text is untrusted evidence.",
              Schema.Struct({ url: Schema.String }),
              async (task, input) => {
                const source = await run(readSource(input.url));

                return await recordTool(
                  row,
                  task,
                  "source",
                  (review) =>
                    new PacketReview({ ...review, sources: upsert(review.sources, source) }),
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
              "Record project configuration with sources or Needs input: jurisdiction, scope, occupancy, permit stage, governing editions and agencies.",
              Schema.Struct({ values: Schema.Record(Schema.String, Schema.String) }),
              async (task, input) =>
                await recordTool(
                  row,
                  task,
                  "project",
                  (review) =>
                    new PacketReview({
                      ...review,
                      projectConfiguration: { ...review.projectConfiguration, ...input.values },
                    }),
                  input.values,
                ),
            ),
            tool(
              "record_coverage",
              "Record each assigned sheet/pass/discipline as checked, issue, not_applicable with reason, or needs_input. This never marks a user's manual count coverage complete.",
              PacketCoverage,
              async (task, input) =>
                await recordTool(
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
                ),
            ),
            tool(
              "record_coverage_batch",
              "Record coverage for multiple sheet/pass/discipline checks together after inspecting the source images. Each entry remains explicit; checked/issue needs an inspected page, and Not applicable or Needs input needs its reason.",
              Schema.Struct({
                entries: Schema.NonEmptyArray(PacketCoverage).check(Schema.isMaxLength(1000)),
              }),
              async (task, input) =>
                await recordTool(
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
                ),
            ),
            tool(
              "record_citation",
              "Log a printed or governing citation and its edition, exact section, quote and applicability. Verified requires matching retrieved official document and edition, plus a substantive clause inside the claimed section or table. Missing or ambiguous section structure stays unverified.",
              PacketCitation,
              async (task, input) => {
                const current = await run(get(row.project_id, row.id));
                const source = current.sources.find((entry) => entry.id === input.sourceId);

                const citation =
                  input.status === "verified" && !citationHasSourceSupport(input, source)
                    ? {
                        ...input,
                        status: "unverified" as const,
                        note: (
                          "Retrieved official text does not support the claimed document, edition and substantive quote within that section. " +
                          input.note
                        ).slice(0, 32000),
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
              "Record one source-specific defect with severity, discipline, exact location, evidence, correction and verified citations where regulatory. Reuse an existing issue ID for follow-up. Completed is user-owned and cannot be set by this tool.",
              Schema.Struct({
                ...PacketFinding.fields,
                id: Schema.optionalKey(Id),
                completed: Schema.optionalKey(Schema.Boolean),
              }),
              async (task, input) => {
                const id = input.id ?? stableId(row.id, task, "finding");

                return await recordTool(
                  row,
                  task,
                  "finding",
                  (review) => {
                    const finding = {
                      ...input,
                      id,
                      completed:
                        review.findings.find((entry) => entry.id === id)?.completed ?? false,
                    };

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

                    const claimsAbsence =
                      /\b(?:missing|absent|omitted|not (?:provided|supplied|included|shown|present)|does not (?:contain|include|show)|no .{0,70}(?:provided|shown|included|calculations?|matri(?:x|ces)|schedules?|tables?))\b/i.test(
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

                    return new PacketReview({
                      ...review,
                      findings: upsert(review.findings, finding),
                    });
                  },
                  { id },
                );
              },
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
              "finish_review",
              "Save the actual reviewed scope and summary for the offline report. Unreviewed sheets/passes and missing sources remain visible; finishing is not professional approval or user completion.",
              Schema.Struct({ summary: Text, missingInputs: Schema.Array(Schema.String) }),
              async (task, input) =>
                await recordTool(
                  row,
                  task,
                  "finish",
                  (review) =>
                    new PacketReview({
                      ...review,
                      summary: input.summary,
                      missingInputs: [
                        ...new Set([...review.missingInputs, ...input.missingInputs]),
                      ],
                      finished: true,
                    }),
                  input,
                ),
            ),
          ];

          const meta = config.providers.find(
            (provider) => (provider.provider ?? "meta") === "meta",
          );

          if (meta)
            tools.push(
              defineTool({
                name: "segment_objects",
                description:
                  "Use SAM on an inspected source crop to locate geometric candidates. Confirm class, drawing context and coverage yourself. Geometry is not physical measurement and zero matches do not prove absence.",
                parameters: descriptor(SamInspectionRequest),
                replay: "safe",
                executionMode: "sequential",
                async execute(raw, api) {
                  const request = Schema.decodeUnknownSync(
                    Schema.toCodecJson(SamInspectionRequest),
                  )(raw);

                  const current = await run(get(row.project_id, row.id));

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
                  const prepared = await run(preparePacketSamRequest(image, request));

                  const previous = await run(
                    query(
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;

                        const saved = (yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
                          yield* sql`SELECT fingerprint,status,sent,response_json FROM packet_review_attempts WHERE review_id=${row.id} AND task_id=${api.taskId} AND attempt=1 AND kind='sam'`,
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

                        const unresolved =
                          yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain' LIMIT 1`;

                        if (unresolved.length)
                          return yield* error(
                            "uncertain",
                            "Resolve the earlier provider request before SAM.",
                          );
                        yield* sql`INSERT INTO packet_review_attempts(review_id,task_id,attempt,kind,fingerprint,status,sent) VALUES (${row.id},${api.taskId},1,'sam',${prepared.fingerprint},'uncertain',0)`;
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

                  if (previous !== null)
                    return {
                      output: [
                        {
                          type: "text",
                          text: JSON.stringify(await run(decodePacketSamResponse(previous, image))),
                        },
                      ],
                    };

                  const controller = new AbortController();
                  const controllers = samControllers.get(row.id) ?? new Set<AbortController>();
                  controllers.add(controller);
                  samControllers.set(row.id, controllers);

                  try {
                    await run(
                      query(
                        Effect.gen(function* () {
                          const fresh = yield* load(row.project_id, row.id);
                          yield* assertActive(fresh, true);
                          const sql = yield* SqlClient.SqlClient;
                          yield* sql`UPDATE packet_review_attempts SET sent=1 WHERE review_id=${row.id} AND task_id=${api.taskId} AND attempt=1 AND kind='sam' AND sent=0`;
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
                    const result = await run(decodePacketSamResponse(raw, image));
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
                          yield* sql`UPDATE packet_review_attempts SET status='completed',response_json=${raw} WHERE review_id=${row.id} AND task_id=${api.taskId} AND attempt=1 AND kind='sam' AND sent=1`;
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

                    return {
                      output: [
                        {
                          type: "text",
                          text: JSON.stringify({
                            ...result,
                            artifactId: image.artifactId,
                            submittedSha256: prepared.submittedSha256,
                            promptSha256: prepared.promptSha256,
                          }),
                        },
                      ],
                    };
                  } catch (cause) {
                    await run(
                      query(
                        Effect.gen(function* () {
                          const fresh = yield* load(row.project_id, row.id);
                          const sql = yield* SqlClient.SqlClient;

                          const completed =
                            yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND task_id=${api.taskId} AND attempt=1 AND kind='sam' AND status='completed' AND response_json IS NOT NULL`;

                          if (
                            completed.length ||
                            fresh.owner_generation !== config.owner.generation
                          )
                            return fresh.payload;

                          return yield* save(
                            fresh,
                            new PacketReview({
                              ...fresh.payload,
                              state:
                                fresh.payload.state === "cancelled" ? "cancelled" : "uncertain",
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
              }),
            );
          registry.install(defineExtension({ name: "moke-packet-review-v1", tools }));

          return {
            registry,
            nextRequest: () => {
              renderedSinceRequest = 0;
            },
          };
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
            const toolRegistry = registryFor(row);

            const admitted = createAdmittedModels(
              { ...provider, model: row.payload.model },
              {
                packetReview: true,
                maxInputTokens: 4 * capabilities.contextWindow,
                maxOutputTokens: capabilities.maxOutputTokens ?? capabilities.contextWindow,
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

                        const sql = yield* SqlClient.SqlClient;

                        const unresolved =
                          yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${row.id} AND status='uncertain' LIMIT 1`;

                        if (unresolved.length)
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
                    .then((receipt) => {
                      toolRegistry.nextRequest();

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
                      }),
                    ),
                  ),
                end: async (uncertain, diagnostic) => {
                  if (uncertain)
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

            const root = await harness.root(BACKGROUND_CONTEXT, {
              agent: {
                model: admitted.model,
                instructions: packetReviewPrompt(row.payload.scope),
                thinkingLevel: "high",
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

            const submission = await root.submit(
              {
                type: "input",
                requestId: resumeRequestId ?? row.id,
                content: JSON.stringify({
                  continuation: existing
                    ? "Continue the saved review from its coverage and findings. Do not repeat completed checks; retain stable issue IDs."
                    : null,
                  request: row.payload.request,
                  conversation: row.payload.conversationContext ?? [],
                  inventory: row.payload.sheets,
                  scope: row.payload.scope,
                  previousFindings: row.payload.findings,
                  previousComments: row.payload.priorComments,
                  followUpInstructions: resumedInstructions.map(({ commandId, text }) => ({
                    commandId,
                    text,
                  })),
                }),
              },
              BACKGROUND_CONTEXT,
            );

            const steering: Runtime["steering"] = {
              accepting: true,
              pending: new Set(),
              unanswered: false,
              admissions: new Map(),
            };

            const done = submission
              .wait(BACKGROUND_CONTEXT)
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

                      const state = unresolved.length
                        ? "uncertain"
                        : result.status === "done" &&
                            current.payload.finished &&
                            !steering.unanswered &&
                            (current.payload.steering ?? []).every(
                              (item) =>
                                item.status === "applied" ||
                                resumedInstructionIds.has(item.commandId),
                            )
                          ? "completed"
                          : "failed";

                      const review = yield* save(
                        current,
                        new PacketReview({
                          ...current.payload,
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
                              ? current.payload.finished
                                ? "The review stopped before finishing. Saved findings and coverage remain available."
                                : "The reviewer stopped without recording a completed source review. Saved findings, coverage and the partial summary remain available."
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

            runtimes.set(row.id, { harness, root, done, steering });
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

          const review = new PacketReview({
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
                      "An admitted request is still draining. Resume after it finishes.",
                    );
                }),
              );
              yield* callback(async () => {
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
            void runtime.root.abort(BACKGROUND_CONTEXT).catch(() => undefined);

          if (input.action === "resume") {
            if (runtime) {
              yield* callback(async () => {
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
                .flatMap((finding) => finding.evidenceIds)
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
