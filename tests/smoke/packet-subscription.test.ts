import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionError } from "#lib/review/execution.ts";
import { followPacketReviews, type ReconnectClock } from "#lib/review/packet-subscription.ts";
import { open, response, until } from "../fixtures/packet-review.ts";

/** Virtual time for the reconnect loop: a sleep resolves only once the test advances past it. */
function manualClock() {
  let now = 0;
  let timers: Array<{ readonly at: number; readonly resolve: () => void }> = [];
  const delays: Array<number> = [];
  const requests: Array<PromiseWithResolvers<number>> = [];
  const request = (index: number) => (requests[index] ??= Promise.withResolvers<number>());

  const clock: ReconnectClock = {
    now: () => now,
    sleep: (signal, milliseconds) => {
      const done = Promise.withResolvers<void>();
      const timer = { at: now + milliseconds, resolve: done.resolve };
      request(delays.length).resolve(milliseconds);
      delays.push(milliseconds);
      timers.push(timer);

      signal.addEventListener(
        "abort",
        () => {
          timers = timers.filter((entry) => entry !== timer);
          done.resolve();
        },
        { once: true },
      );

      return done.promise;
    },
  };

  return {
    clock,
    /** Every delay the loop has asked for, in order. */
    delays,
    /** Resolve with the delay of the `count`th sleep once the loop requests it. */
    slept: (count: number) => request(count - 1).promise,
    /** Move virtual time forward and wake every sleep that is now due. */
    advance(milliseconds: number) {
      now += milliseconds;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      due.forEach((timer) => timer.resolve());
    },
  };
}

/** Let promise continuations run; a woken sleep reconnects before this resolves. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  const time = manualClock();
  const connected = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
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
      clock: time.clock,
      client: {
        observePacketReviews: async (projectId, onReview, signal) => {
          attempts++;
          connected[attempts - 1]?.resolve();
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

    // The first stream ends before the review fails; the reload replays the missed failure.
    expect(await time.slept(1)).toBe(1000);
    expect(attempts).toBe(1);
    expect(reloads).toBe(1);
    expect(states.at(-1)).toBe("failed");
    time.advance(999);
    await settle();
    expect(attempts).toBe(1);
    time.advance(1);
    await connected[1]?.promise;
    expect(await time.slept(2)).toBe(2000);
    expect(connections).not.toContain(true);
    time.advance(2000);
    await connected[2]?.promise;
    // A third consecutive end shows the reconnecting warning before the next attempt.
    expect(await time.slept(3)).toBe(4000);
    expect(connections.at(-1)).toBe(true);
    time.advance(4000);
    await connected[3]?.promise;
    await recovered.promise;
    controller.abort();
    await following;
    time.advance(60000);
    await settle();
    expect(states).toContain("running");
    expect(states).toContain("failed");
    expect(reloads).toBe(3);
    expect(attempts).toBe(4);
    expect(time.delays).toEqual([1000, 2000, 4000]);
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
