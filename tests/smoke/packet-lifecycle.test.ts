import { expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact } from "#lib/review/contracts.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  until,
  type Session,
} from "../fixtures/packet-review.ts";

const Attempt = Schema.Struct({
  kind: Schema.Literals(["model", "sam"]),
  status: Schema.Literals(["uncertain", "completed"]),
  sent: Schema.Literals([0, 1]),
  response_json: Schema.NullOr(Schema.String),
});

const attempts = (session: Session, reviewId: string) =>
  session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
        yield* sql`SELECT kind,status,sent,response_json FROM packet_review_attempts WHERE review_id=${reviewId} ORDER BY task_id,attempt,kind`,
      );
    }),
  );

async function untilSamCompleted(session: Session, reviewId: string) {
  const deadline = performance.now() + 10000;

  while (performance.now() < deadline) {
    const saved = await attempts(session, reviewId);
    const sam = saved.find((attempt) => attempt.kind === "sam");

    if (sam?.status === "completed") return sam;
    await Bun.sleep(10);
  }

  throw new Error("The admitted SAM response did not become a completed durable receipt.");
}

test("a successful SAM response drains while paused and explicit resume does not resend it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-sam-pause-"));
  const samAdmitted = Promise.withResolvers<void>();
  const releaseSam = Promise.withResolvers<void>();
  let modelSends = 0;
  let samSends = 0;
  let sheetId = "";

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") {
      samSends++;
      samAdmitted.resolve();
      await releaseSam.promise;

      return Response.json({
        id: "sam-paused-success",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
      });
    }

    switch (++modelSends) {
      case 1:
        return response([{ name: "render_sheet", arguments: { sheetId } }]);
      case 2: {
        const rendered = outputs(Schema.Struct({ artifact: Artifact }), request).at(-1);

        if (!rendered) throw new Error("The real PDF image was not delivered to the model.");

        return response([
          {
            name: "segment_objects",
            arguments: {
              artifactId: rendered.artifact.id,
              prompt: { kind: "concept", text: "luminaires" },
            },
          },
        ]);
      }

      case 3:
        return response([
          {
            name: "finish_review",
            arguments: {
              summary: "Explicitly resumed after preserving the completed SAM inspection.",
              missingInputs: ["No accepted object count is inferred from zero SAM matches."],
            },
          },
        ]);
      case 4:
        return response([], "The saved SAM inspection was retained without another dispatch.");
      default:
        throw new Error("The paused SAM inspection unexpectedly dispatched another model request.");
    }
  });

  try {
    const sheet = (await session.snapshot()).sheets[0];

    if (!sheet) throw new Error("The fixture PDF has no source sheet.");
    sheetId = sheet.id;

    const request = await session.request(
      "Review the electrical drawing and inspect its luminaires.",
    );

    const started = await session.run(session.packets.start(request));
    await session.run(Effect.promise(() => samAdmitted.promise).pipe(Effect.timeout("10 seconds")));
    const admitted = await session.run(session.packets.get(session.projectId, started.id));
    expect(admitted.admittedCalls).toBe(3);
    expect(admitted.activity).toMatchObject({
      tool: "segment_objects",
      stage: "segmentation",
      status: "active",
      sheetId,
    });
    expect(await attempts(session, started.id)).toMatchObject([
      { kind: "model", status: "completed", sent: 1 },
      { kind: "model", status: "completed", sent: 1 },
      { kind: "sam", status: "uncertain", sent: 1, response_json: null },
    ]);

    const paused = await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: admitted.version,
        action: "pause",
        commandId: id(),
      }),
    );

    expect(paused.state).toBe("paused");
    expect(paused.activity).toBeNull();
    expect(modelSends).toBe(2);
    expect(samSends).toBe(1);
    releaseSam.resolve();
    const receipt = await untilSamCompleted(session, started.id);
    expect(receipt.response_json).toContain("sam-paused-success");
    const drained = await session.run(session.packets.get(session.projectId, started.id));
    expect(drained.state).toBe("paused");
    expect(drained.error).toBeNull();
    expect(drained.admittedCalls).toBe(3);
    expect(modelSends).toBe(2);
    expect(samSends).toBe(1);

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: drained.version,
        action: "resume",
        commandId: id(),
      }),
    );
    const completed = await until(session, started.id, "completed");
    expect(completed.finished).toBe(true);
    expect(completed.activity).toBeNull();
    expect(completed.summary).toContain("preserving the completed SAM inspection");
    expect(completed.error).toBeNull();
    // One finish attempt is returned by the coverage gate; the scripted sends stay at four.
    expect(completed.admittedCalls).toBe(6);
    expect(completed.evidenceIds).toHaveLength(1);
    expect(modelSends).toBe(4);
    expect(samSends).toBe(1);
    expect(
      (await attempts(session, started.id)).every((attempt) => attempt.status === "completed"),
    ).toBe(true);
  } finally {
    releaseSam.resolve();
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("shutdown preserves an unresolved admitted request as uncertain across reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-shutdown-"));
  const admitted = Promise.withResolvers<void>();
  const provider = Promise.withResolvers<Response>();
  let sends = 0;

  const transport = async () => {
    sends++;
    admitted.resolve();

    return await provider.promise;
  };

  let session = await open(directory, transport);
  let closing: Promise<boolean> | undefined;

  try {
    const request = await session.request("Review the supplied packet for coordination issues.");
    const started = await session.run(session.packets.start(request));
    await session.run(Effect.promise(() => admitted.promise).pipe(Effect.timeout("10 seconds")));
    closing = session.run(session.packets.close);
    const interrupted = await until(session, started.id, "uncertain");
    expect(interrupted.error).toContain("unresolved");
    expect(interrupted.admittedCalls).toBe(1);
    provider.reject(new Error("The external connection ended before a receipt was available."));
    expect(await closing).toBe(true);
    await session.dispose();

    session = await open(directory, transport, false);
    const restored = await session.run(session.packets.get(session.projectId, started.id));
    expect(restored.state).toBe("uncertain");
    expect(restored.error).toContain("will not be sent again");
    expect(await attempts(session, started.id)).toMatchObject([
      { kind: "model", status: "uncertain", sent: 1, response_json: null },
    ]);
    expect((await session.run(session.packets.start(request))).state).toBe("uncertain");

    const resumed = await session.run(
      Effect.result(
        session.packets.control({
          projectId: session.projectId,
          reviewId: started.id,
          expectedVersion: restored.version,
          action: "resume",
          commandId: id(),
        }),
      ),
    );

    expect(Result.isFailure(resumed)).toBe(true);

    if (Result.isFailure(resumed)) expect(resumed.failure.reason).toBe("incompatible");
    expect(sends).toBe(1);
  } finally {
    provider.reject(new Error("Packet shutdown fixture teardown."));
    await closing;
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test.each(["uncertain", "completed"] as const)(
  "startup reconciles a prior owner's paused review with a %s request receipt without sending it",
  async (receiptStatus) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-packet-legacy-paused-"));
    let sends = 0;

    const transport = async () => {
      sends++;

      return sends === 1
        ? response([{ name: "inventory_packet", arguments: {} }])
        : response([], "The reviewer explicitly resumed the fully receipted paused review.");
    };

    let session = await open(directory, transport);

    try {
      const request = await session.request("Perform a packet QA pass.", { maxCalls: 1 });
      const started = await session.run(session.packets.start(request));
      await until(session, started.id, "paused");
      expect(await attempts(session, started.id)).toMatchObject([
        { kind: "model", status: "completed", sent: 1 },
      ]);
      await session.dispose();

      // Earlier releases could persist a paused review despite its unresolved provider intent.
      // Recreate that durable legacy shape after releasing ownership, rather than replacing the store.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE packet_reviews SET payload=json_set(payload,'$.state','paused','$.error',NULL) WHERE id=${started.id}`;

            if (receiptStatus === "uncertain")
              yield* sql`UPDATE packet_review_attempts SET status='uncertain',response_json=NULL WHERE review_id=${started.id}`;
          }).pipe(Effect.provide(SqliteClient.layer({ filename: join(directory, "app.sqlite") }))),
        ),
      );

      session = await open(directory, transport, false);
      const restored = await session.run(session.packets.get(session.projectId, started.id));
      expect(restored.admittedCalls).toBe(1);
      expect(sends).toBe(1);
      expect((await attempts(session, started.id))[0]?.status).toBe(receiptStatus);

      if (receiptStatus === "uncertain") {
        expect(restored.state).toBe("uncertain");
        expect(restored.error).toContain("unresolved");

        const resumed = await session.run(
          Effect.result(
            session.packets.control({
              projectId: session.projectId,
              reviewId: started.id,
              expectedVersion: restored.version,
              action: "resume",
              commandId: id(),
              maxCalls: 3,
            }),
          ),
        );

        expect(Result.isFailure(resumed)).toBe(true);

        if (Result.isFailure(resumed)) expect(resumed.failure.reason).toBe("incompatible");
        expect(sends).toBe(1);
      } else {
        expect(restored.state).toBe("paused");
        expect(restored.error).toContain("Resume explicitly");
        await session.run(
          session.packets.control({
            projectId: session.projectId,
            reviewId: started.id,
            expectedVersion: restored.version,
            action: "resume",
            commandId: id(),
            maxCalls: 3,
          }),
        );
        const completed = await until(session, started.id, "failed");
        expect(completed.summary).toContain("explicitly resumed");
        expect(completed.admittedCalls).toBe(2);
        expect(sends).toBe(2);
      }
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
