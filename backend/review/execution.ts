import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Conversation } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Artifact, CommandId, type ProjectId } from "../../src/lib/review/contracts.ts";
import {
  ExecutionError,
  ExecutionReviewContext,
  ExecutionSetup,
  ExecutionStatus,
  RunId,
  StartExecution,
  type ExecutionEvent,
} from "../../src/lib/review/execution.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import { journalFormat, openReviewJournal } from "../inference/journal.ts";
import { createAdmittedModels, type ProviderConfiguration } from "../inference/provider.ts";
import { createReviewTools } from "../inference/tools.ts";
import { ResponseReceipt } from "../inference/response.ts";
import type { SamInspectionRequest } from "#lib/review/segmentation.ts";
import type { RequestPhase } from "../inference/telemetry.ts";
import {
  DetailRequest,
  ExecutionEvidence,
  ExecutionFence,
  ExecutionImage,
  ExecutionSelection,
  type ExecutionPort,
} from "./execution-port.ts";
import { AttemptRecord, executionPersistence, RunRecord } from "./execution-store.ts";
import {
  reviewInstructionRevision,
  reviewPromptVersion,
  selectedReviewPrompt,
} from "./prompts/review-prompt.ts";

/** One parent ManagedRuntime enters callback Effects; this service never creates a runtime. */
export interface ExecutionConfiguration {
  readonly owner: DataDirectoryOwnership["Service"];
  readonly queries: Semaphore.Semaphore;
  readonly port: ExecutionPort;
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions,
  ) => Promise<A>;
  readonly provider?: ProviderConfiguration;
  readonly closeTimeoutMs?: number;
}

type RunKey = typeof RunId.Type;

type ProjectKey = typeof ProjectId.Type;

type Runtime = {
  readonly harness: Harness;
  readonly root: Conversation;
};

const failure = (reason: ExecutionError["reason"], message: string) =>
  new ExecutionError({ reason, message });

const callback = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof ExecutionError
        ? error
        : failure("unavailable", "Execution could not proceed safely."),
  });

