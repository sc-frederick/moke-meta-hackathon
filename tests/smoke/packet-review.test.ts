import { expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDataDirectoryOwnership } from "../../backend/ownership.ts";
import { migrateDatabase } from "../../backend/database-files.ts";
import { Documents } from "../../backend/documents/documents.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { PacketReviews } from "../../backend/packet-review/service.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import {
  Artifact,
  CommandId,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";
import {
  PacketCalculation,
  PacketReview,
  PacketScope,
  StartPacketReview,
} from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());
const assetsRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

const nativeFile = join(
  dirname(fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`))),
  canvasNativeFileName(),
);

class FixtureApi extends Context.Service<
  FixtureApi,
  {
    readonly review: ReturnType<typeof createReviewOperations>;
    readonly packets: PacketReviews["Service"];
  }
>()("test/PacketReviewFixture") {}

async function open(directory: string, transport: ProviderTransport, setup = true) {
  let enter: <A, E>(operation: Effect.Effect<A, E>, options?: Effect.RunOptions) => Promise<A> =
    Effect.runPromise;

  const layer = Layer.effect(
    FixtureApi,
    Effect.gen(function* () {
      const owner = yield* acquireDataDirectoryOwnership(directory);
      const filename = join(directory, "app.sqlite");
      yield* Effect.scoped(
        migrateDatabase(filename, resolve("migrations"), join(directory, "backups")),
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
          Effect.mapError((cause) =>
            Schema.is(ReviewError)(cause)
              ? cause
              : new ReviewStorageError({ message: "Test review storage unavailable." }),
          ),
          Semaphore.withPermit(queries),
        );

      const documents = yield* Documents.pipe(
        Effect.provide(
          yield* Layer.build(
            Documents.layer({
              dataDirectory: directory,
              workerCommand: [
                process.execPath,
                "--no-orphans",
                resolve("backend/documents/pdf-worker-main.ts"),
              ],
              assetsDirectory: assetsRoot,
              nativeLibraryPath: nativeFile,
            }),
          ),
        ),
      );

      const review = createReviewOperations({ query, documents, owner });

      const packets = yield* PacketReviews.pipe(
        Effect.provide(
          yield* Layer.build(
            PacketReviews.layer({
              owner,
              queries,
              review,
              runPromise: (operation, options) => enter(operation, options),
              providers: [
                {
                  provider: "meta",
                  apiKey: Redacted.make("packet-meta-fixture"),
                  route: "recorded",
                  transport,
                },
                {
                  provider: "baseten",
                  apiKey: Redacted.make("packet-baseten-fixture"),
                  route: "recorded",
                  transport,
                },
              ],
            }),
          ),
        ),
      );

      return FixtureApi.of({ review, packets });
    }),
  );

  const runtime = ManagedRuntime.make(layer);
  enter = (operation, options) => runtime.runPromise(operation, options);
  const api = await runtime.runPromise(FixtureApi);

  const command = (input: typeof ReviewCommand.Type) =>
    runtime.runPromise(api.review.command(input));

  const initialize = async () => {
    const created = await command(
      ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Packet QA fixture" }),
    );

    const source = join(directory, "Drawing packet.pdf");
    await writeFile(source, createHeroPdf("A"));
    await runtime.runPromise(
      api.review.importPdf({
        commandId: id(),
        projectId: created.projectId,
        expectedVersion: created.version,
        source,
        name: "Drawing packet.pdf",
      }),
    );

    return created.projectId;
  };

  const projectId = setup
    ? await initialize()
    : (await runtime.runPromise(api.review.snapshot(null, 0))).projects[0]?.id;

  if (!projectId) throw new Error("Missing test project");
  const snapshot = () => runtime.runPromise(api.review.snapshot(projectId, 0));

  const request = async (text: string, changes: Partial<typeof StartPacketReview.Type> = {}) => {
    const current = await snapshot();
    const conversation = current.conversations[0];

    if (!conversation) throw new Error("Missing test conversation");

    const message = await command(
      ReviewCommand.cases.PostMessage.make({
        commandId: id(),
        projectId,
        expectedVersion: current.project?.version ?? -1,
        conversationId: conversation.id,
        text,
      }),
    );

    return Schema.decodeUnknownSync(StartPacketReview)({
      commandId: id(),
      projectId,
      conversationId: conversation.id,
      messageId: message.entityId,
      model: "muse-spark-1.3",
      discipline: "auto",
      maxCalls: null,
      ...changes,
    });
  };

  let disposed = false;

  return {
    directory,
    projectId,
    packets: api.packets,
    runtime,
    snapshot,
    request,
    run: <A, E>(operation: Effect.Effect<A, E>) => runtime.runPromise(operation),
    dispose: async () => {
      if (disposed) return;
      disposed = true;

      try {
        expect(await runtime.runPromise(api.packets.close)).toBe(true);
      } finally {
        await runtime.dispose();
      }
    },
  };
}

type Session = Awaited<ReturnType<typeof open>>;

async function until(session: Session, reviewId: string, state: PacketReview["state"]) {
  const deadline = performance.now() + 15000;

  while (performance.now() < deadline) {
    const current = await session.run(session.packets.get(session.projectId, reviewId));

    if (current.state === state) return current;

    if (["failed", "uncertain", "cancelled"].includes(current.state) && current.state !== state)
      throw new Error(
        `Packet fixture reached ${current.state}: ${current.error ?? current.summary}`,
      );
    await Bun.sleep(10);
  }

  const current = await session.run(session.packets.get(session.projectId, reviewId));
  throw new Error(
    `Packet fixture did not reach ${state}; actual ${current.state}: ${current.error ?? current.summary}`,
  );
}

const Request = Schema.Struct({
  model: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json),
  messages: Schema.optionalKey(Schema.Json),
});

const decodeRequest = (init: Parameters<ProviderTransport>[1]) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
    Schema.decodeUnknownSync(Schema.String)(init?.body),
  );

function strings(value: typeof Schema.Json.Type): ReadonlyArray<string> {
  if (Predicate.isString(value)) return [value];

  if (Array.isArray(value)) return value.flatMap(strings);

  if (Predicate.isObject(value))
    return Object.values(value).flatMap((entry) =>
      strings(Schema.decodeUnknownSync(Schema.Json)(entry)),
    );

  return [];
}

function outputs<S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  request: typeof Request.Type,
): ReadonlyArray<S["Type"]> {
  return strings(request.input ?? null).flatMap((text) =>
    Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
      onNone: () => [],
      onSome: (value) => [value],
    }),
  );
}

function systemPrompt(request: typeof Request.Type) {
  const Message = Schema.Struct({
    role: Schema.Literals(["system", "developer"]),
    content: Schema.Json,
  });

  const messages = [request.input, request.messages].flatMap((value) =>
    Option.match(Schema.decodeUnknownOption(Schema.Array(Schema.Json))(value), {
      onNone: () => [],
      onSome: (entries) => entries,
    }),
  );

  const text = messages.flatMap((value) =>
    Option.match(Schema.decodeUnknownOption(Message)(value), {
      onNone: () => [],
      onSome: (message) => strings(message.content),
    }),
  );

  return [request.instructions ?? "", ...text].join("\n");
}

function response(
  tools: ReadonlyArray<{ readonly name: string; readonly arguments: typeof Schema.Json.Type }> = [],
  text = "Review response recorded.",
) {
  const items = tools.length
    ? tools.map((tool, index) => ({
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${crypto.randomUUID()}`,
        name: tool.name,
        arguments: JSON.stringify(tool.arguments),
        status: "completed",
      }))
    : [
        {
          type: "message",
          id: "message_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ];

  const events = [
    { type: "response.created", response: { id: "resp_packet" } },
    ...items.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: "resp_packet",
        status: "completed",
        output: items,
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function chatResponse(text: string) {
  const events = [
    {
      id: "packet_baseten",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "packet_baseten",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    },
  ];

  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("project-first review runs actual Moke system instructions and tools, persists its report, and reopens without dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-integration-"));
  const requests: Array<typeof Request.Type> = [];
  let step = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    requests.push(request);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer packet-meta-fixture");

    switch (step++) {
      case 0:
        return response([{ name: "inventory_packet", arguments: {} }]);
      case 1: {
        const inventory = outputs(PacketReview, request).at(-1);

        if (!inventory) throw new Error("Inventory tool did not deliver the real packet");

        return response(
          inventory.sheets.map((sheet) => ({
            name: "render_sheet",
            arguments: { sheetId: sheet.id },
          })),
        );
      }

      case 2: {
        const inventory = outputs(PacketReview, request).at(-1);

        if (!inventory) throw new Error("Missing inventory receipt");

        const discipline = Match.value(inventory.scope).pipe(
          Match.tagsExhaustive({
            WholeSet: () => "general",
            Discipline: (scope) => scope.discipline,
          }),
        );

        return response([
          {
            name: "record_project",
            arguments: {
              values: {
                jurisdiction: "Needs input",
                permitStage: "Not stated in the supplied title blocks",
              },
            },
          },
          {
            name: "calculate",
            arguments: {
              title: "Source page coordinate area",
              expression: "width * height",
              inputs: {
                width: { value: 612, unit: "PDF pt" },
                height: { value: 792, unit: "PDF pt" },
              },
              unit: "PDF pt²",
              explanation: "The sheet coordinate area, not physical building area.",
            },
          },
          ...inventory.sheets.flatMap((sheet) =>
            [
              {
                pass: "completeness",
                status: "checked",
                note: "Read the original source image and title blocks.",
              },
              {
                pass: "requirements",
                status: "needs_input",
                note: "Governing permit stage and adopted edition need input.",
              },
              {
                pass: "coordination",
                status: "checked",
                note: "Read the original source image and title blocks.",
              },
              {
                pass: "prior_comments",
                status: "not_applicable",
                note: "No previous agency comments were supplied.",
              },
            ].map(({ pass, status, note }) => ({
              name: "record_coverage",
              arguments: {
                sheetId: sheet.id,
                pass,
                discipline,
                status,
                note,
              },
            })),
          ),
        ]);
      }

      case 3: {
        const artifacts = outputs(Schema.Struct({ artifact: Artifact }), request);
        const calculation = outputs(PacketCalculation, request).at(-1);

        if (artifacts.length < 2 || !calculation)
          throw new Error("Real render/calculation tool outputs missing");

        return response([
          {
            name: "record_finding",
            arguments: {
              title: "Permit stage is absent from the supplied title blocks",
              discipline: "general",
              severity: "Minor",
              status: "Needs input",
              classification: "Recommendation",
              locations: artifacts.map(({ artifact }) => ({
                sheetId: artifact.sheetId,
                detail: "Title block",
                region:
                  artifact.region === null
                    ? null
                    : {
                        x: artifact.region.x,
                        y: artifact.region.y,
                        width: artifact.region.width,
                        height: artifact.region.height,
                      },
              })),
              observed:
                "The supplied schematic title blocks identify the revision but do not state permit stage or jurisdiction.",
              correction:
                "Provide the current permit stage and governing jurisdiction before regulatory review.",
              evidenceIds: artifacts.map(({ artifact }) => artifact.id),
              evidenceNote:
                "Both original source sheets; project configuration is missing from their title blocks.",
              citationIds: [],
              calculationIds: [calculation.id],
              priorCommentId: null,
              completed: true,
            },
          },
        ]);
      }

      case 4:
        return response([
          {
            name: "finish_review",
            arguments: {
              summary:
                "Inspected both supplied source sheets. Project metadata needs input; findings, coverage and source coordinate calculation are recorded.",
              missingInputs: ["Current permit stage, jurisdiction and adopted code edition."],
            },
          },
        ]);
      default:
        return response(
          [],
          "The recorded QA review is ready; missing governing inputs remain visible.",
        );
    }
  };

  let session = await open(directory, transport);

  try {
    const initial = await session.snapshot();
    expect(initial.findings).toHaveLength(0);
    expect(initial.sheets).toHaveLength(2);
    expect(initial.sheets.every((sheet) => !sheet.confirmed)).toBe(true);

    const request = await session.request(
      "Please run a quick QA pass on the supplied drawing set.",
    );

    const started = await session.run(session.packets.start(request));
    const finished = await until(session, started.id, "completed");
    expect(finished.scope).toEqual(PacketScope.members[0].make({}));
    expect(requests[0] ? systemPrompt(requests[0]) : "").toContain("# Florida plan review");
    expect(requests[0] ? systemPrompt(requests[0]) : "").toContain("## Report and release");
    expect(requests[0] ? systemPrompt(requests[0]) : "").toContain("# Structural review");
    expect(requests[0] ? systemPrompt(requests[0]) : "").not.toContain(
      "ONE selected count finding",
    );
    expect(requests[0] ? systemPrompt(requests[0]) : "").not.toContain("Do not output HTML");
    expect(JSON.stringify(requests[0]?.input)).toContain("Please run a quick QA pass");
    expect(finished.inspectedSheetIds).toHaveLength(2);
    expect(finished.coverage).toHaveLength(8);
    expect(finished.coverage.some((entry) => entry.status === "unreviewed")).toBe(false);
    expect(finished.findings).toHaveLength(1);
    expect(finished.findings[0]?.completed).toBe(false);
    expect(finished.calculations[0]?.result).toBe(484704);
    expect(finished.finished).toBe(true);
    expect(finished.maxCalls).toBeNull();
    expect(
      requests.some((request) =>
        strings(request.input ?? null).some((part) => part.startsWith("data:image/png;base64,")),
      ),
    ).toBe(true);
    const snapshot = await session.snapshot();
    expect(snapshot.findings).toHaveLength(0);
    expect(
      snapshot.messages.some(
        (message) => message.role === "application" && message.text === finished.summary,
      ),
    ).toBe(true);
    expect(
      snapshot.artifacts.filter((artifact) => artifact.mediaType === "image/png"),
    ).toHaveLength(2);
    const sends = requests.length;
    expect((await session.run(session.packets.start(request))).id).toBe(finished.id);
    expect(requests).toHaveLength(sends);

    const changed = await session.run(
      Effect.result(session.packets.start({ ...request, model: "muse-wonder-1.0" })),
    );

    expect(Result.isFailure(changed)).toBe(true);

    if (Result.isFailure(changed)) expect(changed.failure.reason).toBe("conflict");
    const finding = finished.findings[0];

    if (!finding) throw new Error("No general review finding");

    const marked = await session.run(
      session.packets.complete({
        projectId: session.projectId,
        reviewId: finished.id,
        findingId: finding.id,
        completed: true,
        expectedVersion: finished.version,
      }),
    );

    expect(marked.findings[0]?.completed).toBe(true);
    expect(marked.findings[0]?.status).toBe("Needs input");

    const stale = await session.run(
      Effect.result(
        session.packets.complete({
          projectId: session.projectId,
          reviewId: finished.id,
          findingId: finding.id,
          completed: false,
          expectedVersion: finished.version,
        }),
      ),
    );

    expect(Result.isFailure(stale)).toBe(true);

    if (Result.isFailure(stale)) expect(stale.failure.reason).toBe("conflict");
    const reportPath = join(directory, "review.html");
    await session.run(session.packets.exportReport(session.projectId, finished.id, reportPath));
    // A save-dialog-approved follow-up export replaces the previous HTML atomically.
    await session.run(session.packets.exportReport(session.projectId, finished.id, reportPath));
    const html = await readFile(reportPath, "utf8");
    expect(html).toContain("Permit stage is absent");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("Source page coordinate area");
    expect(html).toContain("Review has unresolved coverage or inputs");
    await session.dispose();
    session = await open(directory, transport, false);
    const restored = await session.run(session.packets.get(request.projectId, finished.id));
    expect(restored.findings[0]?.completed).toBe(true);
    expect(restored.summary).toBe(finished.summary);
    expect(restored.inspectedSheetIds).toEqual(finished.inspectedSheetIds);
    expect(requests).toHaveLength(sends);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("discipline requests route to the selected model's own provider and preserve complete system instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-providers-"));
  const requests: Array<{ model: string; key: string | null; prompt: string }> = [];

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    requests.push({
      model: request.model,
      key: new Headers(init?.headers).get("authorization"),
      prompt: systemPrompt(request),
    });

    return request.model === "meta-models/muse-spark-open-1026"
      ? chatResponse("Electrical review needs the governing permit edition.")
      : response([], "Electrical review needs the governing permit edition.");
  };

  const session = await open(directory, transport);

  try {
    for (const model of ["muse-wonder-1.0", "meta-models/muse-spark-open-1026"] as const) {
      const request = await session.request(
        "Perform an electrical discipline review of the supplied packet.",
        { model },
      );

      const started = await session.run(session.packets.start(request));
      const finished = await until(session, started.id, "completed");
      expect(finished.scope).toEqual(PacketScope.members[1].make({ discipline: "electrical" }));
      expect(finished.model).toBe(model);
      expect(finished.provider).toBe(model === "muse-wonder-1.0" ? "meta" : "baseten");
      expect(finished.summary).toContain("governing permit edition");
      const sent = requests.at(-1);
      expect(sent?.key).toBe(
        model === "muse-wonder-1.0"
          ? "Bearer packet-meta-fixture"
          : "Bearer packet-baseten-fixture",
      );
      expect(sent?.prompt).toContain("# Electrical review");
      expect(sent?.prompt).toContain("## Report and release");
      expect(sent?.prompt).not.toContain("# Structural review");
      expect(sent?.prompt).not.toContain("ONE selected count finding");
    }
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("a sent provider failure remains uncertain through restart and cannot be resumed or resent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-uncertain-"));
  let sends = 0;

  const transport: ProviderTransport = async () => {
    sends++;
    throw new Error("Local transport interrupted after dispatch");
  };

  let session = await open(directory, transport);

  try {
    const request = await session.request("Please run a whole drawing set QA review.");
    const started = await session.run(session.packets.start(request));
    const uncertain = await until(session, started.id, "uncertain");
    expect(sends).toBe(1);
    await session.dispose();
    session = await open(directory, transport, false);
    const restored = await session.run(session.packets.get(request.projectId, started.id));
    expect(restored.state).toBe("uncertain");
    const replay = await session.run(session.packets.start(request));
    expect(replay.id).toBe(uncertain.id);

    const resumed = await session.run(
      Effect.result(
        session.packets.control({
          projectId: request.projectId,
          reviewId: started.id,
          expectedVersion: restored.version,
          action: "resume",
          commandId: id(),
        }),
      ),
    );

    expect(Result.isFailure(resumed)).toBe(true);
    expect(sends).toBe(1);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("an optional call budget pauses instead of reporting a completed packet review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-budget-"));
  let sends = 0;

  const session = await open(directory, async () => {
    sends++;

    return sends === 1
      ? response([{ name: "inventory_packet", arguments: {} }])
      : response([], "Continued the review after the explicitly increased call budget.");
  });

  try {
    const request = await session.request("Please run a quick QA pass.", { maxCalls: 1 });
    const started = await session.run(session.packets.start(request));
    const paused = await until(session, started.id, "paused");
    expect(paused.admittedCalls).toBe(1);
    expect(paused.finished).toBe(false);
    expect(sends).toBe(1);
    expect(paused.error).toContain("budget");
    expect(paused.coverage.every((entry) => entry.status === "unreviewed")).toBe(true);

    const sameBudget = await session.run(
      Effect.result(
        session.packets.control({
          projectId: session.projectId,
          reviewId: started.id,
          expectedVersion: paused.version,
          action: "resume",
          commandId: id(),
          maxCalls: 1,
        }),
      ),
    );

    expect(Result.isFailure(sameBudget)).toBe(true);

    if (Result.isFailure(sameBudget)) expect(sameBudget.failure.reason).toBe("input");
    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: paused.version,
        action: "resume",
        commandId: id(),
        maxCalls: 3,
      }),
    );
    const completed = await until(session, started.id, "completed");
    expect(completed.maxCalls).toBe(3);
    expect(completed.admittedCalls).toBe(2);
    expect(sends).toBe(2);
    expect(completed.summary).toContain("explicitly increased call budget");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("pause drains admitted work and explicit resume replays control receipts without duplicate dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-pause-"));
  const firstAdmitted = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<void>();
  const secondAdmitted = Promise.withResolvers<void>();
  const secondResponse = Promise.withResolvers<void>();
  const observerReady = Promise.withResolvers<void>();
  const pauseObserved = Promise.withResolvers<void>();
  const responseDrained = Promise.withResolvers<void>();
  let firstReleased = false;
  let sawPause = false;
  let sends = 0;

  const session = await open(directory, async () => {
    sends++;

    if (sends === 1) {
      firstAdmitted.resolve();
      await firstResponse.promise;

      return response([], "The already admitted response drained while the review was paused.");
    }

    secondAdmitted.resolve();
    await secondResponse.promise;

    return response(
      [],
      "Continued the review after pause; saved sources and coverage remain available.",
    );
  });

  const signal = new AbortController();
  let observation: Promise<unknown> | undefined;

  const checkpoint = <T>(promise: Promise<T>) =>
    session.run(Effect.promise(() => promise).pipe(Effect.timeout("10 seconds")));

  try {
    const request = await session.request(
      "Run a drawing-set QA review and retain the inspection history.",
    );

    const started = await session.run(session.packets.start(request));
    await checkpoint(firstAdmitted.promise);
    observation = session.runtime
      .runPromise(
        Stream.runForEach(session.packets.observe(session.projectId), (value) =>
          Effect.sync(() => {
            if (value.id !== started.id) return;

            if (value.state === "running") observerReady.resolve();

            if (value.state === "paused") {
              if (!sawPause) {
                sawPause = true;
                pauseObserved.resolve();
              } else if (firstReleased) responseDrained.resolve();
            }
          }),
        ),
        { signal: signal.signal },
      )
      .catch(() => undefined);
    await checkpoint(observerReady.promise);

    const admitted = await session.run(session.packets.get(session.projectId, started.id));

    const pauseCommand = {
      projectId: session.projectId,
      reviewId: started.id,
      expectedVersion: admitted.version,
      action: "pause" as const,
      commandId: id(),
    };

    const paused = await session.run(session.packets.control(pauseCommand));
    await checkpoint(pauseObserved.promise);
    expect(paused.state).toBe("paused");
    expect(paused.admittedCalls).toBe(1);
    expect(sends).toBe(1);
    expect(await session.run(session.packets.control(pauseCommand))).toEqual(paused);

    const prematureCommand = {
      projectId: session.projectId,
      reviewId: started.id,
      expectedVersion: paused.version,
      action: "resume" as const,
      commandId: id(),
    };

    const premature = await session.run(Effect.result(session.packets.control(prematureCommand)));
    expect(Result.isFailure(premature)).toBe(true);

    if (Result.isFailure(premature)) expect(premature.failure.reason).toBe("conflict");
    expect(sends).toBe(1);

    firstReleased = true;
    firstResponse.resolve();
    // A new paused progress event follows the committed provider receipt. Resume immediately
    // here so the service must also drain the old scheduler's completion callback safely.
    await checkpoint(responseDrained.promise);
    const drained = await session.run(session.packets.get(session.projectId, started.id));
    expect(drained.state).toBe("paused");

    const resumeCommand = {
      ...prematureCommand,
      expectedVersion: drained.version,
      commandId: id(),
    };

    const resumed = await session.run(session.packets.control(resumeCommand));
    await checkpoint(secondAdmitted.promise);
    expect(resumed.state).toBe("running");
    expect(sends).toBe(2);
    expect(await session.run(session.packets.control(resumeCommand))).toEqual(resumed);
    expect(sends).toBe(2);

    const changedReplay = await session.run(
      Effect.result(session.packets.control({ ...resumeCommand, maxCalls: 99 })),
    );

    expect(Result.isFailure(changedReplay)).toBe(true);

    if (Result.isFailure(changedReplay)) expect(changedReplay.failure.reason).toBe("conflict");
    expect(sends).toBe(2);

    secondResponse.resolve();
    const completed = await until(session, started.id, "completed");
    expect(completed.admittedCalls).toBe(2);
    expect(completed.summary).toContain("Continued the review after pause");
    expect(completed.error).toBeNull();
    expect(await session.run(session.packets.control(pauseCommand))).toEqual(paused);
    expect(sends).toBe(2);
  } finally {
    firstResponse.resolve();
    secondResponse.resolve();
    signal.abort();
    await observation;
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
