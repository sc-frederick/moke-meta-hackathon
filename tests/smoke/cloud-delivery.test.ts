import { expect, test } from "bun:test";
import { Deferred, Effect, Match, Schema } from "effect";
import { CloudReviewStatus } from "#lib/review/cloud.ts";
import {
  createCloudResultDelivery,
  createCloudReturnHydration,
  type CloudReturnSelection,
} from "#lib/review/cloud-delivery.ts";
import { ExecutionStatus } from "#lib/review/execution.ts";

const receipt = () =>
  Schema.decodeUnknownSync(CloudReviewStatus)({
    id: crypto.randomUUID(),
    revision: 4,
    projectId: crypto.randomUUID(),
    findingId: crypto.randomUUID(),
    phase: "imported",
    createdAt: 0,
    expiresAt: 60_000,
    execution: null,
    message: "Results synced",
  });

test("a failed local snapshot is retried on the same terminal receipt and deduplicated only after application", async () => {
  let snapshot = "old";
  let available = false;
  let attempts = 0;

  const deliver = createCloudResultDelivery(async () => {
    attempts++;

    if (!available) return false;
    snapshot = "returned results";

    return true;
  });

  const status = receipt();
  expect(await deliver(status)).toBe(false);
  expect(await deliver(status)).toBe(false);
  expect(snapshot).toBe("old");
  available = true;
  expect(await deliver(status)).toBe(true);
  expect(snapshot).toBe("returned results");
  expect(await deliver(status)).toBe(true);
  expect(attempts).toBe(3);
});

test("concurrent copies of a terminal receipt share one pending snapshot refresh", async () => {
  const complete = Effect.runSync(Deferred.make<boolean>());
  let attempts = 0;

  const deliver = createCloudResultDelivery(() => {
    attempts++;

    return Effect.runPromise(Deferred.await(complete));
  });

  const status = receipt();
  const first = deliver(status);
  const second = deliver(status);
  expect(first).toBe(second);
  expect(attempts).toBe(1);
  await Effect.runPromise(Deferred.succeed(complete, true));
  expect(await first).toBe(true);
  expect(await deliver(status)).toBe(true);
  expect(attempts).toBe(1);
});

test.each(["check", "project", "receipt"] as const)(
  "a delayed cloud status is rejected after the selected %s changes",
  async (change) => {
    const original = receipt();

    const execution = Schema.decodeUnknownSync(ExecutionStatus)({
      runId: crypto.randomUUID(),
      projectId: original.projectId,
      findingId: original.findingId,
      state: "completed",
      version: 2,
      route: "live",
      provider: "meta",
      model: "muse-spark-1.3",
      admittedCalls: 1,
      reservedInputTokens: 1000,
      reservedOutputTokens: 256,
      unresolvedAttempts: 0,
      uncertaintyAcknowledged: false,
      costUsd: null,
      imageInputTokens: null,
    });

    const returning = Schema.decodeUnknownSync(CloudReviewStatus)({
      ...Schema.encodeSync(CloudReviewStatus)(original),
      execution: Schema.encodeSync(ExecutionStatus)(execution),
    });

    let selected: CloudReturnSelection = {
      projectId: returning.projectId,
      findingId: returning.findingId,
      receipt: returning,
    };

    const requested = Effect.runSync(Deferred.make<void>());
    const response = Effect.runSync(Deferred.make<ExecutionStatus>());
    const applied: Array<ExecutionStatus> = [];
    let requests = 0;

    const hydrate = createCloudReturnHydration({
      selection: () => selected,
      refreshSnapshot: async () => true,
      loadExecution: async () => {
        requests++;
        await Effect.runPromise(Deferred.succeed(requested, undefined));

        return { ok: true, value: await Effect.runPromise(Deferred.await(response)) };
      },
      applyExecution: (status) => {
        if (status !== null) applied.push(status);
      },
      reportError: () => {
        throw new Error("Unexpected hydration error");
      },
    });

    const deliver = createCloudResultDelivery(hydrate);
    const first = deliver(returning);
    await Effect.runPromise(Deferred.await(requested));
    selected = Match.value(change).pipe(
      Match.when("check", () => ({ ...selected, findingId: crypto.randomUUID() })),
      Match.when("project", () => ({
        ...selected,
        projectId: crypto.randomUUID(),
        findingId: null,
      })),
      Match.when("receipt", () => ({
        ...selected,
        receipt: Schema.decodeUnknownSync(CloudReviewStatus)({
          ...Schema.encodeSync(CloudReviewStatus)(returning),
          id: crypto.randomUUID(),
          revision: returning.revision + 1,
        }),
      })),
      Match.exhaustive,
    );
    await Effect.runPromise(Deferred.succeed(response, execution));
    expect(await first).toBe(false);
    expect(applied).toHaveLength(0);
    expect(requests).toBe(1);

    if (change !== "receipt") {
      expect(await deliver(returning)).toBe(true);
      expect(applied).toHaveLength(0);
      expect(requests).toBe(1);
    }
  },
);
