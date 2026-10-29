import { expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, ManagedRuntime, Redacted, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { DataDirectoryOwnership } from "../../backend/ownership.ts";
import { migrateDatabase } from "../../backend/database-files.ts";
import { ImportedPdf } from "../../backend/documents/types.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { ReviewExecution, type ExecutionConfiguration } from "../../backend/review/execution.ts";
import {
  reviewInstructionRevision,
  reviewPromptVersion,
} from "../../backend/review/prompts/review-prompt.ts";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import {
  CommandId,
  FindingId,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";
import {
  ExecutionBudget,
  ExecutionError,
  type ExecutionStatus,
  type ReviewDiscipline,
} from "#lib/review/execution.ts";
import { sendReviewMessage } from "#lib/review/conversation.ts";
import { reviewModels } from "#lib/review/models.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());
const budget = new ExecutionBudget({ maxCalls: 2, maxInputTokens: 64000, maxOutputTokens: 256 });

test("model choice uses its provider credential, freezes on replay, and records Auto routing and elapsed time", async () => {
  const requests: Array<{ model: string; authorization: string | null }> = [];

  const session = await fixture(async (_input, init) => {
    const request = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
    )(Schema.decodeUnknownSync(Schema.String)(init?.body));

    requests.push({
      model: request.model,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    if (request.model !== "meta-models/muse-spark-open-1026")
      return response(false, "Check the drawing count before accepting it.");

    const chunks = [
      {
        id: "local_baseten",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Check the drawing count before accepting it." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "local_baseten",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      },
    ];

    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }, true);

  try {
    const setup = await Effect.runPromise(session.execution.setup);
    expect(setup.models?.filter((model) => model.available)).toHaveLength(3);

    for (const model of reviewModels) {
      const state = await session.state();
      const conversation = state.conversations[0];

      if (!conversation) throw new Error("Missing conversation");

      const submission = {
        command: ReviewCommand.cases.PostMessage.make({
          commandId: id(),
          projectId: session.projectId,
          expectedVersion: state.project?.version ?? -1,
          conversationId: conversation.id,
          text:
            model.id === "muse-spark-1.3"
              ? "Check the product quantities in Room 101."
              : "Inspect the electrical lighting count in Room 101.",
        }),
        executionCommandId: id(),
        findingId: session.findingId,
        discipline: "auto" as const,
        model: model.id,
        budget,
      };

      const sent = await sendReviewMessage(session.client, submission);

      if (!sent.saved || !sent.execution) throw new Error(sent.error ?? "Missing execution");
      const status = await completed(session, sent.execution);
      expect(status.model).toBe(model.id);
      expect(status.provider).toBe(model.provider);
      expect(status.startedAt).toBeGreaterThan(0);
      expect(status.stateChangedAt).toBeGreaterThanOrEqual(status.startedAt ?? 0);
      expect(status.conversationId).toBe(conversation.id);
      expect(requests.at(-1)).toEqual({
        model: model.id,
        authorization: `Bearer ${model.provider === "meta" ? "local-fixture-only" : "local-baseten-only"}`,
      });
      const saved = await session.state();
      const answer = saved.messages.find((message) => message.origin?.runId === status.runId);
      expect(answer?.origin?.discipline).toBe("electrical");
      expect(answer?.origin?.elapsedMs).toBeGreaterThanOrEqual(0);
      const before = requests.length;

      const replay = await sendReviewMessage(session.client, {
        ...submission,
        model: model.id === "muse-wonder-1.0" ? "muse-spark-1.3" : "muse-wonder-1.0",
      });

      expect(replay.saved && replay.execution === null).toBe(true);
      expect(requests).toHaveLength(before);
    }
  } finally {
    await session.dispose();
  }
});

test("a model without its own provider credential is unavailable and never falls back", async () => {
  const requests: string[] = [];

  const session = await fixture(async () => {
    requests.push("sent");

    return response(false);
  });

  try {
    const setup = await Effect.runPromise(session.execution.setup);
    expect(setup.models?.find((model) => model.provider === "baseten")?.available).toBe(false);

    const result = await Effect.runPromise(
      Effect.result(
        session.execution.start({
          commandId: id(),
          projectId: session.projectId,
          findingId: session.findingId,
          model: "meta-models/muse-spark-open-1026",
          budget,
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(requests).toHaveLength(0);
  } finally {
    await session.dispose();
  }
});

function response(finish: boolean, text = "done") {
  const item = finish
    ? {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "finish_review",
        arguments: JSON.stringify({
          text: "Needs input: governing sources are unverified. Review only the selected count scope.",
        }),
        status: "completed",
      }
    : {
        type: "message",
        id: "message_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };

  const events = [
    { type: "response.created", response: { id: "resp_local" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_local",
        status: "completed",
        output: [item],
        usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(transport?: ProviderTransport, includeBaseten = false) {
  const directory = await mkdtemp(join(tmpdir(), "moke-conversation-"));
  const ownership = ManagedRuntime.make(DataDirectoryOwnership.layer(directory));
  const owner = await ownership.runPromise(DataDirectoryOwnership);
  const filename = join(directory, "app.sqlite");
  await Effect.runPromise(
    Effect.scoped(migrateDatabase(filename, resolve("migrations"), join(directory, "backups"))),
  );
  const queries = Semaphore.makeUnsafe(1);
  const connection = SqliteClient.layer({ filename });

  const query = <A>(operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys=ON`;

        return yield* operation.pipe(Effect.provide(ReviewStore.layer));
      }).pipe(Effect.provide(connection)),
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(ReviewError)(error)
          ? error
          : new ReviewStorageError({ message: "Fixture database unavailable." }),
      ),
      Semaphore.withPermit(queries),
    );

  const review = createReviewOperations({ query, owner, documents: undefined });

  const options: ExecutionConfiguration = {
    owner,
    queries,
    port: review.port,
    runPromise: (effect, options) => runtime.runPromise(effect, options),
  };

  const runtime: ManagedRuntime.ManagedRuntime<ReviewExecution, ExecutionError> =
    ManagedRuntime.make(
      ReviewExecution.layer(
        transport === undefined
          ? options
          : {
              ...options,
              provider: {
                apiKey: Redacted.make("local-fixture-only"),
                route: "recorded",
                transport,
              },
              providers: [
                {
                  provider: "meta",
                  apiKey: Redacted.make("local-fixture-only"),
                  route: "recorded",
                  transport,
                },
                ...(includeBaseten
                  ? [
                      {
                        provider: "baseten" as const,
                        apiKey: Redacted.make("local-baseten-only"),
                        route: "recorded" as const,
                        transport,
                      },
                    ]
                  : []),
              ],
            },
      ),
    );

  const execution = await runtime.runPromise(ReviewExecution);

  const call = async <A, E extends typeof ReviewError.Type | ExecutionError>(
    effect: Effect.Effect<A, E>,
  ) => {
    const result = await Effect.runPromise(Effect.result(effect));

    return Result.isSuccess(result)
      ? { ok: true as const, value: result.success }
      : { ok: false as const, error: result.failure };
  };

  const client = {
    command: (command: typeof ReviewCommand.Type) => call(review.command(command)),
    startExecution: (request: Parameters<typeof execution.start>[0]) =>
      call(execution.start(request)),
  };

  const project = await Effect.runPromise(
    review.command(
      ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Conversation review" }),
    ),
  );

  const state = () => Effect.runPromise(review.snapshot(project.projectId, 0));
  const command = (input: typeof ReviewCommand.Type) => Effect.runPromise(review.command(input));
  let current = await state();
  await Effect.runPromise(
    query(
      Effect.flatMap(ReviewStore, (store) =>
        store.importPdf(
          {
            commandId: id(),
            projectId: project.projectId,
            expectedVersion: current.project?.version ?? -1,
            name: "Drawing fixture",
          },
          new ImportedPdf({
            sha256: "a".repeat(64),
            byteLength: 100,
            pages: [
              {
                pageIndex: 0,
                label: "A-101",
                box: { x: 0, y: 0, width: 100, height: 100 },
                rotation: 0,
                userUnit: 1,
              },
            ],
          }),
        ),
      ),
    ),
  );
  current = await state();
  const sheet = current.sheets[0];

  if (sheet === undefined) throw new Error("Missing fixture sheet");
  await command(
    ReviewCommand.cases.ConfirmSheet.make({
      commandId: id(),
      projectId: project.projectId,
      expectedVersion: current.project?.version ?? -1,
      sheetId: sheet.id,
      label: "A-101",
      coverage: "partial",
    }),
  );
  current = await state();

  const created = await command(
    ReviewCommand.cases.CreateFinding.make({
      commandId: id(),
      projectId: project.projectId,
      expectedVersion: current.project?.version ?? -1,
      title: "Room 101 count",
      objectClass: "Room 101 type A luminaires only",
      drawnSheetId: sheet.id,
      scheduledSheetId: sheet.id,
      applicabilityConfirmed: true,
    }),
  );

  const findingId = Schema.decodeUnknownSync(FindingId)(created.entityId);

  return {
    filename,
    state,
    command,
    execution,
    client,
    findingId,
    projectId: project.projectId,
    dispose: async () => {
      await runtime.runPromise(execution.close);
      await runtime.dispose();
      await ownership.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function completed(session: Awaited<ReturnType<typeof fixture>>, status: ExecutionStatus) {
  for (let index = 0; index < 200; index++) {
    const current = await Effect.runPromise(
      session.execution.status(status.projectId, status.runId),
    );

    if (current.state === "completed") return current;

    if (current.state === "failed" || current.state === "uncertain")
      throw new Error(`Fixture review ${current.state}`);
    await Bun.sleep(5);
  }

  throw new Error("Fixture review did not complete");
}

test("a real conversation send routes Moke disciplines, isolates requests, and persists its response and provenance", async () => {
  const requests: string[] = [];

  const session = await fixture(async (_input, init) => {
    requests.push(Schema.decodeUnknownSync(Schema.String)(init?.body));

    return response(requests.length % 2 === 1);
  });

  try {
    let state = await session.state();
    const first = state.conversations[0];

    if (first === undefined) throw new Error("Missing first conversation");

    const unrelated = await session.command(
      ReviewCommand.cases.PostMessage.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: state.project?.version ?? -1,
        conversationId: first.id,
        text: "UNRELATED_CONVERSATION_DO_NOT_REVIEW",
      }),
    );

    state = await session.state();
    await session.command(
      ReviewCommand.cases.CreateConversation.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: state.project?.version ?? -1,
        title: "Selected review",
      }),
    );
    state = await session.state();
    const conversation = state.conversations.at(-1);

    if (conversation === undefined) throw new Error("Missing selected conversation");

    const mismatched = await Effect.runPromise(
      Effect.result(
        session.execution.start({
          commandId: id(),
          projectId: session.projectId,
          findingId: session.findingId,
          budget,
          reviewRequest: {
            conversationId: conversation.id,
            messageId: unrelated.entityId,
            discipline: "general",
          },
        }),
      ),
    );

    expect(Result.isFailure(mismatched)).toBe(true);
    expect(requests).toHaveLength(0);

    const scopes: ReadonlyArray<{ id: typeof ReviewDiscipline.Type; heading: string }> = [
      { id: "electrical", heading: "# Electrical review" },
      { id: "fire_alarm", heading: "# Fire alarm review" },
      { id: "fire_sprinkler", heading: "# Fire sprinkler review" },
      { id: "life_safety", heading: "# Life safety review" },
      { id: "fire_protection", heading: "# Fire protection coordination review" },
    ];

    let lastExecution: ExecutionStatus | undefined;

    for (const scope of scopes) {
      state = await session.state();

      const submission = {
        command: ReviewCommand.cases.PostMessage.make({
          commandId: id(),
          projectId: session.projectId,
          expectedVersion: state.project?.version ?? -1,
          conversationId: conversation.id,
          text: `Inspect Room 101 for ${scope.id}; identify missing governing sources.`,
        }),
        executionCommandId: id(),
        findingId: session.findingId,
        discipline: scope.id,
        budget,
      };

      const sent = await sendReviewMessage(session.client, submission);
      expect(sent.saved).toBe(true);

      if (!sent.saved || sent.execution === null)
        throw new Error(sent.error ?? "Review did not start");
      lastExecution = await completed(session, sent.execution);
      const firstRequest = requests.at(-2) ?? "";
      expect(firstRequest).toContain(scope.heading);
      expect(firstRequest).toContain(submission.command.text);
      expect(firstRequest).toContain(reviewInstructionRevision);
      expect(firstRequest).toContain("NO web browser");
      expect(firstRequest).not.toContain("UNRELATED_CONVERSATION_DO_NOT_REVIEW");
      expect(firstRequest).not.toContain("using a key unique to the project and report revision");

      for (const other of scopes.filter((item) => item.id !== scope.id))
        expect(firstRequest).not.toContain(other.heading);
      const beforeReplay = requests.length;
      const replay = await sendReviewMessage(session.client, submission);
      expect(replay.saved).toBe(true);
      expect(requests).toHaveLength(beforeReplay);
    }

    state = await session.state();
    const replies = state.messages.filter((message) => message.role === "application");
    expect(replies).toHaveLength(scopes.length);
    expect(replies.every((message) => message.conversationId === conversation.id)).toBe(true);
    expect(
      replies.every(
        (message) =>
          message.origin?.promptVersion === reviewPromptVersion &&
          message.origin.instructionRevision === reviewInstructionRevision,
      ),
    ).toBe(true);
    expect(state.facts).toHaveLength(0);
    expect(state.sheets[0]?.coverage).toBe("partial");
    expect(state.findings[0]?.closed).toBe(false);

    if (lastExecution === undefined) throw new Error("Missing completed execution");
    await Effect.runPromise(session.execution.quiesce);
    {
      using database = new Database(session.filename);
      // Simulate a crash after Pi committed completion but before the domain run recorded it.
      database.run(
        "UPDATE review_execution_runs SET state='paused',version=version+1 WHERE run_id=?",
        [lastExecution.runId],
      );
    }

    const paused = await Effect.runPromise(
      session.execution.status(session.projectId, lastExecution.runId),
    );

    const beforeResume = requests.length;

    const resumed = await Effect.runPromise(
      session.execution.control(session.projectId, paused.runId, paused.version, "resume"),
    );

    await completed(session, resumed);
    expect(requests).toHaveLength(beforeResume);
    expect(
      (await session.state()).messages.filter((entry) => entry.role === "application"),
    ).toHaveLength(scopes.length);
  } finally {
    await session.dispose();
  }
}, 15000);

test("missing credentials preserve the saved request and return an actionable admission failure without creating evidence", async () => {
  const session = await fixture();

  try {
    const state = await session.state();
    const conversation = state.conversations[0];

    if (conversation === undefined) throw new Error("Missing conversation");

    const sent = await sendReviewMessage(session.client, {
      command: ReviewCommand.cases.PostMessage.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: state.project?.version ?? -1,
        conversationId: conversation.id,
        text: "Inspect this count.",
      }),
      executionCommandId: id(),
      findingId: session.findingId,
      discipline: "building_design",
      budget,
    });

    expect(sent.saved).toBe(true);
    expect(sent.error).toContain("Message saved. Review did not start:");
    expect(sent.error).toContain("credential");
    expect((await Effect.runPromise(session.execution.setup)).configured).toBe(false);
    const saved = await session.state();
    expect(saved.messages.filter((message) => message.text === "Inspect this count.")).toHaveLength(
      1,
    );
    expect(saved.facts).toHaveLength(0);
    expect(saved.checks).toHaveLength(0);
  } finally {
    await session.dispose();
  }
});

test.each([
  "Needs input: inspect the Room 101 type A legend. Governing sources remain unverified.",
  "",
])("a terminal answer persists only nonempty conversation prose: %j", async (text) => {
  const session = await fixture(async () => response(false, text));

  try {
    const state = await session.state();
    const conversation = state.conversations[0];

    if (conversation === undefined) throw new Error("Missing conversation");

    const sent = await sendReviewMessage(session.client, {
      command: ReviewCommand.cases.PostMessage.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: state.project?.version ?? -1,
        conversationId: conversation.id,
        text: "What evidence is missing for this count?",
      }),
      executionCommandId: id(),
      findingId: session.findingId,
      discipline: "general",
      budget,
    });

    if (!sent.saved || sent.execution === null)
      throw new Error(sent.error ?? "Review did not start");
    await completed(session, sent.execution);
    const saved = await session.state();
    const answer = saved.messages.find((message) => message.role === "application");

    if (text.length > 0) {
      expect(answer?.text).toBe(text);
      expect(answer?.conversationId).toBe(conversation.id);
      expect(answer?.origin?.runId).toBe(sent.execution.runId);
    } else expect(answer).toBeUndefined();
    expect(saved.facts).toHaveLength(0);
    expect(saved.checks).toHaveLength(0);
  } finally {
    await session.dispose();
  }
});
