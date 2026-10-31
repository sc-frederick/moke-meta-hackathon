import { expect, test } from "bun:test";
import { Effect, Option, Schema, Stream } from "effect";
import { Database } from "bun:sqlite";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketReview } from "#lib/review/packet.ts";
import { decodeRequest, id, open, response, until } from "../fixtures/packet-review.ts";

test.each(["complete", "budget", "cancel", "admission failure"] as const)(
  "finish-boundary steering owns its idle Pi continuation: %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-finish-steer-"));
    const entered = Promise.withResolvers<void>();
    const releaseInitial = Promise.withResolvers<void>();
    const staged = Promise.withResolvers<void>();
    const releaseStaged = Promise.withResolvers<void>();
    const continued = Promise.withResolvers<void>();
    const releaseContinuation = Promise.withResolvers<void>();
    const requests: string[] = [];
    const Stage = Schema.Struct({ review: PacketReview, submit: Schema.Literal(true) });

    const api = await open(
      directory,
      async (_url, init) => {
        requests.push(JSON.stringify(decodeRequest(init)));

        if (requests.length === 1) {
          entered.resolve();
          await releaseInitial.promise;

          return response([], "Initial run finished.");
        }

        continued.resolve();
        await releaseContinuation.promise;

        return requests.length === 2
          ? response([
              {
                name: "finish_review",
                arguments: { summary: "Boundary instruction answered.", missingInputs: [] },
              },
            ])
          : response([], "Boundary instruction answered.");
      },
      true,
      async (value) => {
        if (Option.isSome(Schema.decodeUnknownOption(Stage)(value))) {
          staged.resolve();
          await releaseStaged.promise;

          if (outcome === "admission failure")
            throw new ExecutionError({
              reason: "unavailable",
              message: "Injected admission interruption after durable intent.",
            });
        }
      },
    );

    let journal: Database | undefined;

    try {
      const request = await api.request("Review the packet", {
        maxCalls: outcome === "budget" ? 1 : 4,
      });

      const review = await api.run(api.packets.start(request));
      await entered.promise;

      const instruction = {
        commandId: id(),
        projectId: api.projectId,
        reviewId: review.id,
        conversationId: request.conversationId,
        text: "Check the boundary instruction before completing.",
      };

      const first = api.run(Effect.exit(api.packets.steer(instruction)));
      await staged.promise;
      const duplicate = api.run(Effect.exit(api.packets.steer(instruction)));
      releaseInitial.resolve();

      const journalId = await api.database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return Schema.decodeUnknownSync(Schema.Struct({ journal_id: Schema.String }))(
            (yield* sql`SELECT journal_id FROM packet_reviews WHERE id=${review.id}`)[0],
          ).journal_id;
        }),
      );

      journal = new Database(join(directory, "execution-journals", `${journalId}.sqlite`), {
        readonly: true,
      });
      const deadline = performance.now() + 20000;

      while (
        Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
          journal.query("SELECT status FROM submissions ORDER BY id LIMIT 1").get(),
        ).status !== "done"
      ) {
        if (performance.now() > deadline) throw new Error("Initial Pi submission did not settle");
        await Bun.sleep(5);
      }
      // The first Pi run is durably done, but the staged host instruction still owns the lifecycle.

      expect((await api.run(api.packets.get(api.projectId, review.id))).state).toBe("running");

      if (outcome === "cancel") {
        const current = await api.run(api.packets.get(api.projectId, review.id));
        await api.run(
          api.packets.control({
            projectId: api.projectId,
            reviewId: review.id,
            commandId: id(),
            expectedVersion: current.version,
            action: "cancel",
          }),
        );
      }

      releaseStaged.resolve();
      const replies = await Promise.all([first, duplicate]);
      expect(replies.map((reply) => reply._tag)).toEqual(
        outcome === "admission failure" ? ["Failure", "Failure"] : ["Success", "Success"],
      );

      if (outcome === "complete") {
        await continued.promise;
        expect((await api.run(api.packets.get(api.projectId, review.id))).state).toBe("running");
        releaseContinuation.resolve();
      }

      const terminal = {
        complete: "completed",
        budget: "paused",
        cancel: "cancelled",
        "admission failure": "failed",
      } as const;

      const final = await until(api, review.id, terminal[outcome]);

      expect(final.steering?.[0]?.status).toBe(outcome === "complete" ? "applied" : "unanswered");
      expect(requests).toHaveLength(outcome === "complete" ? 3 : 1);
      expect(
        (await api.snapshot()).messages.filter((message) => message.id === instruction.commandId),
      ).toHaveLength(1);
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Number }))(
          journal.query("SELECT count(*) AS total FROM submissions").get(),
        ).total,
      ).toBe(outcome === "admission failure" ? 1 : 2);

      if (outcome === "complete") expect(requests[1]).toContain(instruction.text);
    } finally {
      releaseInitial.resolve();
      releaseStaged.resolve();
      releaseContinuation.resolve();
      journal?.close();
      await api.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  80000,
);

