import { expect, test } from "bun:test";
import { Effect, Option, Schema, Stream } from "effect";
import { Database } from "bun:sqlite";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketReview, PacketScope } from "#lib/review/packet.ts";
import { createDropImports } from "../../desktop/drop-imports.ts";
import {
  assertDesktopTestEnvironment,
  isHostedDesktopRunner,
} from "../../scripts/desktop-test-environment.ts";
import { followPacketReviews } from "#lib/review/packet-subscription.ts";
import { decodeRequest, id, open, response, until } from "../fixtures/packet-review.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("desktop guards accept only dedicated hosted runners or the private display", () => {
  for (const env of [
    { CI: "true" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" },
    { RUNNER_ENVIRONMENT: "github-hosted" },
  ]) {
    expect(isHostedDesktopRunner(env)).toBe(false);
    expect(() =>
      assertDesktopTestEnvironment({
        ...env,
        MOKE_TEST_RUNTIME: "/private",
        MOKE_TEST_HOSTED_RUNNER: "1",
        DISPLAY: ":0",
      }),
    ).toThrow("Inherited desktops");
  }

  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  expect(isHostedDesktopRunner(hosted)).toBe(true);
  expect(() => assertDesktopTestEnvironment(hosted)).toThrow("private runtime");
  expect(() =>
    assertDesktopTestEnvironment({
      ...hosted,
      MOKE_TEST_RUNTIME: "/private",
      MOKE_TEST_HOSTED_RUNNER: "1",
    }),
  ).not.toThrow();

  const isolated = {
    MOKE_TEST_RUNTIME: "/private",
    MOKE_TEST_ISOLATED_DISPLAY: ":99",
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
  };

  expect(() => assertDesktopTestEnvironment(isolated)).not.toThrow();
  expect(() => assertDesktopTestEnvironment({ ...isolated, DISPLAY: ":0" })).toThrow(
    "Inherited desktops",
  );
  expect(() => assertDesktopTestEnvironment({ ...isolated, WAYLAND_DISPLAY: "wayland-0" })).toThrow(
    "Inherited desktops",
  );
});

test("a drop claim rejects fresh-command reuse and preserves same-command receipts across response loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-drop-claim-"));
  const api = await open(directory, async () => response());

  try {
    const source = join(directory, "Revision.pdf");
    await writeFile(source, createHeroPdf("B"));
    const drops = createDropImports();
    const token = drops.stage(source);

    if (!token) throw new Error("Missing drop token");

    const request = {
      projectId: api.projectId,
      expectedVersion: (await api.snapshot()).project?.version ?? -1,
      commandId: id(),
      dropToken: token,
      revisionLabel: "Rev 1",
    };

    const [first, duplicate] = await Promise.all([
      api.run(drops.claim(request, token)),
      api.run(drops.claim(request, token)),
    ]);

    const other = await api.run(Effect.exit(drops.claim({ ...request, commandId: id() }, token)));
    expect(String(other)).toContain("another import request");
    const imported = await api.importPdf({ ...request, source: first.source, name: "Rev 1" });
    // Simulate losing the backend response before the shell caches it: replay the original command.
    const replayed = await api.importPdf({ ...request, source: duplicate.source, name: "Rev 1" });
    expect(replayed).toEqual(imported);
    duplicate.complete(replayed);
    await rm(source);
    const recovered = await api.run(drops.claim(request, token));
    expect(recovered.receipt).toEqual(imported);
    const state = await api.snapshot();
    expect(state.revisions).toHaveLength(2);
    expect(
      String(
        await api.run(
          Effect.exit(
            drops.claim(
              { ...request, commandId: id(), expectedVersion: state.project?.version ?? -1 },
              token,
            ),
          ),
        ),
      ),
    ).toContain("another import request");
    expect(
      String(
        await api.run(Effect.exit(drops.claim({ ...request, revisionLabel: "Changed" }, token))),
      ),
    ).toContain("another import request");
  } finally {
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

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

        return response([], "Boundary instruction answered.");
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
      const deadline = performance.now() + 5000;

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
      expect(requests).toHaveLength(outcome === "complete" ? 2 : 1);
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
  20000,
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
    const deadline = performance.now() + 2000;

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
}, 15000);

