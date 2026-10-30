import { expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact } from "#lib/review/contracts.ts";
import type { PacketReview } from "#lib/review/packet.ts";
import { id, open, response } from "../fixtures/packet-review.ts";

test.each(["during-render", "during-next-inference"] as const)(
  "host tool activity observes real rendering and clears on pause %s",
  async (pauseAt) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-cloud-activity-"));
    const firstAdmitted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const observerReady = Promise.withResolvers<void>();
    const renderHeld = Promise.withResolvers<void>();
    const releaseRender = Promise.withResolvers<void>();
    const nextInference = Promise.withResolvers<void>();
    const nextAdmissionPublished = Promise.withResolvers<void>();
    const releaseInference = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const observed: PacketReview[] = [];
    const controller = new AbortController();
    let sends = 0;
    let sheetId = "";
    let draining = false;

    const session = await open(
      directory,
      async () => {
        switch (++sends) {
          case 1:
            firstAdmitted.resolve();
            await releaseFirst.promise;

            return response([{ name: "inventory_packet", arguments: {} }]);
          case 2:
            return response([{ name: "render_sheet", arguments: { sheetId } }]);
          default:
            nextInference.resolve();
            await releaseInference.promise;

            return response([], "The already admitted response has finished.");
        }
      },
      true,
      async (value) => {
        if (!Schema.is(Artifact)(value) || value.mediaType !== "image/png") return;

        renderHeld.resolve();
        await releaseRender.promise;
      },
    );

    const checkpoint = <A>(promise: Promise<A>) =>
      session.run(Effect.promise(() => promise).pipe(Effect.timeout("10 seconds")));

    let observation: Promise<unknown> | undefined;

    try {
      const sheet = (await session.snapshot()).sheets[0];

      if (!sheet) throw new Error("Missing drawing fixture");

      sheetId = sheet.id;

      const request = await session.request(
        "Review the confidential-request-sentinel drawing scope.",
      );

      const started = await session.run(session.packets.start(request));
      await checkpoint(firstAdmitted.promise);
      observation = session.runtime
        .runPromise(
          session.packets.observe(session.projectId).pipe(
            Stream.runForEach((review) =>
              Effect.sync(() => {
                if (review.id !== started.id) return;

                observed.push(review);
                observerReady.resolve();

                if (review.admittedCalls === 3) nextAdmissionPublished.resolve();

                if (draining && review.state === "paused") drained.resolve();
              }),
            ),
          ),
          { signal: controller.signal },
        )
        .catch(() => undefined);
      await checkpoint(observerReady.promise);
      releaseFirst.resolve();
      await checkpoint(renderHeld.promise);
      const rendering = await session.run(session.packets.get(session.projectId, started.id));
      expect(rendering.state).toBe("running");
      expect(rendering.activity).toMatchObject({
        tool: "render_sheet",
        stage: "rendering",
        sheetId: sheet.id,
        sheetLabel: (sheet.label || `Page ${sheet.pageIndex + 1}`).slice(0, 200),
        status: "active",
        finishedAt: null,
      });
      expect(rendering.activity?.startedAt).toBeGreaterThanOrEqual(started.startedAt);
      expect(sends).toBe(2);
      expect(
        observed.some(
          (review) =>
            review.activity?.tool === "inventory_packet" && review.activity.status === "active",
        ),
      ).toBe(true);
      expect(
        observed.some(
          (review) =>
            review.activity?.tool === "inventory_packet" && review.activity.status === "finished",
        ),
      ).toBe(true);

      if (pauseAt === "during-next-inference") {
        releaseRender.resolve();
        await checkpoint(nextInference.promise);
        const inference = await session.run(session.packets.get(session.projectId, started.id));
        expect(inference.state).toBe("running");
        expect(inference.activity).toMatchObject({ tool: "render_sheet", status: "finished" });
        expect(inference.activity?.finishedAt).toBeGreaterThanOrEqual(
          inference.activity?.startedAt ?? 0,
        );
        expect(inference.inspectedThisReviewSheetIds).toContain(sheet.id);
        expect(sends).toBe(3);
        await checkpoint(nextAdmissionPublished.promise);
        expect(observed.at(-1)?.admittedCalls).toBe(3);
      }

      const latest = await session.run(session.packets.get(session.projectId, started.id));

      const paused = await session.run(
        session.packets.control({
          projectId: session.projectId,
          reviewId: started.id,
          // A compatible pause remains valid after activity increments the packet version.
          expectedVersion: started.version,
          commandId: id(),
          action: "pause",
        }),
      );

      expect(paused.state).toBe("paused");
      expect(paused.activity).toBeNull();
      expect(paused.admittedCalls).toBe(latest.admittedCalls);
      draining = true;
      releaseRender.resolve();
      releaseInference.resolve();
      await checkpoint(drained.promise);
      expect(await session.run(session.packets.close)).toBe(true);
      const afterPause = await session.run(session.packets.get(session.projectId, started.id));
      expect(afterPause.activity).toBeNull();
      expect(afterPause.state).toBe("paused");
      const pausedEvents = observed.filter((review) => review.state !== "running");
      expect(pausedEvents.length).toBeGreaterThan(0);
      expect(pausedEvents.every((review) => review.activity === null)).toBe(true);
      expect(JSON.stringify(observed.map((review) => review.activity))).not.toContain(
        "confidential-request-sentinel",
      );
      expect(sends).toBe(pauseAt === "during-render" ? 2 : 3);
    } finally {
      releaseFirst.resolve();
      releaseRender.resolve();
      releaseInference.resolve();
      controller.abort();
      await observation;
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
