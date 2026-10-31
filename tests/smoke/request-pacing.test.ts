import { expect, test } from "bun:test";
import { type PacerClock, type PacerLease, RequestPacer } from "../../backend/inference/pacing.ts";

/** Wall time when every manual clock starts. */
const startedAt = Date.UTC(2026, 9, 31, 12, 0, 0);

/** A clock that moves only when the test advances it, firing due timers in order. */
function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = [];

  const clock: PacerClock = {
    now: () => now,
    wall: () => startedAt + now,
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);

      return () => {
        timer.live = false;
      };
    },
    random: () => 1,
  };

  const advance = async (ms: number) => {
    const target = now + ms;

    for (;;) {
      const due = timers
        .filter((timer) => timer.live && timer.at <= target)
        .toSorted((left, right) => left.at - right.at)[0];

      if (due === undefined) break;
      now = due.at;
      due.live = false;
      due.callback();
      await Promise.resolve();
    }

    now = target;
    await Promise.resolve();
  };

  return { clock, advance };
}

/** Record when each acquisition resolves, in clock time. */
function track(pacer: RequestPacer, clock: PacerClock, label: string, order: Array<string>) {
  return pacer.acquire(1).then((lease) => {
    order.push(`${label}@${clock.now()}`);

    return lease;
  });
}

test("requests beyond half a minute's allowance wait for the limit to replenish, in arrival order", async () => {
  const { clock, advance } = manualClock();
  // 120 requests a minute holds 60 at once and replenishes one every 500 ms.
  const pacer = new RequestPacer({ requestsPerMinute: 120, tokensPerMinute: 10_000_000 }, clock);
  const order: Array<string> = [];

  const burst = await Promise.all(
    Array.from({ length: 60 }, (_, index) => track(pacer, clock, `b${index}`, order)),
  );

  expect(burst).toHaveLength(60);
  expect(order.every((entry) => entry.endsWith("@0"))).toBe(true);

  order.length = 0;
  const later = [track(pacer, clock, "x", order), track(pacer, clock, "y", order)];
  await advance(499);
  expect(order).toEqual([]);
  await advance(1);
  expect(order).toEqual(["x@500"]);
  await advance(500);
  expect(order).toEqual(["x@500", "y@1000"]);
  await Promise.all(later);
});

test("response headers replace the seeded limits and lower the remaining allowance", async () => {
  const { clock, advance } = manualClock();
  const pacer = new RequestPacer({ requestsPerMinute: 3000, tokensPerMinute: 4_000_000 }, clock);

  pacer.observe(
    new Headers({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-limit-tokens": "2000000",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-remaining-tokens": "not-a-number",
    }),
  );

  expect(pacer.limits).toEqual({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 });

  const order: Array<string> = [];
  const waiting = track(pacer, clock, "next", order);
  // One request replenishes every 600 ms at 100 a minute.
  await advance(599);
  expect(order).toEqual([]);
  await advance(1);
  expect(order).toEqual(["next@600"]);
  await waiting;
});

test("a rate-limit refusal holds every waiting request for one shared cooldown", async () => {
  const { clock, advance } = manualClock();
  const pacer = new RequestPacer({ requestsPerMinute: 6000, tokensPerMinute: 10_000_000 }, clock);
  const first = await pacer.acquire(1);
  const second = await pacer.acquire(1);

  // Both requests were dispatched before the refusal; only the first refusal adds backoff.
  expect(pacer.refused("rate_limit", first.dispatchedAt)).toBe(2000);
  expect(pacer.refused("rate_limit", second.dispatchedAt)).toBe(2000);

  const order: Array<string> = [];
  const retried = track(pacer, clock, "a", order);
  const peer = track(pacer, clock, "b", order);
  await advance(1999);
  expect(order).toEqual([]);
  await advance(1);
  expect(order).toEqual(["a@2000", "b@2000"]);
  await peer;

  // A request sent after the cooldown began and refused again doubles the backoff.
  expect(pacer.refused("overloaded", (await retried).dispatchedAt)).toBe(4000);
  await advance(4000);

  // An answer to a request sent before the cooldown began proves nothing; a later one resets it.
  pacer.accepted(first.dispatchedAt);
  const stale = await pacer.acquire(1);
  expect(pacer.refused("rate_limit", stale.dispatchedAt)).toBe(8000);
  await advance(8000);
  const recovered = await pacer.acquire(1);
  pacer.accepted(recovered.dispatchedAt);
  await advance(1);
  const later = await pacer.acquire(1);
  expect(pacer.refused("rate_limit", later.dispatchedAt)).toBe(2000);

  // The provider's Retry-After replaces the computed backoff.
  await advance(2000);
  const told = await pacer.acquire(1);
  expect(pacer.refused("rate_limit", told.dispatchedAt, 7000)).toBe(7000);
});

