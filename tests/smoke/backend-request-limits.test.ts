import { expect, test } from "bun:test";
import { Array as Arr, Effect, Exit, Layer, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backendRequestMaxBytes } from "#lib/backend-rpc.ts";
import {
  CommandId,
  ConversationId,
  ProjectId,
  ReviewCommand,
  ReviewRpc,
  RevisionId,
  SheetId,
} from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketReviewRpc, StartPacketReview, SteerPacketReview } from "#lib/review/packet.ts";
import { BackendApi } from "../../desktop/backend.ts";
import { PacketProxy, ReviewProxy } from "../../desktop/review-proxy.ts";

const uuid = () => crypto.randomUUID();

// JSON escapes control characters as six bytes, the largest expansion of one UTF-16 unit.
const escaped = (length: number) => "\u0001".repeat(length);

// The NDJSON request line adds its tag, request ID, empty headers and newline to the payload.
const framingBytes = 256;

const requestBytes = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Buffer.byteLength(JSON.stringify(Schema.encodeSync(schema)(value))) + framingBytes;

const command = (value: typeof ReviewCommand.Type) =>
  requestBytes(Schema.Struct({ command: ReviewCommand }), { command: value });

const id = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema)(uuid());

const scoped = () => ({ commandId: id(CommandId), projectId: id(ProjectId), expectedVersion: 1 });

const sheets = (length: number) =>
  Schema.decodeUnknownSync(Schema.NonEmptyArray(SheetId))(Array.from({ length }, uuid));

test("every bounded large command fits the backend request limit after JSON escaping", () => {
  const sizes = [
    command(
      ReviewCommand.cases.PostMessage.make({
        ...scoped(),
        conversationId: id(ConversationId),
        text: escaped(32_000),
      }),
    ),
    command(
      ReviewCommand.cases.ApplySheetLabels.make({
        ...scoped(),
        revisionId: id(RevisionId),
        labels: Arr.map(sheets(200), (sheetId) => ({ sheetId, label: escaped(160) })),
      }),
    ),
    command(
      ReviewCommand.cases.AssignSheetDiscipline.make({
        ...scoped(),
        sheetIds: sheets(1000),
        discipline: null,
      }),
    ),
    command(
      ReviewCommand.cases.AssociateRevision.make({
        ...scoped(),
        revisionId: id(RevisionId),
        correspondence: Arr.map(sheets(1000), (oldSheetId) => ({
          oldSheetId,
          newSheetId: id(SheetId),
          confirmed: false,
          content: "unresolved" as const,
        })),
      }),
    ),
    requestBytes(
      SteerPacketReview,
      Schema.decodeUnknownSync(SteerPacketReview)({
        commandId: uuid(),
        projectId: uuid(),
        reviewId: uuid(),
        conversationId: uuid(),
        text: escaped(32_000),
      }),
    ),
  ];

  for (const size of sizes) expect(size).toBeLessThan(backendRequestMaxBytes);

  // Sheet lists are bounded so the limit covers them; one more sheet is invalid input.
  expect(() =>
    ReviewCommand.cases.AssignSheetDiscipline.make({
      ...scoped(),
      sheetIds: sheets(1001),
      discipline: null,
    }),
  ).toThrow();
});

test("maximum messages cross the HTTP RPC and an oversized request is an input error", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-request-limits-"));

  const launch = BackendApi.layer({
    command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
    dataDirectory,
    migrationDirectory: resolve("migrations"),
  });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const review = yield* RpcTest.makeClient(ReviewRpc);
        const packets = yield* RpcTest.makeClient(PacketReviewRpc);
        const commandId = () => Schema.decodeUnknownSync(CommandId)(uuid());

        const project = yield* review.ReviewCommand({
          command: ReviewCommand.cases.CreateProject.make({ commandId: commandId(), name: "Big" }),
        });

        let version = project.version;

        const conversation = yield* review.ReviewCommand({
          command: ReviewCommand.cases.CreateConversation.make({
            commandId: commandId(),
            projectId: project.projectId,
            expectedVersion: version,
            title: "Limits",
          }),
        });

        version = conversation.version;

        const texts = ["a".repeat(32_000), "界".repeat(32_000), escaped(32_000)];

        for (const text of texts) {
          const posted = yield* review.ReviewCommand({
            command: ReviewCommand.cases.PostMessage.make({
              commandId: commandId(),
              projectId: project.projectId,
              expectedVersion: version,
              conversationId: Schema.decodeUnknownSync(
                ReviewCommand.cases.PostMessage.fields.conversationId,
              )(conversation.entityId),
              text,
            }),
          });

          version = posted.version;
        }

        const snapshot = yield* review.ReviewSnapshot({
          projectId: project.projectId,
          afterSequence: 0,
        });

        expect(snapshot.messages.map((message) => message.text)).toEqual(texts);

        // Selections are not yet bounded by their schema, so the transport limit rejects them.
        const oversized = yield* Effect.exit(
          packets.StartPacketReview(
            Schema.decodeUnknownSync(StartPacketReview)({
              commandId: uuid(),
              projectId: project.projectId,
              conversationId: conversation.entityId,
              messageId: uuid(),
              model: "muse-spark-1.3",
              discipline: "auto",
              selection: {
                mode: "selected_sheets",
                revisionId: uuid(),
                sheetIds: Array.from({ length: 20_000 }, uuid),
              },
              maxCalls: null,
            }),
          ),
        );

        expect(Exit.isFailure(oversized)).toBe(true);

        if (Exit.isFailure(oversized)) {
          const error = oversized.cause.reasons[0];
          expect(error?._tag).toBe("Fail");
          expect(error?._tag === "Fail" ? error.error : null).toBeInstanceOf(ExecutionError);
          expect(error?._tag === "Fail" && error.error.reason).toBe("input");
        }

        // The refused body does not close the API.
        const after = yield* review.ReviewSnapshot({
          projectId: project.projectId,
          afterSequence: 0,
        });

        expect(after.messages).toHaveLength(3);
      }).pipe(
        Effect.provide(Layer.mergeAll(ReviewProxy, PacketProxy).pipe(Layer.provideMerge(launch))),
        Effect.scoped,
      ),
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 120_000);
