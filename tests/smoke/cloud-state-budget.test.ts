import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { cloudEngineIdentity, type CloudReviewRecord } from "../../backend/cloud/contracts.ts";
import {
  cloudReceiptReserveBytes,
  cloudStateBytes,
  cloudStateMaxBytes,
  readCloudState,
  writeCloudFile,
  writeCloudState,
} from "../../backend/cloud/files.ts";
import {
  cloudWorkerProgressMaxBytes,
  parseCloudWorkerProgress,
} from "../../backend/cloud/progress.ts";
import { cloudRecord, packetRequest } from "../fixtures/cloud-records.ts";

const modal = Schema.decodeUnknownSync(ModalConfiguration)({
  tokenId: "test-token-id",
  tokenSecret: "test-modal-secret",
  appName: "test",
  environment: "main",
  imageName: "test:one",
  timeoutMinutes: 15,
  poolQueue: null,
});

const provider = Schema.decodeUnknownSync(InferenceConfiguration)({
  provider: "meta",
  apiKey: "test-model-secret",
  baseUrl: "https://api.meta.ai/v1",
  model: "muse-spark-1.3",
});

/** Terminal receipts as earlier builds saved them: raw request fingerprints and full sheet lists. */
const history = (count: number, sheets: number) =>
  Array.from({ length: count }, (_, index) =>
    cloudRecord(packetRequest(sheets), "imported", index + 1),
  );

const legacyState = (jobs: ReadonlyArray<CloudReviewRecord>) =>
  JSON.stringify({ version: 1, jobs });

/** A local cloud port that records sandbox calls and reports packet progress of a chosen size. */
const session = (directory: string) => {
  const operations: Array<string> = [];
  let projectName = "Project";

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => Stream.never,
    allocate: () => Effect.sync(() => (operations.push("allocate"), "sandbox-one")),
    upload: (_record, _source, report) =>
      Effect.gen(function* () {
        operations.push("upload");
        yield* report({
          direction: "upload",
          completedBytes: 10,
          totalBytes: 10,
          completedFiles: 1,
          totalFiles: 1,
        });

        return "source-checkpoint";
      }),
    dispatch: () => Effect.sync(() => void operations.push("dispatch")),
    progress: (record) =>
      Effect.gen(function* () {
        operations.push("progress");

        if (!("kind" in record.request)) return yield* Effect.die("Packet requests only.");

        const progress = yield* parseCloudWorkerProgress(
          record,
          JSON.stringify({
            id: record.id,
            identity: cloudEngineIdentity,
            phase: "running",
            execution: null,
            packet: {
              id: crypto.randomUUID(),
              projectId: record.request.projectId,
              conversationId: record.request.conversationId,
              model: record.request.model,
              state: "running",
              version: 1,
              admittedCalls: 1,
              projectName,
            },
            message: "Running",
          }),
        );

        return { progress, resultSnapshotId: null, sourceStopped: false };
      }),
    download: () => Effect.void,
    stop: () => Effect.void,
    seedCache: () => Effect.succeed([]),
  };

  const open = () =>
    ManagedRuntime.make(
      CloudReviews.layer({
        directory,
        modal,
        provider,
        inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
        prepare: () => Effect.void,
        restorePending: () => false,
        restore: () => Effect.void,
      }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port))),
    );

  return {
    open,
    operations,
    progressName: (name: string) => {
      projectName = name;
    },
  };
};

test("the cloud writer refuses state its reader would reject and keeps the previous state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-budget-"));
  const path = join(directory, "state.json");

  try {
    const previous = history(1, 200);
    await Effect.runPromise(writeCloudState(path, previous));

    // 500 terminal receipts of 200 selected sheets each, written whole, exceeded the reader's limit.
    const grown = history(500, 200);
    expect(cloudStateBytes(grown)).toBeGreaterThan(cloudStateMaxBytes);

    const refused = await Effect.runPromise(writeCloudState(path, grown).pipe(Effect.flip));
    expect(refused.reason).toBe("limit");

    const read = await Effect.runPromise(readCloudState(path));
    expect(read.map((job) => job.id)).toEqual(previous.map((job) => job.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized earlier state reopens compacted with its owner and command replay intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-budget-"));
  const path = join(directory, "state.json");
  const terminal = history(500, 200);
  const active = cloudRecord(packetRequest(200), "running", 501);
  await Effect.runPromise(writeCloudFile(path, legacyState([...terminal, active])));
  expect((await stat(path)).size).toBeGreaterThan(cloudStateMaxBytes);

  const cloud = session(directory);
  const runtime = cloud.open();

  try {
    const service = await runtime.runPromise(CloudReviews);
    expect((await stat(path)).size).toBeLessThan(cloudStateMaxBytes);
    expect((await runtime.runPromise(service.assertLocal.pipe(Effect.flip))).reason).toBe(
      "conflict",
    );

    const saved = await Effect.runPromise(readCloudState(path));
    expect(saved).toHaveLength(501);
    const owner = saved.find((job) => job.id === active.id);
    expect(owner?.phase).toBe("running");
    expect(owner?.request).toEqual(active.request);

    // An old command identity replays its receipt; a changed request under it still conflicts.
    const replay = terminal[123];

    if (replay === undefined) throw new Error("Missing receipt");
    const replayed = await runtime.runPromise(service.start(replay.request));
    expect(replayed.id).toBe(replay.id);
    expect(replayed.phase).toBe("imported");

    const changed = await runtime.runPromise(
      service.start({ ...replay.request, maxCalls: 3 }).pipe(Effect.flip),
    );

    expect(changed.reason).toBe("conflict");
    expect(cloud.operations).toEqual([]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("admission keeps room for an owner's progress and refuses before any cloud action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-budget-"));
  const path = join(directory, "state.json");
  await Effect.runPromise(writeCloudFile(path, legacyState(history(998, 200))));

  const cloud = session(directory);
  let runtime = cloud.open();

  try {
    let service = await runtime.runPromise(CloudReviews);
    const before = await readFile(path, "utf8");

    // Compact terminal receipts leave most of the budget; one request may use what remains.
    const room = cloudStateMaxBytes - Buffer.byteLength(before) - cloudReceiptReserveBytes;
    expect(room).toBeGreaterThan(cloudStateMaxBytes / 2);
    const sheetBytes = Buffer.byteLength(JSON.stringify(crypto.randomUUID())) + 1;
    const fitting = packetRequest(Math.floor((room - 1024) / sheetBytes));

    const refused = await runtime.runPromise(
      service.start(packetRequest(Math.ceil(room / sheetBytes) + 10)).pipe(Effect.flip),
    );

    expect(refused.reason).toBe("limit");
    expect(cloud.operations).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(before);

    const started = await runtime.runPromise(service.start(fitting));
    expect(started.phase).toBe("dispatching");
    expect(cloud.operations).toEqual(["allocate", "upload", "dispatch"]);

    // The largest progress the worker may report still fits beside the owner's receipt.
    cloud.progressName("p".repeat(cloudWorkerProgressMaxBytes - 2048));
    expect((await runtime.runPromise(service.refresh(started.id))).phase).toBe("running");
    expect((await stat(path)).size).toBeLessThanOrEqual(cloudStateMaxBytes);

    await runtime.dispose();
    runtime = cloud.open();
    service = await runtime.runPromise(CloudReviews);
    expect((await runtime.runPromise(service.status))?.id).toBe(started.id);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
