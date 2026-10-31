import { Option, Predicate, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";

/** Per-minute request and token allowances a provider enforces for one credential. */
export interface RateLimits {
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
}

/**
 * Limits reported by `x-ratelimit-limit-*` headers on 2026-10-31: the Baseten hackathon key and
 * the Meta team key. Responses carry the same headers, so the first response replaces these.
 */
export const reportedRateLimits = {
  meta: { requestsPerMinute: 3000, tokensPerMinute: 4_000_000 },
  baseten: { requestsPerMinute: 100, tokensPerMinute: 2_000_000 },
} as const satisfies Record<"meta" | "baseten", RateLimits>;

/** Monotonic time and timers; tests supply a manual clock. */
export interface PacerClock {
  readonly now: () => number;
  /** Wall-clock milliseconds since the epoch, read only to convert an HTTP-date Retry-After. */
  readonly wall: () => number;
  /** Run `callback` after `ms` milliseconds; the returned function cancels it. */
  readonly schedule: (callback: () => void, ms: number) => () => void;
  readonly random: () => number;
}

const systemClock: PacerClock = {
  // The WSL and Windows wall clocks have jumped backwards mid-run; pacing needs monotonic time.
  now: () => performance.now(),
  wall: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);

    return () => clearTimeout(timer);
  },
  random: Math.random,
};

/** Capacity held for one request until its usage is known. */
export interface PacerLease {
  /** When the request was released to the provider, on the pacer's clock. */
  readonly dispatchedAt: number;
  /** Replace the reservation with the tokens the provider counted. */
  readonly settle: (usedTokens: number) => void;
  /** Return the reservation when the request was never sent. */
  readonly refund: () => void;
}

/** Why the provider refused a request before generating anything. */
export type Refusal = "rate_limit" | "overloaded";