test("an aborted wait leaves the queue and the next request takes its place", async () => {
  const { clock, advance } = manualClock();
  const pacer = new RequestPacer({ requestsPerMinute: 2, tokensPerMinute: 10_000_000 }, clock);
  await pacer.acquire(1);

  const controller = new AbortController();
  const abandoned = pacer.acquire(1, controller.signal);
  const order: Array<string> = [];
  const next = track(pacer, clock, "next", order);

  controller.abort(new Error("cancelled"));
  expect(abandoned).rejects.toThrow("cancelled");
  // Two requests a minute replenish one every 30 s.
  await advance(30_000);
  expect(order).toEqual(["next@30000"]);
  await next;

  const before = new AbortController();
  before.abort(new Error("already cancelled"));
  expect(pacer.acquire(1, before.signal)).rejects.toThrow("already cancelled");
});

test("token reservations wait for capacity and return what the provider did not count", async () => {
  const { clock, advance } = manualClock();
  // 120,000 tokens a minute holds 60,000 at once and replenishes 2,000 a second.
  const pacer = new RequestPacer({ requestsPerMinute: 1000, tokensPerMinute: 120_000 }, clock);
  const large: PacerLease = await pacer.acquire(50_000);

  const order: Array<string> = [];

  const waiting = pacer.acquire(20_000).then((lease) => {
    order.push(`waiting@${clock.now()}`);

    return lease;
  });

  // 10,000 tokens remain, so 20,000 needs five more seconds unless usage comes back lower.
  await advance(1000);
  expect(order).toEqual([]);
  large.settle(30_000);
  await advance(0);
  expect(order).toEqual(["waiting@1000"]);
  await waiting;

  // A request larger than the whole bucket waits for a full bucket instead of forever.
  const oversized = pacer.acquire(500_000).then(() => order.push(`oversized@${clock.now()}`));
  await advance(60_000);
  await oversized;
  expect(order.at(-1)?.startsWith("oversized@")).toBe(true);

  // A refund after a cached receipt restores the request and its tokens.
  const unused = await pacer.acquire(60_000);
  unused.refund();
  const immediate = await pacer.acquire(60_000);
  expect(immediate.dispatchedAt).toBe(clock.now());
});

test("a provider Retry-After is honoured in full from delay-seconds or an HTTP-date", async () => {
  const { clock, advance } = manualClock();
  const pacer = new RequestPacer({ requestsPerMinute: 6000, tokensPerMinute: 10_000_000 }, clock);
  const retryAfter = (value: string) => pacer.retryAfter(new Headers({ "retry-after": value }));

  expect(retryAfter("120")).toBe(120_000);
  expect(retryAfter(new Date(startedAt + 90_000).toUTCString())).toBe(90_000);
  expect(pacer.retryAfter(new Headers())).toBeUndefined();

  // Zero, past and malformed values ask for no wait, so the local backoff applies instead.
  for (const value of ["0", new Date(startedAt - 1000).toUTCString(), "soon", "1.5", "-5"])
    expect(retryAfter(value)).toBeUndefined();

  // Two minutes is twice the local backoff's cap, and no request is released before it ends.
  const refused = await pacer.acquire(1);
  expect(pacer.refused("overloaded", refused.dispatchedAt, retryAfter("120"))).toBe(120_000);

  const order: Array<string> = [];
  const controller = new AbortController();
  const abandoned = pacer.acquire(1, controller.signal);
  const next = track(pacer, clock, "next", order);

  // A cancelled wait leaves the queue during the provider's cooldown.
  controller.abort(new Error("cancelled"));
  expect(abandoned).rejects.toThrow("cancelled");
  await advance(119_999);
  expect(order).toEqual([]);
  await advance(1);
  expect(order).toEqual(["next@120000"]);
  await next;
});

test.each(["0", "soon"])(
  "a refusal with Retry-After %p waits out the local backoff",
  async (value) => {
    const { clock } = manualClock();
    const pacer = new RequestPacer({ requestsPerMinute: 6000, tokensPerMinute: 10_000_000 }, clock);
    const lease = await pacer.acquire(1);

    const requested = pacer.retryAfter(new Headers({ "retry-after": value }));
    expect(pacer.refused("rate_limit", lease.dispatchedAt, requested)).toBe(2000);
  },
);