test("a provider failure withdraws queued steering without retrying uncertain work or blocking reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-failed-steer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;

  const transport = async () => {
    calls++;
    entered.resolve();
    await release.promise;
    throw new Error("Fixture transport failed after dispatch");
  };

  let api = await open(directory, transport);
  let journal: Database | undefined;

  try {
    const request = await api.request("Review the packet");
    const review = await api.run(api.packets.start(request));
    await entered.promise;

    const instruction = {
      commandId: id(),
      projectId: api.projectId,
      reviewId: review.id,
      conversationId: request.conversationId,
      text: "Check Room 101 before finishing this review.",
    };

    const queued = await api.run(api.packets.steer(instruction));
    expect(queued.steering?.map((item) => item.status)).toEqual(["queued"]);

    const journalId = await api.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return Schema.decodeUnknownSync(Schema.Struct({ journal_id: Schema.String }))(
          (yield* sql`SELECT journal_id FROM packet_reviews WHERE id=${review.id}`)[0],
        ).journal_id;
      }),
    );

    journal = new Database(join(directory, "execution-journals", `${journalId}.sqlite`), {
      readonly: true,
    });

    const submissions = journal.query(
      "SELECT json_extract(record,'$.requestId') AS requestId,status,json_extract(record,'$.reason') AS reason FROM submissions ORDER BY id",
    );

    const readSubmissions = () =>
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            requestId: Schema.String,
            status: Schema.String,
            reason: Schema.NullOr(Schema.String),
          }),
        ),
      )(submissions.all());

    expect(readSubmissions()).toEqual([
      { requestId: review.id, status: "placed", reason: null },
      { requestId: instruction.commandId, status: "queued", reason: null },
    ]);
    release.resolve();
    let settled = await until(api, review.id, "uncertain");
    const deadline = performance.now() + 8000;

    while (settled.steering?.[0]?.status !== "unanswered" && performance.now() < deadline) {
      await Bun.sleep(5);
      settled = await api.run(api.packets.get(api.projectId, review.id));
    }

    expect(settled.steering).toEqual([
      { commandId: instruction.commandId, text: instruction.text, status: "unanswered" },
    ]);
    expect(settled.state).toBe("uncertain");
    expect(settled.admittedCalls).toBe(1);
    expect(readSubmissions()).toEqual([
      { requestId: review.id, status: "unanswered", reason: "model_error" },
      { requestId: instruction.commandId, status: "unanswered", reason: "run_failed" },
    ]);
    journal.close();
    journal = undefined;
    await api.dispose();
    api = await open(directory, transport, false);
    const restored = await api.run(api.packets.get(api.projectId, review.id));
    expect(restored.state).toBe("uncertain");
    expect(restored.steering).toEqual(settled.steering);
    expect((await api.run(api.packets.start(request))).id).toBe(review.id);
    expect((await api.run(api.packets.steer(instruction))).steering).toEqual(settled.steering);

    const resumed = await api.run(
      Effect.exit(
        api.packets.control({
          projectId: api.projectId,
          reviewId: review.id,
          expectedVersion: restored.version,
          commandId: id(),
          action: "resume",
        }),
      ),
    );

    expect(resumed._tag).toBe("Failure");
    expect(String(resumed)).toContain("Uncertain work must not be resent");
    expect(
      (await api.snapshot()).messages.filter((message) => message.id === instruction.commandId),
    ).toHaveLength(1);
    expect(
      await api.database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql`SELECT status,sent FROM packet_review_attempts WHERE review_id=${review.id}`;
        }),
      ),
    ).toEqual([{ status: "uncertain", sent: 1 }]);
    await api.dispose();
    expect(calls).toBe(1);
  } finally {
    release.resolve();
    journal?.close();
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test.each(["tool round", "final answer"] as const)(
  "active durable steering at a %s is idempotent, conversation-scoped, delivered, and recorded across reopen",
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-steer-audit-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: string[] = [];

    const api = await open(directory, async (_url, init) => {
      const request = decodeRequest(init);
      requests.push(JSON.stringify(request));

      if (requests.length === 1) {
        entered.resolve();
        await release.promise;

        return boundary === "tool round"
          ? response([{ name: "inventory_packet", arguments: {} }])
          : response([], "Initial answer before the queued steering instruction.");
      }

      return requests.length === 2
        ? response([
            {
              name: "finish_review",
              arguments: {
                summary: "Applied the follow-up instruction to this review.",
                missingInputs: [],
              },
            },
          ])
        : response([], "Applied the follow-up instruction to this review.");
    });

    const observed: number[] = [];
    const controller = new AbortController();

    const observing = api.runtime
      .runPromise(
        Stream.runForEach(api.packets.observe(api.projectId), (review) =>
          Effect.sync(() => observed.push(review.version)),
        ),
        { signal: controller.signal },
      )
      .catch(() => undefined);

    try {
      const request = await api.request("Review the drawing packet");
      const review = await api.run(api.packets.start(request));
      await entered.promise;

      const instruction = {
        commandId: id(),
        projectId: api.projectId,
        reviewId: review.id,
        conversationId: request.conversationId,
        text: "Prioritize the Room 101 schedule conflict before finishing.",
      };

      const [queued] = await Promise.all([
        api.run(api.packets.steer(instruction)),
        api.run(api.packets.steer(instruction)),
      ]);

      expect(queued.steering?.map((item) => item.status)).toEqual(["queued"]);
      await api.run(api.packets.steer(instruction));

      const wrongConversation = await api.run(
        Effect.exit(
          api.packets.steer({
            ...instruction,
            commandId: id(),
            conversationId: Schema.decodeUnknownSync(
              ReviewCommand.cases.PostMessage.fields.conversationId,
            )(crypto.randomUUID()),
          }),
        ),
      );

      expect(String(wrongConversation)).toContain("another conversation");
      release.resolve();
      const done = await until(api, review.id, "completed");
      expect(done.steering?.map((item) => item.status)).toEqual(["applied"]);
      expect(requests).toHaveLength(3);
      expect(requests[1]).toContain(instruction.text);
      expect(
        (await api.snapshot()).messages.filter((message) => message.text === instruction.text),
      ).toHaveLength(1);
      expect(observed.length).toBeGreaterThan(3);
      controller.abort();
      await observing;
      const current = await api.run(api.packets.get(api.projectId, review.id));
      expect(current.state).toBe("completed");
      await api.dispose();

      const reopened = await open(
        directory,
        async () => {
          throw new Error("No duplicate paid dispatch on reopen");
        },
        false,
      );

      try {
        expect(
          (await reopened.run(reopened.packets.get(api.projectId, review.id))).steering?.[0]
            ?.status,
        ).toBe("applied");
      } finally {
        await reopened.dispose();
      }
    } finally {
      release.resolve();
      controller.abort();
      await observing;
      await api.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("queued follow-up survives an exhausted call budget and explicit resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-steer-budget-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];

  const api = await open(directory, async (_url, init) => {
    requests.push(JSON.stringify(decodeRequest(init)));

    if (requests.length === 1) {
      entered.resolve();
      await release.promise;

      return response([{ name: "inventory_packet", arguments: {} }]);
    }

    return requests.length === 2
      ? response([
          {
            name: "finish_review",
            arguments: { summary: "Resumed with the queued instruction.", missingInputs: [] },
          },
        ])
      : response([], "Resumed with the queued instruction.");
  });

  try {
    const request = await api.request("Review the packet", { maxCalls: 1 });
    const review = await api.run(api.packets.start(request));
    await entered.promise;
    await api.run(
      api.packets.steer({
        commandId: id(),
        projectId: api.projectId,
        reviewId: review.id,
        conversationId: request.conversationId,
        text: "Prioritize Room 101 while finishing.",
      }),
    );
    release.resolve();
    const paused = await until(api, review.id, "paused");
    await api.run(
      api.packets.control({
        commandId: id(),
        projectId: api.projectId,
        reviewId: review.id,
        expectedVersion: paused.version,
        action: "resume",
        maxCalls: 4,
      }),
    );
    const done = await until(api, review.id, "completed");
    expect(requests[1]).toContain("Prioritize Room 101");
    expect(done.steering?.[0]?.status).toBe("applied");
    expect(requests).toHaveLength(3);
  } finally {
    release.resolve();
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