/** Stable UUID command identity derived from the immutable journal and durable tool task. */
function executionCommandId(
  journalId: string,
  taskId: number,
  operation = "tool",
): typeof CommandId.Type {
  const bytes = createHash("sha256")
    .update(`review-tool-v1:${journalId}:${taskId}:${operation}`)
    .digest();

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");

  return Schema.decodeUnknownSync(CommandId)(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/** Selected-finding durable execution and controls, independent of domain implementation. */
export class ReviewExecution extends Context.Service<
  ReviewExecution,
  {
    /** Read capability status without exposing provider credentials. */
    readonly setup: Effect.Effect<ExecutionSetup, ExecutionError>;
    readonly start: (
      request: typeof StartExecution.Type,
    ) => Effect.Effect<ExecutionStatus, ExecutionError>;
    readonly status: (
      projectId: ProjectKey,
      runId: RunKey,
    ) => Effect.Effect<ExecutionStatus, ExecutionError>;
    readonly control: (
      projectId: ProjectKey,
      runId: RunKey,
      expectedVersion: number,
      action: "pause" | "resume" | "cancel",
      commandId?: typeof CommandId.Type,
    ) => Effect.Effect<ExecutionStatus, ExecutionError>;
    readonly acknowledge: (
      projectId: ProjectKey,
      runId: RunKey,
      expectedVersion: number,
      commandId: typeof CommandId.Type,
    ) => Effect.Effect<ExecutionStatus, ExecutionError>;
    readonly observe: (
      projectId: ProjectKey,
      afterSequence: number,
    ) => Stream.Stream<ExecutionEvent, ExecutionError>;
    /** Bounded close persists pause/uncertainty first; false means the process must exit holding ownership. */
    readonly close: Effect.Effect<boolean, ExecutionError>;
    /** Drain and close journals for a consistent package, then admit only explicitly requested new work. */
    readonly quiesce: Effect.Effect<void, ExecutionError>;
  }
>()("app/ReviewExecution") {
  /** Requires migrations already applied and ownership held before construction. */
  static layer(configuration: ExecutionConfiguration) {
    return Layer.effect(
      ReviewExecution,
      Effect.gen(function* () {
        const { owner, port } = configuration;
        let callbackEntry = configuration.runPromise;

        const runPromise: ExecutionConfiguration["runPromise"] = (operation, options) =>
          callbackEntry(operation, options);

        const store = executionPersistence(
          join(owner.canonicalDirectory, "app.sqlite"),
          configuration.queries,
        );

        const runtimes = new Map<RunKey, Runtime>();
        const launching = new Set<RunKey>();
        const launchDrained = new Set<Promise<void>>();
        const active = new Map<RunKey, number>();
        const toolAborters = new Map<RunKey, Set<AbortController>>();
        const notifications = yield* PubSub.unbounded<void>();
        yield* Effect.addFinalizer(() => PubSub.shutdown(notifications));
        let closing = false;
        let changed = Promise.withResolvers<void>();

        const wake = () => {
          const previous = changed;
          changed = Promise.withResolvers<void>();
          previous.resolve();
          void runPromise(PubSub.publish(notifications, undefined)).catch(() => undefined);
        };

        const held = owner.assertHeld.pipe(
          Effect.mapError(() => failure("conflict", "Execution ownership was released.")),
        );

        // Reopen never starts Pi. Interrupted transport intent dominates any apparently runnable state.
        yield* held;
        yield* store.query(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(
              yield* sql`SELECT * FROM review_execution_runs`,
            );

            for (const run of rows) {
              const status = yield* store.status(run);

              if (
                status.unresolvedAttempts > 0 &&
                run.state !== "cancelled" &&
                run.state !== "uncertain"
              )
                yield* store.transition(run, "uncertain");
              else if (run.state === "running" || run.state === "pausing")
                yield* store.transition(run, "paused");
            }
          }),
        );

        const enter = async (run: RunRecord) => {
          for (;;) {
            const signal = changed.promise;

            const entered = await runPromise(
              store.query(
                Effect.gen(function* () {
                  yield* held;

                  if (closing) return yield* failure("cancelled", "Execution is closing.");
                  const current = yield* store.load(run.run_id, run.project_id);

                  if (current.owner_generation !== owner.generation)
                    return yield* failure(
                      "conflict",
                      "Execution belongs to another owner generation.",
                    );

                  if (current.state === "paused" || current.state === "pausing") return false;

                  if (current.state !== "running")
                    return yield* failure(
                      current.state === "uncertain" ? "uncertain" : "cancelled",
                      "Execution does not admit another operation.",
                    );
                  active.set(run.run_id, (active.get(run.run_id) ?? 0) + 1);

                  return true;
                }),
              ),
            );

            if (entered) return;
            await signal;
          }
        };

        const leave = async (run: RunRecord, uncertain: boolean) => {
          active.set(run.run_id, Math.max(0, (active.get(run.run_id) ?? 1) - 1));
          await runPromise(
            store.query(
              Effect.gen(function* () {
                const current = yield* store.load(run.run_id, run.project_id);

                if (current.owner_generation !== owner.generation) return;

                if (uncertain && current.state !== "cancelled")
                  yield* store.transition(current, "uncertain");
                else if (current.state === "pausing" && (active.get(run.run_id) ?? 0) === 0)
                  yield* store.transition(current, "paused");
                else yield* store.event(current);
              }),
            ),
          );
          wake();
        };

        const fence = (run: RunRecord, taskId: number, operation = "tool") =>
          new ExecutionFence({
            projectId: run.project_id,
            findingId: run.finding_id,
            runId: run.run_id,
            journalId: run.journal_id,
            ownerGeneration: owner.generation,
            sourceVersion: run.source_version,
            factVersion: run.fact_version,
            commandId: executionCommandId(run.journal_id, taskId, operation),
          });

        const reviewContext = (
          run: RunRecord,
        ): Effect.Effect<typeof ExecutionReviewContext.Type | null, ExecutionError> =>
          run.review_context_json == null
            ? Effect.succeed(null)
            : Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionReviewContext))(
                run.review_context_json,
              ).pipe(
                Effect.mapError(() => failure("storage", "The saved review context is invalid.")),
              );

        const selection = (run: RunRecord) =>
          reviewContext(run).pipe(
            Effect.map((context) =>
              context === null
                ? new ExecutionSelection({ projectId: run.project_id, findingId: run.finding_id })
                : new ExecutionSelection({
                    projectId: run.project_id,
                    findingId: run.finding_id,
                    reviewRequest: context.request,
                  }),
            ),
          );

        const inspect = (run: RunRecord) =>
          selection(run).pipe(
            Effect.flatMap(port.inspect),
            Effect.flatMap(Schema.decodeUnknownEffect(ExecutionEvidence)),
            Effect.flatMap((evidence) =>
              evidence.sourceVersion === run.source_version &&
              evidence.factVersion === run.fact_version &&
              evidence.finding.projectId === run.project_id &&
              evidence.finding.id === run.finding_id
                ? Effect.succeed(evidence)
                : Effect.fail(
                    failure("conflict", "The selected source or facts changed during execution."),
                  ),
            ),
            Effect.mapError((error) =>
              error instanceof ExecutionError
                ? error
                : failure("input", "Selected evidence was invalid."),
            ),
          );

        const tool = async <A>(run: RunRecord, operation: Effect.Effect<A, ExecutionError>) => {
          await enter(run);

          const controller = new AbortController();
          const controllers = toolAborters.get(run.run_id) ?? new Set<AbortController>();
          controllers.add(controller);
          toolAborters.set(run.run_id, controllers);

          try {
            return await runPromise(operation, { signal: controller.signal });
          } finally {
            controllers.delete(controller);
            await leave(run, false);
          }
        };

        const jsonTool = async <A>(run: RunRecord, operation: Effect.Effect<A, ExecutionError>) =>
          JSON.stringify(await tool(run, operation));

        const readImage = (run: RunRecord, artifact: Artifact) =>
          port.readImage(artifact).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ExecutionImage)),
            Effect.flatMap((image) =>
              image.projectId === run.project_id &&
              image.artifactId === artifact.id &&
              image.sheetId === artifact.sheetId &&
              Buffer.byteLength(image.data, "base64") <= 1024 * 1024
                ? Effect.succeed(image)
                : Effect.fail(
                    failure("input", "The model image did not match its selected artifact."),
                  ),
            ),
            Effect.mapError((error) =>
              error instanceof ExecutionError
                ? error
                : failure("input", "The model image was invalid."),
            ),
          );

        const renderEvidence = (
          run: RunRecord,
          taskId: number,
          request: typeof DetailRequest.Type,
        ) =>
          Effect.gen(function* () {
            const selected = yield* inspect(run);

            if (
              request.sheetId !== selected.finding.drawnSheetId &&
              request.sheetId !== selected.finding.scheduledSheetId
            )
              return yield* failure(
                "input",
                "The requested sheet is outside the selected finding.",
              );
            const artifact = yield* port.render(fence(run, taskId), request);

            return { text: JSON.stringify(artifact), images: [yield* readImage(run, artifact)] };
          });

        const inspectEvidence = (run: RunRecord, taskId: number) =>
          Effect.gen(function* () {
            const selected = yield* inspect(run);
            const images: Array<ExecutionImage> = [];

            for (const sheetId of new Set([
              selected.finding.drawnSheetId,
              selected.finding.scheduledSheetId,
            ])) {
              const sheet = selected.sheets.find(
                (item) => item.id === sheetId && item.projectId === run.project_id,
              );

              let artifact = selected.artifacts.find(
                (item) =>
                  item.sheetId === sheetId &&
                  item.projectId === run.project_id &&
                  item.mediaType === "image/png" &&
                  sheet !== undefined &&
                  item.revisionId === sheet.revisionId &&
                  item.region !== null &&
                  item.region.x === sheet.box.x &&
                  item.region.y === sheet.box.y &&
                  item.region.width === sheet.box.width &&
                  item.region.height === sheet.box.height,
              );

              if (artifact === undefined) {
                if (sheet === undefined) continue;
                artifact = yield* port.render(fence(run, taskId, `overview:${sheetId}`), {
                  sheetId,
                  region: sheet.box,
                  missingFact:
                    "Inspect the selected sheet overview to locate the count evidence and missing detail.",
                });
              }

              images.push(yield* readImage(run, artifact));
            }

            return { text: JSON.stringify(selected), images };
          });

        const attempt = (run: RunRecord, phase: RequestPhase) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AttemptRecord))(
              yield* sql`SELECT * FROM review_execution_attempts WHERE journal_id=${run.journal_id} AND task_id=${phase["task.id"]} AND attempt=${phase.attempt}`,
            );

            return rows[0];
          });

        const launch = async (run: RunRecord, existing: boolean) => {
          if (runtimes.has(run.run_id) || launching.has(run.run_id)) return;

          if (closing) throw failure("cancelled", "Execution is closing.");
          launching.add(run.run_id);
          const finished = Promise.withResolvers<void>();
          launchDrained.add(finished.promise);

          try {
            const provider = configuration.provider;

            if (provider === undefined || run.route === "offline")
              throw failure("unavailable", "No inference provider is configured.");

            if ((provider.provider ?? "meta") !== run.provider || provider.route !== run.route)
              throw failure("incompatible", "Execution provider configuration changed.");

            if (run.prompt_version !== reviewPromptVersion)
              throw failure(
                "incompatible",
                "This inspection uses an earlier instruction version. Start a new inspection explicitly.",
              );

            const admitted = createAdmittedModels(provider, {
              maxInputTokens: run.max_input_tokens,
              maxOutputTokens: run.max_output_tokens,
              begin: async (phase, fingerprint) => {
                await enter(run);

                try {
                  await runPromise(inspect(run));

                  return await runPromise(
                    store.query(
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;
                        const current = yield* store.load(run.run_id, run.project_id);
                        const saved = yield* attempt(run, phase);

                        if (saved !== undefined) {
                          if (saved.fingerprint !== fingerprint || saved.status !== "completed")
                            return yield* failure(
                              "uncertain",
                              "An unresolved or changed attempt cannot be dispatched again.",
                            );

                          return saved.response_json;
                        }

                        const status = yield* store.status(current);

                        if (status.unresolvedAttempts > 0)
                          return yield* failure(
                            "uncertain",
                            "An earlier provider attempt is unresolved.",
                          );

                        if (current.admitted_calls >= current.max_calls)
                          return yield* failure("budget", "The admitted call limit was reached.");
                        yield* sql`INSERT INTO review_execution_attempts(journal_id,task_id,attempt,run_id,owner_generation,fingerprint,status,sent) VALUES (${run.journal_id},${phase["task.id"]},${phase.attempt},${run.run_id},${owner.generation},${fingerprint},'uncertain',0)`;
                        yield* sql`UPDATE review_execution_runs SET admitted_calls=admitted_calls+1,reserved_input_tokens=reserved_input_tokens+max_input_tokens,reserved_output_tokens=reserved_output_tokens+max_output_tokens WHERE run_id=${run.run_id}`;

                        return null;
                      }),
                    ),
                  );
                } catch (error) {
                  await leave(run, false);
                  throw error;
                }
              },
              send: (phase) =>
                runPromise(
                  store.query(
                    Effect.gen(function* () {
                      yield* held;
                      const sql = yield* SqlClient.SqlClient;
                      const current = yield* store.load(run.run_id, run.project_id);
                      const saved = yield* attempt(run, phase);

                      if (
                        closing ||
                        current.owner_generation !== owner.generation ||
                        (current.state !== "running" && current.state !== "pausing") ||
                        saved?.sent !== 0 ||
                        saved.owner_generation !== owner.generation
                      )
                        return yield* failure(
                          "cancelled",
                          "Provider dispatch is no longer admitted.",
                        );
                      yield* sql`UPDATE review_execution_attempts SET sent=1 WHERE journal_id=${run.journal_id} AND task_id=${phase["task.id"]} AND attempt=${phase.attempt}`;
                    }),
                  ),
                ),
              complete: (phase, receipt) =>
                runPromise(
                  store.query(
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      const saved = yield* attempt(run, phase);

                      if (
                        saved?.status !== "uncertain" ||
                        saved.sent !== 1 ||
                        saved.owner_generation !== owner.generation
                      )
                        return yield* failure(
                          "conflict",
                          "Provider receipt identity did not match its dispatch.",
                        );
                      // Cancelled runs retain late receipts only as historical evidence; tools still fail admission.
                      yield* sql`UPDATE review_execution_attempts SET status='completed',response_json=${receipt} WHERE journal_id=${run.journal_id} AND task_id=${phase["task.id"]} AND attempt=${phase.attempt}`;
                    }),
                  ),
                ),
              end: (uncertain) => leave(run, uncertain),
            });

            const selectedTools = {
              inspect: (taskId: number) => tool(run, inspectEvidence(run, taskId)),
              render: (
                taskId: number,
                request: typeof import("./execution-port.ts").DetailRequest.Type,
              ) => tool(run, renderEvidence(run, taskId, request)),
              propose: (
                taskId: number,
                proposal: typeof import("./execution-port.ts").CountProposal.Type,
              ) => jsonTool(run, port.propose(fence(run, taskId), proposal)),
              evaluate: (taskId: number) => jsonTool(run, port.evaluate(fence(run, taskId))),
              message: (taskId: number, text: string) =>
                jsonTool(run, port.message(fence(run, taskId), text)),
              finish: (taskId: number, text: string) =>
                jsonTool(run, port.message(fence(run, taskId), text)),
            };

            const segment = (taskId: number, request: SamInspectionRequest) =>
              tool(
                run,
                Effect.gen(function* () {
                  const capability = port.segmentation;

                  if (capability === undefined)
                    return yield* failure("unavailable", "SAM is not configured for this route.");
                  const observation = yield* capability.segment(fence(run, taskId), request);
                  const evidence = yield* inspect(run);

                  const artifact = evidence.artifacts.find(
                    (item) => item.id === request.artifactId,
                  );

                  if (artifact === undefined)
                    return yield* failure("input", "The segmented source is outside this finding.");
                  const { instances, ...receipt } = observation;

                  return {
                    text: JSON.stringify({
                      ...receipt,
                      instances: instances.map((instance) => ({
                        id: instance.id,
                        confidence: instance.confidence,
                        sourcePixelsInclusive: instance.sourcePixelsInclusive,
                        pixels: instance.pixels,
                        pdfBounds: instance.pdfBounds,
                        mask: {
                          encoding: instance.mask.encoding,
                          width: instance.mask.width,
                          height: instance.mask.height,
                          bounds: instance.mask.bounds,
                          confidence: instance.mask.confidence,
                        },
                      })),
                    }),
                    images: [yield* readImage(run, artifact)],
                  };
                }),
              );

            const registry = createReviewTools(
              port.segmentation === undefined ? selectedTools : { ...selectedTools, segment },
            );

            const storage = await openReviewJournal(
              owner.canonicalDirectory,
              run.journal_id,
              existing,
            );

            let harness: Harness;

            try {
              harness = await Harness.open(
                storage,
                {
                  models: admitted.models,
                  registry,
                  telemetry: admitted.telemetry,
                  settings: {
                    retry: { enabled: false, maxRetries: 0 },
                    stream: { transport: "sse", maxRetries: 0 },
                    compaction: { enabled: false, backgroundTokens: 0 },
                    toolExecution: "sequential",
                    afterFailedRun: "keep",
                  },
                },
                BACKGROUND_CONTEXT,
              );
            } catch (error) {
              await storage.close(BACKGROUND_CONTEXT);
              throw error;
            }

            const root = await harness.root(BACKGROUND_CONTEXT, {
              agent: { model: admitted.model },
            });

            const submission = await root.submit(
              {
                type: "input",
                requestId: run.run_id,
                content: selectedReviewPrompt(await runPromise(reviewContext(run))),
              },
              BACKGROUND_CONTEXT,
            );

            void submission
              .wait(BACKGROUND_CONTEXT)
              .then(async (result) => {
                // Pi may already be committed when a paused run resumes. Persisted messages,
                // rather than this launch's tool callbacks, determine whether a reply is missing.
                if (result.status === "done" && run.review_context_json != null) {
                  const answer = await runPromise(
                    store.query(
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;

                        const messages =
                          yield* sql`SELECT id FROM review_records WHERE project_id=${run.project_id} AND kind='message' AND json_extract(payload,'$.role')='application' AND json_extract(payload,'$.origin.runId')=${run.run_id} LIMIT 1`;

                        if (messages.length > 0) return null;

                        const rows = yield* Schema.decodeUnknownEffect(
                          Schema.Array(
                            Schema.Struct({ task_id: Schema.Int, response_json: Schema.String }),
                          ),
                        )(
                          yield* sql`SELECT task_id,response_json FROM review_execution_attempts WHERE run_id=${run.run_id} AND status='completed' ORDER BY task_id DESC LIMIT 1`,
                        );

                        const row = rows[0];

                        if (row === undefined) return null;

                        const response = yield* Schema.decodeUnknownEffect(
                          Schema.fromJsonString(ResponseReceipt),
                        )(row.response_json);

                        const text = response.content
                          .flatMap((part) => (part.type === "text" ? [part.text] : []))
                          .join("\n")
                          .trim();

                        return text.length > 0 ? { taskId: row.task_id, text } : null;
                      }),
                    ),
                  );

                  if (answer !== null) {
                    const text =
                      answer.text.length > 2000
                        ? `${answer.text.slice(0, 1850)}\n[Response shortened. The full provider response is retained in the execution journal.]`
                        : answer.text;

                    await tool(run, port.message(fence(run, answer.taskId, "answer"), text));
                  }
                }

                await runPromise(
                  store.query(
                    Effect.gen(function* () {
                      const current = yield* store.load(run.run_id, run.project_id);

                      if (
                        closing ||
                        current.owner_generation !== owner.generation ||
                        (current.state !== "running" && current.state !== "pausing")
                      )
                        return;
                      const status = yield* store.status(current);
                      yield* store.transition(
                        current,
                        status.unresolvedAttempts > 0
                          ? "uncertain"
                          : result.status === "done"
                            ? "completed"
                            : "failed",
                      );
                    }),
                  ),
                );
                wake();
              })
              .catch(async () => {
                await runPromise(
                  store.query(
                    Effect.gen(function* () {
                      const current = yield* store.load(run.run_id, run.project_id);

                      if (current.state === "running" || current.state === "pausing") {
                        const status = yield* store.status(current);
                        yield* store.transition(
                          current,
                          status.unresolvedAttempts > 0 ? "uncertain" : "failed",
                        );
                      }
                    }),
                  ),
                ).catch(() => undefined);
                wake();
              });

            runtimes.set(run.run_id, { harness, root });
          } catch (error) {
            await runPromise(
              store.query(
                Effect.gen(function* () {
                  const current = yield* store.load(run.run_id, run.project_id);

                  if (current.state === "running" || current.state === "pausing")
                    yield* store.transition(current, existing ? "incompatible" : "failed");
                }),
              ),
            );
            throw error instanceof ExecutionError
              ? error
              : failure(
                  existing ? "incompatible" : "unavailable",
                  existing
                    ? "The execution journal is incompatible or unavailable."
                    : "Execution could not be initialized.",
                );
          } finally {
            launching.delete(run.run_id);
            launchDrained.delete(finished.promise);
            finished.resolve();
          }
        };

        const status = (projectId: ProjectKey, runId: RunKey) =>
          store.query(
            Effect.gen(function* () {
              return yield* store.status(yield* store.load(runId, projectId));
            }),
          );

        const start = Effect.fn("ReviewExecution.start")(function* (
          input: typeof StartExecution.Type,
        ) {
          const request = yield* Schema.decodeUnknownEffect(StartExecution)(input).pipe(
            Effect.mapError(() => failure("input", "The execution request was invalid.")),
          );

          const identity = ["start", request.projectId, request.findingId, request.budget];

          const fingerprint = JSON.stringify(
            request.reviewRequest === undefined ? identity : [...identity, request.reviewRequest],
          );

          const previous = yield* store.query(store.receipt(request.commandId, fingerprint));

          if (previous !== null) return previous;
          yield* held;

          if (closing) return yield* failure("cancelled", "Execution is closing.");

          const provider = configuration.provider;

          if (provider === undefined)
            return yield* failure(
              "unavailable",
              "Configure a supported provider credential before starting a live inspection.",
            );
          const selected = yield* port.inspect(new ExecutionSelection(request));

          const evidence = yield* Schema.decodeUnknownEffect(ExecutionEvidence)(selected).pipe(
            Effect.mapError(() => failure("input", "Selected evidence was invalid.")),
          );

          if (
            evidence.finding.id !== request.findingId ||
            evidence.finding.projectId !== request.projectId
          )
            return yield* failure("input", "Selected finding belongs to another scope.");

          const instruction = evidence.reviewerInstructions?.[0];

          if (request.reviewRequest !== undefined && instruction === undefined)
            return yield* failure(
              "input",
              "The selected conversation request is unavailable. Save the message before starting its review.",
            );

          const context =
            request.reviewRequest === undefined || instruction === undefined
              ? null
              : {
                  request: request.reviewRequest,
                  instruction,
                  instructionRevision: reviewInstructionRevision,
                };

          const run = yield* store.query(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              const replay = yield* store.receipt(request.commandId, fingerprint);

              if (replay !== null) return { run: null, response: replay };

              const conflicting =
                yield* sql`SELECT run_id FROM review_execution_runs r WHERE r.state IN ('running','pausing') OR (r.project_id=${request.projectId} AND r.finding_id=${request.findingId} AND (r.state IN ('paused','uncertain') OR ((EXISTS(SELECT 1 FROM review_execution_attempts a WHERE a.run_id=r.run_id AND a.status='uncertain') OR EXISTS(SELECT 1 FROM review_sam_attempts s WHERE s.run_id=r.run_id AND s.status='uncertain')) AND NOT EXISTS(SELECT 1 FROM review_execution_acknowledgements k WHERE k.run_id=r.run_id)))) LIMIT 1`;

              if (conflicting.length > 0)
                return yield* failure(
                  "conflict",
                  "Resolve the existing execution before starting another attempt.",
                );
              const runId = Schema.decodeUnknownSync(RunId)(randomUUID());
              const providerName = provider.provider ?? "meta";

              const run = {
                run_id: runId,
                project_id: request.projectId,
                finding_id: request.findingId,
                journal_id: randomUUID(),
                engine: journalFormat,
                owner_generation: owner.generation,
                source_version: evidence.sourceVersion,
                fact_version: evidence.factVersion,
                state: "running" as const,
                version: 0,
                route: provider.route,
                provider: providerName,
                model:
                  providerName === "meta" ? "muse-spark-1.3" : "meta-models/muse-spark-open-1026",
                max_calls: request.budget.maxCalls,
                max_input_tokens: request.budget.maxInputTokens,
                max_output_tokens: request.budget.maxOutputTokens,
                admitted_calls: 0,
                reserved_input_tokens: 0,
                reserved_output_tokens: 0,
                prompt_version: reviewPromptVersion,
                review_context_json: context === null ? null : JSON.stringify(context),
              };

              yield* sql`INSERT INTO review_execution_runs ${sql.insert(run)}`;
              yield* store.event(run);

              return {
                run,
                response: yield* store.saveReceipt(request.commandId, fingerprint, run),
              };
            }),
          );

          if (run.run !== null) yield* callback(() => launch(run.run, false));
          wake();

          return run.response;
        });

        const control = Effect.fn("ReviewExecution.control")(function* (
          projectId: ProjectKey,
          runId: RunKey,
          expectedVersion: number,
          action: "pause" | "resume" | "cancel",
          commandId = Schema.decodeUnknownSync(CommandId)(randomUUID()),
        ) {
          const fingerprint = JSON.stringify([
            "control",
            projectId,
            runId,
            expectedVersion,
            action,
          ]);

          const previous = yield* store.query(store.receipt(commandId, fingerprint));

          if (previous !== null) return previous;
          yield* held;

          const run = yield* store.query(
            Effect.gen(function* () {
              const replay = yield* store.receipt(commandId, fingerprint);

              if (replay !== null) return { run: null, response: replay };

              const updated = yield* Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const current = yield* store.load(runId, projectId);

                if (closing || current.version !== expectedVersion)
                  return yield* failure(
                    "conflict",
                    "Execution changed; refresh its status before controlling it.",
                  );

                if (action === "pause") {
                  if (current.state !== "running")
                    return yield* failure("conflict", "Only running work can be paused.");

                  return yield* store.transition(
                    current,
                    (active.get(runId) ?? 0) > 0 ? "pausing" : "paused",
                  );
                }

                if (action === "resume") {
                  const currentStatus = yield* store.status(current);

                  if (currentStatus.unresolvedAttempts > 0 || current.state === "uncertain")
                    return yield* failure(
                      "uncertain",
                      "This attempt is unresolved; automatic resend is prohibited.",
                    );

                  if (
                    current.engine !== journalFormat ||
                    current.prompt_version !== reviewPromptVersion
                  )
                    return yield* failure(
                      "incompatible",
                      "This saved inspection uses an earlier engine or instruction version. Cancel it before starting a separate inspection.",
                    );

                  if (
                    current.state !== "paused" ||
                    configuration.provider === undefined ||
                    current.route === "offline"
                  )
                    return yield* failure("conflict", "This execution cannot be resumed.");

                  const other =
                    yield* sql`SELECT run_id FROM review_execution_runs WHERE run_id<>${runId} AND state IN ('running','pausing') LIMIT 1`;

                  if (other.length > 0)
                    return yield* failure(
                      "conflict",
                      "Another inspection is active. Pause or finish it before resuming.",
                    );
                  yield* sql`UPDATE review_execution_runs SET owner_generation=${owner.generation} WHERE run_id=${runId}`;

                  return yield* store.transition(
                    { ...current, owner_generation: owner.generation },
                    "running",
                  );
                }

                if (
                  current.state === "cancelled" ||
                  current.state === "completed" ||
                  current.state === "failed" ||
                  current.state === "incompatible"
                )
                  return yield* failure("conflict", "This execution is already terminal.");

                return yield* store.transition(current, "cancelled");
              });

              return {
                run: updated,
                response: yield* store.saveReceipt(commandId, fingerprint, updated),
              };
            }),
          );

          if (run.run === null) return run.response;
          wake();

          if (action === "resume") yield* callback(() => launch(run.run, true));

          if (action === "cancel") {
            for (const controller of toolAborters.get(runId) ?? []) controller.abort();
            const runtime = runtimes.get(runId);

            if (runtime !== undefined)
              void runtime.root.abort(BACKGROUND_CONTEXT).catch(() => undefined);
          }

          return run.response;
        });

        const acknowledge = Effect.fn("ReviewExecution.acknowledge")(function* (
          projectId: ProjectKey,
          runId: RunKey,
          expectedVersion: number,
          commandId: typeof CommandId.Type,
        ) {
          const fingerprint = JSON.stringify([
            "acknowledge-possible-charge",
            projectId,
            runId,
            expectedVersion,
          ]);

          const response = yield* store.query(
            Effect.gen(function* () {
              const previous = yield* store.receipt(commandId, fingerprint);

              if (previous !== null) return previous;
              yield* held;
              const current = yield* store.load(runId, projectId);
              const saved = yield* store.status(current);

              if (
                closing ||
                current.version !== expectedVersion ||
                (current.state !== "uncertain" && current.state !== "cancelled") ||
                saved.unresolvedAttempts === 0 ||
                (active.get(runId) ?? 0) > 0
              )
                return yield* failure(
                  "conflict",
                  "Wait for the uncertain inspection to stop and refresh before acknowledging it.",
                );
              const sql = yield* SqlClient.SqlClient;

              const existing =
                yield* sql`SELECT run_id FROM review_execution_acknowledgements WHERE run_id=${runId}`;

              if (existing.length > 0)
                return yield* failure("conflict", "This attempt was already acknowledged.");

              const cancelled =
                current.state === "cancelled"
                  ? current
                  : yield* store.transition(current, "cancelled");

              yield* store.saveReceipt(commandId, fingerprint, cancelled);
              yield* sql`INSERT INTO review_execution_acknowledgements(run_id,command_id,possible_charge_acknowledged) VALUES (${runId},${commandId},1)`;

              const acknowledged = yield* store.status(cancelled);
              yield* sql`UPDATE review_execution_commands SET response_json=${JSON.stringify(acknowledged)} WHERE command_id=${commandId}`;

              return acknowledged;
            }),
          );

          for (const controller of toolAborters.get(runId) ?? []) controller.abort();
          const runtime = runtimes.get(runId);

          if (runtime !== undefined)
            void runtime.root.abort(BACKGROUND_CONTEXT).catch(() => undefined);
          wake();

          return response;
        });

        const close = callback(async () => {
          if (closing) return false;
          closing = true;
          await runPromise(
            store.query(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;

                const rows = yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(
                  yield* sql`SELECT * FROM review_execution_runs WHERE state IN ('running','pausing')`,
                );

                for (const run of rows) {
                  const saved = yield* store.status(run);
                  yield* store.transition(
                    run,
                    saved.unresolvedAttempts > 0 ? "uncertain" : "paused",
                  );
                }
              }),
            ),
          );

          for (const controllers of toolAborters.values())
            for (const controller of controllers) controller.abort();
          wake();
          let timer: ReturnType<typeof setTimeout> | undefined;

          const drained = (async () => {
            await Promise.all(launchDrained);
            await Promise.all(
              [...runtimes.values()].map((runtime) => runtime.harness.close(BACKGROUND_CONTEXT)),
            );

            return true;
          })().catch(() => false);

          const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), configuration.closeTimeoutMs ?? 2000);
          });

          const complete = await Promise.race([drained, timeout]);

          if (timer !== undefined) clearTimeout(timer);

          if (!complete) owner.retainUntilExit();

          return complete;
        }).pipe(Effect.tapError(() => Effect.sync(owner.retainUntilExit)));

        const quiesce = close.pipe(
          Effect.flatMap((complete) => {
            if (!complete)
              return Effect.fail(
                failure(
                  "conflict",
                  "Execution did not close within its deadline. Reopen before exporting or restoring.",
                ),
              );

            return Effect.sync(() => {
              runtimes.clear();
              closing = false;
              wake();
            });
          }),
        );

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // ManagedRuntime marks its entry API disposed before releasing Layers. Reuse its finalizer
            // services for cleanup callbacks, without constructing another ManagedRuntime.
            callbackEntry = Effect.runPromiseWith(yield* Effect.context<never>());
            yield* close.pipe(Effect.ignore);
          }),
        );

        const observe = (projectId: ProjectKey, afterSequence: number) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(notifications);
              let cursor = afterSequence;

              return Stream.concat(
                Stream.succeed(undefined),
                Stream.fromEffect(PubSub.take(subscription)).pipe(Stream.forever),
              ).pipe(
                Stream.flatMap(() =>
                  Stream.paginate(cursor, (next) =>
                    store
                      .query(store.events(projectId, next))
                      .pipe(
                        Effect.map(
                          (events) =>
                            [
                              events,
                              events.length === 200
                                ? Option.some(events.at(-1)?.sequence ?? next)
                                : Option.none(),
                            ] as const,
                        ),
                      ),
                  ),
                ),
                Stream.map((event) => {
                  cursor = event.sequence;

                  return event;
                }),
              );
            }),
          );

        return ReviewExecution.of({
          setup: Effect.succeed(
            new ExecutionSetup({
              configured: configuration.provider !== undefined,
              provider:
                configuration.provider === undefined
                  ? null
                  : (configuration.provider.provider ?? "meta"),
              model:
                configuration.provider === undefined
                  ? null
                  : (configuration.provider.provider ?? "meta") === "meta"
                    ? "muse-spark-1.3"
                    : "meta-models/muse-spark-open-1026",
              segmentation: port.segmentation !== undefined,
              promptVersion: reviewPromptVersion,
              instructionRevision: reviewInstructionRevision,
            }),
          ),
          start,
          acknowledge,
          status,
          control,
          observe,
          close,
          quiesce,
        });
      }),
    );
  }
}