// These exercise real SQLite, Pi journals, public operations and provider admission; no model is called.
test("sheet assignments persist without confirming count coverage and explicit scopes freeze only selected revision sheets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-scope-audit-"));
  const api = await open(directory, async () => response([], "Scoped fixture completed."));

  try {
    let state = await api.snapshot();
    const first = state.sheets[0];
    const second = state.sheets[1];

    if (!first || !second) throw new Error("Missing drawing fixture");
    await api.command(
      ReviewCommand.cases.AssignSheetDiscipline.make({
        commandId: id(),
        projectId: api.projectId,
        expectedVersion: state.project?.version ?? -1,
        sheetIds: [first.id],
        discipline: "electrical",
      }),
    );
    state = await api.snapshot();
    await api.command(
      ReviewCommand.cases.AssignSheetDiscipline.make({
        commandId: id(),
        projectId: api.projectId,
        expectedVersion: state.project?.version ?? -1,
        sheetIds: [second.id],
        discipline: "fire_alarm",
      }),
    );
    state = await api.snapshot();
    expect(state.sheets.map((sheet) => sheet.discipline)).toEqual(["electrical", "fire_alarm"]);
    expect(state.sheets.every((sheet) => !sheet.confirmed && sheet.coverage === "unreviewed")).toBe(
      true,
    );

    const selected = await api.run(
      api.packets.start(
        await api.request("Review these selected sheets", {
          selection: {
            mode: "selected_sheets",
            revisionId: first.revisionId,
            sheetIds: [second.id],
          },
        }),
      ),
    );

    const complete = await until(api, selected.id, "completed");
    expect(complete.scope._tag).toBe("SelectedSheets");
    expect(complete.sheets.map((sheet) => sheet.id)).toEqual([second.id]);

    const discipline = await api.run(
      api.packets.start(
        await api.request("Review the whole drawing set, especially electrical", {
          discipline: "electrical",
          selection: { mode: "discipline", revisionId: first.revisionId, sheetIds: [] },
        }),
      ),
    );

    const done = await until(api, discipline.id, "completed");
    expect(done.scope).toEqual(PacketScope.cases.Discipline.make({ discipline: "electrical" }));
    expect(done.sheets.map((sheet) => [sheet.id, sheet.discipline])).toEqual([
      [first.id, "electrical"],
    ]);

    const invalid = await api.run(
      Effect.exit(
        api.packets.start(
          await api.request("Review sprinkler", {
            discipline: "fire_sprinkler",
            selection: { mode: "discipline", revisionId: first.revisionId, sheetIds: [] },
          }),
        ),
      ),
    );

    expect(String(invalid)).toContain("No sheets match");
    state = await api.snapshot();
    const revised = join(directory, "Revised.pdf");
    await writeFile(revised, createHeroPdf("B"));
    await api.importPdf({
      commandId: id(),
      projectId: api.projectId,
      expectedVersion: state.project?.version ?? -1,
      source: revised,
      name: "Rev 1",
    });
    state = await api.snapshot();
    const latestRevision = state.revisions.at(-1);

    if (!latestRevision) throw new Error("Missing imported revision");

    const whole = await api.run(
      api.packets.start(
        await api.request("Review electrical", {
          discipline: "electrical",
          selection: { mode: "whole_set", revisionId: latestRevision.id, sheetIds: [] },
        }),
      ),
    );

    const wholeDone = await until(api, whole.id, "completed");
    expect(wholeDone.scope._tag).toBe("WholeSet");
    expect(wholeDone.sheets).toHaveLength(2);
    expect(wholeDone.sheets.every((sheet) => sheet.revisionId === latestRevision.id)).toBe(true);

    const mixed = await api.run(
      Effect.exit(
        api.packets.start(
          await api.request("Review selected", {
            selection: {
              mode: "selected_sheets",
              revisionId: latestRevision.id,
              sheetIds: [first.id],
            },
          }),
        ),
      ),
    );

    expect(String(mixed)).toContain("Selected sheets must belong");

    const links = await api.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT old_sheet_id FROM review_sheet_links WHERE project_id=${api.projectId}`;
      }),
    );

    expect(links).toHaveLength(0);
    await api.dispose();

    const reopened = await open(
      directory,
      async () => {
        throw new Error("Reopen must not dispatch");
      },
      false,
    );

    try {
      expect(
        (await reopened.snapshot()).sheets
          .filter((sheet) => sheet.revisionId === first.revisionId)
          .map((sheet) => sheet.discipline),
      ).toEqual(["electrical", "fire_alarm"]);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ended progress streams reload missed durable records, reconnect automatically, clear the warning, and stop on abort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-progress-audit-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const api = await open(directory, async () => {
    entered.resolve();
    await release.promise;

    return response([], "Recorded while the progress transport was disconnected.");
  });

  const controller = new AbortController();
  const recovered = Promise.withResolvers<void>();
  const states: string[] = [];
  const connections: boolean[] = [];
  let attempts = 0;
  let reloads = 0;

  try {
    const review = await api.run(api.packets.start(await api.request("Review the packet")));
    await entered.promise;

    const following = followPacketReviews({
      projectId: api.projectId,
      signal: controller.signal,
      client: {
        observePacketReviews: async (projectId, onReview, signal) => {
          attempts++;
          const source = api.packets.observe(projectId);
          const interrupted = attempts <= 3 ? source.pipe(Stream.take(1)) : source;

          try {
            await api.runtime.runPromise(
              Stream.runForEach(interrupted, (value) => Effect.promise(() => onReview(value))),
              { signal },
            );

            if (attempts === 1)
              return {
                ok: false,
                error: new ExecutionError({
                  reason: "unavailable",
                  message: "Injected transport interruption",
                }),
              };

            return { ok: true, value: undefined };
          } catch {
            return {
              ok: false,
              error: new ExecutionError({ reason: "cancelled", message: "Subscription aborted" }),
            };
          }
        },
        listPacketReviews: async (projectId) => {
          reloads++;
          release.resolve();
          await until(api, review.id, "completed");

          return { ok: true, value: await api.run(api.packets.list(projectId)) };
        },
      },
      onReview: (value) => {
        states.push(value.state);

        if (attempts >= 4 && value.state === "completed") recovered.resolve();
      },
      onConnectionLost: (lost) => connections.push(lost),
      onError: (message) => expect(message).toBe("Injected transport interruption"),
    });

    await recovered.promise;
    controller.abort();
    await following;
    expect(states).toContain("running");
    expect(states).toContain("completed");
    expect(reloads).toBe(3);
    expect(attempts).toBe(4);
    expect(connections).toContain(true);
    expect(connections.at(-1)).toBe(false);
    expect((await api.run(api.packets.get(api.projectId, review.id))).state).toBe("completed");
  } finally {
    release.resolve();
    controller.abort();
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

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

      return response([], "Applied the follow-up instruction to this review.");
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
      expect(requests).toHaveLength(2);
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

    return response([], "Resumed with the queued instruction.");
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
    expect(requests).toHaveLength(2);
  } finally {
    release.resolve();
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
