import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionError } from "#lib/review/execution.ts";
import { followPacketReviews } from "#lib/review/packet-subscription.ts";
import { open, response, until } from "../fixtures/packet-review.ts";

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
          await until(api, review.id, "failed");

          return { ok: true, value: await api.run(api.packets.list(projectId)) };
        },
      },
      onReview: (value) => {
        states.push(value.state);

        if (attempts >= 4 && value.state === "failed") recovered.resolve();
      },
      onConnectionLost: (lost) => connections.push(lost),
      onError: (message) => expect(message).toBe("Injected transport interruption"),
    });

    await recovered.promise;
    controller.abort();
    await following;
    expect(states).toContain("running");
    expect(states).toContain("failed");
    expect(reloads).toBe(3);
    expect(attempts).toBe(4);
    expect(connections).toContain(true);
    expect(connections.at(-1)).toBe(false);
    expect((await api.run(api.packets.get(api.projectId, review.id))).state).toBe("failed");
  } finally {
    release.resolve();
    controller.abort();
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 80000);