interface Waiter {
  readonly tokens: number;
  readonly resolve: (lease: PacerLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Limits replenish continuously, so a bucket holds at most half a minute of allowance. Baseten's
 * request limiter reported at most 50 of its 100 requests remaining at any moment.
 */
const burstFraction = 0.5;

/**
 * Shared backoff after a refusal without Retry-After: 2 s doubling to 60 s, with jitter. The cap
 * applies only to this local backoff; a provider's own Retry-After is honoured in full.
 */
const cooldownBaseMs = 2_000;
const cooldownMaxMs = 60_000;

const RateHeader = Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Retry-After is delay-seconds or an HTTP-date (RFC 9110 section 10.2.3). Only the IMF-fixdate form
 * senders must generate is read; an obsolete date form is treated as malformed.
 */
const RetryAfter = Schema.Union([
  Schema.String.check(Schema.isPattern(/^\d{1,9}$/)).pipe(Schema.decodeTo(Schema.FiniteFromString)),
  Schema.String.check(
    Schema.isPattern(
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    ),
  ).pipe(Schema.decodeTo(Schema.DateFromString)),
]);

/** Read one numeric rate-limit header; absent or malformed values are ignored. */
function rateHeader(headers: Headers, name: string) {
  const value = headers.get(name);

  return value === null ? Option.none() : Schema.decodeUnknownOption(RateHeader)(value);
}

/**
 * Paces requests for one provider credential so parallel conversations stay inside its request and
 * token limits, and every conversation waits out a refusal together instead of retrying into it.
 * Requests are released in arrival order. The pacer only delays dispatch; it never alters a request.
 */
export class RequestPacer {
  #limits: RateLimits;
  #requests: number;
  #tokens: number;
  #refilledAt: number;
  #cooldownUntil = 0;
  /** Refusals of requests dispatched before the current cooldown began add no further backoff. */
  #cooldownStartedAt = Number.NEGATIVE_INFINITY;
  #escalation = 0;
  #cancelTimer: (() => void) | undefined;
  readonly #waiters: Array<Waiter> = [];
  readonly #clock: PacerClock;

  /** Start with full buckets for `limits`; response headers refine them. */
  constructor(limits: RateLimits, clock: PacerClock = systemClock) {
    this.#clock = clock;
    this.#limits = limits;
    this.#requests = this.#requestCapacity();
    this.#tokens = this.#tokenCapacity();
    this.#refilledAt = clock.now();
  }

  /** The per-minute limits currently applied. */
  get limits(): RateLimits {
    return this.#limits;
  }

  /** The current time on the pacer's monotonic clock, the clock of every lease's `dispatchedAt`. */
  now() {
    return this.#clock.now();
  }

  /**
   * The wait a response's Retry-After asks for, in milliseconds, from delay-seconds or an HTTP-date
   * on the wall clock. Absent, malformed, zero and past values ask for none, so local backoff applies.
   */
  retryAfter(headers: Headers): number | undefined {
    const requested = Option.map(
      Option.flatMap(
        Option.fromNullishOr(headers.get("retry-after")),
        Schema.decodeUnknownOption(RetryAfter),
      ),
      (value) => (Predicate.isNumber(value) ? value * 1000 : value.getTime() - this.#clock.wall()),
    );

    return Option.getOrUndefined(Option.filter(requested, (ms) => ms > 0));
  }

  /** Wait `ms` on the pacer's clock without holding capacity. Rejects on abort. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);

      const onAbort = () => {
        cancel();
        reject(signal?.reason);
      };

      const cancel = this.#clock.schedule(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Wait until one request and `tokens` estimated tokens fit, then reserve them. A request larger
   * than a full token bucket waits for a full bucket rather than forever. Rejects on abort.
   */
  acquire(tokens: number, signal?: AbortSignal): Promise<PacerLease> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);

      const waiter: Waiter = {
        tokens: Math.max(0, tokens),
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);

          if (index === -1) return;
          this.#waiters.splice(index, 1);
          reject(signal?.reason);
          this.#pump();
        },
      };

      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  /** Learn the credential's limits and current allowance from a response's rate-limit headers. */
  observe(headers: Headers) {
    this.#refill();
    const requests = rateHeader(headers, "x-ratelimit-limit-requests");
    const tokens = rateHeader(headers, "x-ratelimit-limit-tokens");

    this.#limits = {
      requestsPerMinute: Option.getOrElse(
        Option.filter(requests, (value) => value > 0),
        () => this.#limits.requestsPerMinute,
      ),
      tokensPerMinute: Option.getOrElse(
        Option.filter(tokens, (value) => value > 0),
        () => this.#limits.tokensPerMinute,
      ),
    };

    // A lower reported remainder means other traffic on the key, or another limiter shard, has
    // used allowance this process did not count.
    this.#requests = Math.min(
      this.#requestCapacity(),
      Option.match(rateHeader(headers, "x-ratelimit-remaining-requests"), {
        onNone: () => this.#requests,
        onSome: (remaining) => Math.min(this.#requests, remaining),
      }),
    );

