import { expect } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Redacted,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executionPersistence } from "../../backend/review/execution-store.ts";
import { acquireDataDirectoryOwnership } from "../../backend/ownership.ts";
import { migrateDatabase } from "../../backend/database-files.ts";
import { Documents } from "../../backend/documents/documents.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { PacketReviews, defaultParallel } from "../../backend/packet-review/service.ts";
import { exportReviewPackage } from "../../backend/review/packages.ts";
import { PackageError, PackageLimits } from "#lib/review/packages.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import type { SourceLookupOptions } from "../../backend/packet-review/sources.ts";
import {
  CommandId,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";
import { PacketReview, StartPacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "./hero-case.ts";

/** Create a validated command identity for a new test operation. */
export const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());
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
    readonly database: ReturnType<typeof executionPersistence>["query"];
    readonly exportPackage: (
      destination: string,
      limits?: typeof PackageLimits.Type,
    ) => ReturnType<typeof exportReviewPackage>;
  }
>()("test/PacketReviewFixture") {}

/** Open the real packet service, SQLite store, and PDF worker under one owned runtime. */
/** Text the host returns when a reviewer calls finish_review before coverage is recorded. */
export const coverageGateText = "Coverage is incomplete, so this review is not finished yet.";

/**
 * Scripted reviewers in most tests finish early. Answer the bounded coverage gate by repeating the
 * script's own finish_review call so those tests keep their behavior; the gate has its own tests.
 */
const GateRequest = Schema.fromJsonString(
  Schema.Struct({
    input: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          type: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.fromJsonString(Schema.Json)),
          output: Schema.optionalKey(Schema.Json),
        }),
      ),
    ),
  }),
);

export function acceptCoverageGate(transport: ProviderTransport): ProviderTransport {
  return async (input, init) => {
    const decoded = Schema.decodeUnknownOption(GateRequest)(init?.body);
    const items = Option.isSome(decoded) ? (decoded.value.input ?? []) : [];
    const last = items.at(-1);

    const finish = items.findLast(
      (item) => item.type === "function_call" && item.name === "finish_review",
    );

    if (
      last?.type === "function_call_output" &&
      JSON.stringify(last.output ?? "").includes(coverageGateText) &&
      finish?.arguments !== undefined
    )
      return response([{ name: "finish_review", arguments: finish.arguments }]);

    return await transport(input, init);
  };
}

export async function open(
  directory: string,
  rawTransport: ProviderTransport,
  setup = true,
  afterRun?: <A>(value: A) => Promise<void>,
  gate: "accept" | "observe" = "accept",
  // Scripted reviews here are single conversations; parallel review tests opt in.
  parallel: NonNullable<Parameters<typeof PacketReviews.layer>[0]["parallel"]> = {
    ...defaultParallel,
    minSheets: Number.POSITIVE_INFINITY,
  },
  // Recorded DNS and HTTPS for read_source; PDF text extraction stays the real worker's.
  sources?: Pick<SourceLookupOptions, "resolve" | "transport">,
) {
  const transport = gate === "accept" ? acceptCoverageGate(rawTransport) : rawTransport;

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

      const operations = createReviewOperations({ query, documents, owner });

      const review =
        sources === undefined
          ? operations
          : { ...operations, sourceOptions: { ...operations.sourceOptions, ...sources } };

      const packets = yield* PacketReviews.pipe(
        Effect.provide(
          yield* Layer.build(
            PacketReviews.layer({
              owner,
              queries,
              review,
              parallel,
              runPromise: async (operation, options) => {
                const value = await enter(operation, options);
                await afterRun?.(value);

                return value;
              },
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

      return FixtureApi.of({
        review,
        packets,
        database: executionPersistence(filename, queries).query,
        exportPackage: (destination, limits) =>
          exportReviewPackage(
            {
              dataDirectory: directory,
              migrationDirectory: resolve("migrations"),
              queries,
              quiesce: packets.quiesce.pipe(
                Effect.mapError(
                  (cause) => new PackageError({ reason: "conflict", message: cause.message }),
                ),
              ),
              ...(limits === undefined
                ? { ownerGeneration: owner.generation }
                : { ownerGeneration: owner.generation, limits }),
            },
            destination,
          ),
      });
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
    exportPackage: api.exportPackage,
    runtime,
    snapshot,
    request,
    command,
    importPdf: (input: Parameters<typeof api.review.importPdf>[0]) =>
      runtime.runPromise(api.review.importPdf(input)),
    database: <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runtime.runPromise(api.database(operation)),
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

/** Owned packet fixture with real persistence and an injected external provider transport. */
export type Session = Awaited<ReturnType<typeof open>>;

/** Await a public review state with a bounded timeout and immediate terminal-failure diagnostics. */
export async function until(session: Session, reviewId: string, state: PacketReview["state"]) {
  // Windows CI has stalled 1-second reviews past 15 s. Stay under the usual 120-second test limit
  // so a real hang still reports this helper's state and error rather than a bare timeout.
  const deadline = performance.now() + 100000;

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

/** Wire-level model request shape used to inspect the injected external transport. */
export const Request = Schema.Struct({
  model: Schema.String,
  prompt_cache_key: Schema.optionalKey(Schema.String),
  prompt_cache_retention: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json),
  messages: Schema.optionalKey(Schema.Json),
  tools: Schema.optionalKey(Schema.Json),
});

/** Decode the actual serialized model or SAM request before test assertions. */
export const decodeRequest = (init: Parameters<ProviderTransport>[1]) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
    Schema.decodeUnknownSync(Schema.String)(init?.body),
  );

/** Collect textual wire content without losing the parsed JSON boundary. */
export function strings(value: typeof Schema.Json.Type): ReadonlyArray<string> {
  if (Predicate.isString(value)) return [value];

  if (Array.isArray(value)) return value.flatMap(strings);

  if (Predicate.isObject(value))
    return Object.values(value).flatMap((entry) =>
      strings(Schema.decodeUnknownSync(Schema.Json)(entry)),
    );

  return [];
}

/** Read typed tool results from an actual subsequent model request. */
export function outputs<S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  request: typeof Request.Type,
): ReadonlyArray<S["Type"]> {
  return strings(request.input ?? request.messages ?? null).flatMap((text) =>
    Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
      onNone: () => [],
      onSome: (value) => [value],
    }),
  );
}

/** Collect only system and developer instructions from either supported provider format. */
export function systemPrompt(request: typeof Request.Type) {
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

/** Produce a completed Meta Responses SSE receipt with genuine SDK-parsed tool calls. */
export function response(
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

/** Produce a completed Baseten chat-completions SSE receipt. */
export function chatResponse(
  text: string,
  tools: NonNullable<Parameters<typeof response>[0]> = [],
) {
  const events = [
    {
      id: "packet_baseten",
      choices: [
        {
          index: 0,
          delta: tools.length
            ? {
                role: "assistant",
                tool_calls: tools.map((tool, index) => ({
                  index,
                  id: `call_${crypto.randomUUID()}`,
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                })),
              }
            : { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "packet_baseten",
      choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    },
  ];

  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
