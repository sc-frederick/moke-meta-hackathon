import { expect, test } from "bun:test";
import { Deferred, Effect, Layer, ManagedRuntime, PubSub, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import { CloudReviewError, StartCloudReview } from "#lib/review/cloud.ts";
import { cloudEngineIdentity } from "../../backend/cloud/contracts.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import { CloudReviewSynchronization } from "../../backend/cloud/sync.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";

async function fixture(dropSignals = false) {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-sync-"));
  const signals = Effect.runSync(PubSub.unbounded<void>({ replay: 1 }));
  const restored = Effect.runSync(Deferred.make<void>());
  const releaseReturn = Effect.runSync(Deferred.make<void>());
  const operations: string[] = [];
  let ready = false;
  let downloadLost = false;
  let invalid = false;
  let holdReturn = false;

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => (dropSignals ? Stream.never : Stream.fromPubSub(signals)),
    allocate: () => Effect.succeed("sandbox-sync"),
    upload: () => Effect.succeed("source-snapshot"),
    dispatch: () =>
      Effect.sync(() => {
        operations.push("dispatch");
      }),
    progress: (record) =>
      Effect.sync(() => ({
        progress: {
          id: record.id,
          identity: cloudEngineIdentity,
          phase: ready ? ("ready" as const) : ("running" as const),
          execution: null,
          message: ready ? "Ready" : "Running",
        },
        resultSnapshotId: ready ? "result-snapshot" : null,
        sourceStopped: false,
      })),
    download: () =>
      Effect.suspend(() => {
        operations.push("download");

        return downloadLost
          ? Effect.fail(new CloudReviewError({ reason: "unavailable", message: "Offline" }))
          : Effect.void;
      }),
    stop: () =>
      Effect.sync(() => {
        operations.push("stop");
      }),
  };

  const modal = Schema.decodeUnknownSync(ModalConfiguration)({
    tokenId: "test",
    tokenSecret: "test",
    appName: "test",
    environment: "main",
    imageName: "test",
    timeoutMinutes: 15,
    poolQueue: null,
  });

  const provider = Schema.decodeUnknownSync(InferenceConfiguration)({
    provider: "meta",
    apiKey: "test",
    baseUrl: "https://api.meta.ai/v1",
    model: "muse-spark-1.3",
  });

  const open = (sync = true) => {
    const cloud = CloudReviews.layer({
      directory,
      modal,
      provider,
      inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
      prepare: () => Effect.void,
      restorePending: () => false,
      restore: () =>
        Effect.suspend(() => {
          operations.push("restore");

          return invalid
            ? Effect.fail(
                new CloudReviewError({ reason: "incompatible", message: "Package hash mismatch" }),
              )
            : Deferred.succeed(restored, undefined).pipe(Effect.asVoid);
        }),
    }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port)));

    const synchronization = Layer.unwrap(
      Effect.map(CloudReviews, (reviews) =>
        CloudReviewSynchronization.layer((id) =>
          reviews
            .importResults(id)
            .pipe(Effect.tap(() => (holdReturn ? Deferred.await(releaseReturn) : Effect.void))),
        ),
      ),
    ).pipe(Layer.provideMerge(cloud));

    const services = sync
      ? synchronization
      : Layer.merge(
          cloud,
          Layer.succeed(CloudReviewSynchronization, { observe: Stream.empty, retry: Effect.void }),
        );

    return ManagedRuntime.make(services.pipe(Layer.provideMerge(TestClock.layer())));
  };

  const request = Schema.decodeUnknownSync(StartCloudReview)({
    commandId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    findingId: crypto.randomUUID(),
    transferScope: "whole-application",
    budget: { maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 },
  });

  return {
    open,
    operations,
    request,
    restored,
    holdReturn: () => {
      holdReturn = true;
    },
    releaseReturn: () => Effect.runPromise(Deferred.succeed(releaseReturn, undefined)),
    ready: (value: boolean) => {
      ready = value;
    },
    downloadLost: (value: boolean) => {
      downloadLost = value;
    },
    invalid: (value: boolean) => {
      invalid = value;
    },
    signal: () => Effect.runPromise(PubSub.publish(signals, undefined)),
    dispose: async () => {
      await Effect.runPromise(PubSub.shutdown(signals));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const phase = (sync: CloudReviewSynchronization["Service"], expected: string) =>
  sync.observe.pipe(
    Stream.filter((update) => update.status?.phase === expected),
    Stream.take(1),
    Stream.runDrain,
  );

const syncError = (sync: CloudReviewSynchronization["Service"]) =>
  sync.observe.pipe(
    Stream.filter((update) => update.error !== null),
    Stream.take(1),
    Stream.runCollect,
  );

test("native change hints automatically return results once without any open renderer", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const sync = await runtime.runPromise(CloudReviewSynchronization);
    await runtime.runPromise(cloud.start(session.request));
    await runtime.runPromise(phase(sync, "running"));
    session.ready(true);
    await session.signal();
    await runtime.runPromise(Deferred.await(session.restored));
    await runtime.runPromise(phase(sync, "imported"));

    const observerA = await runtime.runPromise(
      sync.observe.pipe(Stream.take(1), Stream.runCollect),
    );

    const observerB = await runtime.runPromise(
      sync.observe.pipe(Stream.take(1), Stream.runCollect),
    );

    expect(observerA[0]?.status?.phase).toBe("imported");
    expect(observerB[0]?.status?.phase).toBe("imported");
    expect(session.operations).toEqual(["dispatch", "download", "stop", "restore"]);
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("a completed-offline durable job automatically returns on backend reopen without another dispatch", async () => {
  const session = await fixture();
  let runtime = session.open(false);

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const started = await runtime.runPromise(cloud.start(session.request));
    session.ready(true);
    await runtime.runPromise(cloud.refresh(started.id));
    await runtime.dispose();
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    await runtime.runPromise(Deferred.await(session.restored));
    const sync = await runtime.runPromise(CloudReviewSynchronization);
    await runtime.runPromise(phase(sync, "imported"));
    await runtime.runPromise(cloud.assertLocal);
    expect(session.operations).toEqual(["dispatch", "download", "stop", "restore"]);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("periodic reconciliation covers a lost change signal and retries an interrupted download without replay", async () => {
  const session = await fixture(true);
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const sync = await runtime.runPromise(CloudReviewSynchronization);
    await runtime.runPromise(cloud.start(session.request));
    await runtime.runPromise(phase(sync, "running"));
    session.ready(true);
    session.downloadLost(true);
    await runtime.runPromise(TestClock.adjust("10 seconds"));
    expect((await runtime.runPromise(syncError(sync)))[0]?.error?.reason).toBe("unavailable");
    await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip));
    session.downloadLost(false);
    await runtime.runPromise(TestClock.adjust("10 seconds"));
    await runtime.runPromise(phase(sync, "imported"));
    expect(session.operations).toEqual(["dispatch", "download", "download", "stop", "restore"]);
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("invalid results stay fenced without a redownload loop until sync is explicitly retried", async () => {
  const session = await fixture();
  let runtime = session.open();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    let sync = await runtime.runPromise(CloudReviewSynchronization);
    await runtime.runPromise(cloud.start(session.request));
    await runtime.runPromise(phase(sync, "running"));
    session.ready(true);
    session.invalid(true);
    await session.signal();
    expect((await runtime.runPromise(syncError(sync)))[0]?.error?.reason).toBe("incompatible");
    await runtime.dispose();
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    sync = await runtime.runPromise(CloudReviewSynchronization);
    expect((await runtime.runPromise(syncError(sync)))[0]?.error?.reason).toBe("incompatible");
    expect((await runtime.runPromise(cloud.status))?.syncFailure?.reason).toBe("incompatible");
    await runtime.runPromise(TestClock.adjust("1 minute"));
    expect(session.operations.filter((operation) => operation === "download")).toHaveLength(1);
    await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip));
    session.invalid(false);
    await runtime.runPromise(sync.retry);
    await runtime.runPromise(phase(sync, "imported"));
    expect(session.operations.filter((operation) => operation === "dispatch")).toHaveLength(1);
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("the synced notification waits until the application has finished returning results", async () => {
  const session = await fixture();
  session.holdReturn();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const sync = await runtime.runPromise(CloudReviewSynchronization);
    await runtime.runPromise(cloud.start(session.request));
    await runtime.runPromise(phase(sync, "running"));
    session.ready(true);
    await session.signal();
    await runtime.runPromise(
      cloud.observe.pipe(
        Stream.filter((status) => status?.phase === "imported"),
        Stream.take(1),
        Stream.runDrain,
      ),
    );

    const duringMaintenance = await runtime.runPromise(
      sync.observe.pipe(Stream.take(1), Stream.runCollect),
    );

    expect(duringMaintenance[0]?.status?.phase).not.toBe("imported");
    await session.releaseReturn();
    await runtime.runPromise(phase(sync, "imported"));
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await session.releaseReturn();
    await runtime.dispose();
    await session.dispose();
  }
});