    this.#tokens = Math.min(
      this.#tokenCapacity(),
      Option.match(rateHeader(headers, "x-ratelimit-remaining-tokens"), {
        onNone: () => this.#tokens,
        onSome: (remaining) => Math.min(this.#tokens, remaining),
      }),
    );
    this.#pump();
  }

  /**
   * Hold every waiting request after a refusal. `retryAfterMs` comes from the provider when it
   * sends one and is honoured in full; otherwise the shared backoff doubles only for refusals of
   * requests dispatched after the previous cooldown began. Returns the remaining cooldown.
   */
  refused(refusal: Refusal, dispatchedAt: number, retryAfterMs?: number) {
    const now = this.#clock.now();

    if (dispatchedAt > this.#cooldownStartedAt) {
      this.#escalation++;
      this.#cooldownStartedAt = now;
    }

    // A capacity refusal says nothing about this credential's own request allowance.
    if (refusal === "rate_limit") this.#requests = Math.min(this.#requests, 0);

    const backoff = Math.min(cooldownMaxMs, cooldownBaseMs * 2 ** (this.#escalation - 1));

    const delay =
      retryAfterMs === undefined
        ? backoff / 2 + this.#clock.random() * (backoff / 2)
        : retryAfterMs;

    this.#cooldownUntil = Math.max(this.#cooldownUntil, now + delay);
    this.#pump();

    return this.#cooldownUntil - now;
  }

  /** A request dispatched after the latest cooldown began was accepted, so backoff resets. */
  accepted(dispatchedAt: number) {
    if (dispatchedAt > this.#cooldownStartedAt) this.#escalation = 0;
  }

  #requestCapacity() {
    return Math.max(1, this.#limits.requestsPerMinute * burstFraction);
  }

  #tokenCapacity() {
    return Math.max(1, this.#limits.tokensPerMinute * burstFraction);
  }

  #refill() {
    const now = this.#clock.now();
    const elapsed = Math.max(0, now - this.#refilledAt);
    this.#refilledAt = now;

    this.#requests = Math.min(
      this.#requestCapacity(),
      this.#requests + (elapsed * this.#limits.requestsPerMinute) / 60_000,
    );

    this.#tokens = Math.min(
      this.#tokenCapacity(),
      this.#tokens + (elapsed * this.#limits.tokensPerMinute) / 60_000,
    );
  }

  /** Milliseconds until `tokens` and one request fit and any cooldown has passed. */
  #delay(tokens: number) {
    const needed = Math.min(tokens, this.#tokenCapacity());

    return Math.max(
      0,
      this.#cooldownUntil - this.#clock.now(),
      this.#requests >= 1 ? 0 : ((1 - this.#requests) * 60_000) / this.#limits.requestsPerMinute,
      this.#tokens >= needed
        ? 0
        : ((needed - this.#tokens) * 60_000) / this.#limits.tokensPerMinute,
    );
  }

  /** Release waiters in order while capacity allows, then wake when the next one fits. */
  #pump() {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#refill();

    for (let head = this.#waiters[0]; head !== undefined; head = this.#waiters[0]) {
      const delay = this.#delay(head.tokens);

      if (delay > 0) {
        this.#cancelTimer = this.#clock.schedule(() => this.#pump(), Math.ceil(delay));

        return;
      }

      this.#waiters.shift();
      head.signal?.removeEventListener("abort", head.onAbort);
      const reserved = Math.min(head.tokens, this.#tokenCapacity());
      this.#requests -= 1;
      this.#tokens -= reserved;
      let open = true;

      head.resolve({
        dispatchedAt: this.#clock.now(),
        settle: (usedTokens) => {
          if (!open) return;
          open = false;
          this.#refill();
          this.#tokens = Math.min(this.#tokenCapacity(), this.#tokens + reserved - usedTokens);
          this.#pump();
        },
        refund: () => {
          if (!open) return;
          open = false;
          this.#refill();
          this.#requests = Math.min(this.#requestCapacity(), this.#requests + 1);
          this.#tokens = Math.min(this.#tokenCapacity(), this.#tokens + reserved);
          this.#pump();
        },
      });
    }
  }
}

const shared = new Map<string, RequestPacer>();

/**
 * One pacer per provider credential in this process, so every review, sheet reviewer and count
 * check on the same key shares its limits. The key is identified by a digest, never stored.
 */
export function sharedPacer(provider: "meta" | "baseten", apiKey: Redacted.Redacted<string>) {
  const id = `${provider}:${createHash("sha256").update(Redacted.value(apiKey)).digest("hex").slice(0, 32)}`;
  const known = shared.get(id);

  if (known !== undefined) return known;
  const pacer = new RequestPacer(reportedRateLimits[provider]);
  shared.set(id, pacer);

  return pacer;
}
