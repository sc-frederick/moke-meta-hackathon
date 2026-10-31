import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudReviewError,
  CloudReviewStatus,
  StartCloudReview,
  latestCloudReviewStatus,
} from "#lib/review/cloud.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import {
  cloudEngineIdentity,
  CloudWorkerProgress,
  CloudWorkerRequest,
  WarmSandboxMessage,
  type CloudReviewRecord,
} from "../../backend/cloud/contracts.ts";
import {
  clearInterruptedCloudDownloads,
  downloadedCloudFileMatches,
  parseCloudManifest,
} from "../../backend/cloud/transfer.ts";
import { PackageManifest } from "#lib/review/packages.ts";
import { NotFoundError } from "modal";
import { confirmModalSandboxStopped, pollWarmSandbox } from "../../backend/cloud/modal.ts";
import { parseCloudWorkerProgress } from "../../backend/cloud/progress.ts";
import { readCloudState } from "../../backend/cloud/files.ts";

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

test("cloud download retries reuse only complete files matching the result identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-resume-"));
  const path = join(directory, "artifact.png");
  const content = Buffer.from("verified result bytes");

  const expected = {
    path: "artifacts/artifact.png",
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };

  try {
    expect(await Effect.runPromise(downloadedCloudFileMatches(path, expected))).toBe(false);
    await writeFile(path, content.subarray(0, 4));
    expect(await Effect.runPromise(downloadedCloudFileMatches(path, expected))).toBe(false);
    await writeFile(path, Buffer.alloc(content.length));
    expect(await Effect.runPromise(downloadedCloudFileMatches(path, expected))).toBe(false);
    await writeFile(path, content);
    expect(await Effect.runPromise(downloadedCloudFileMatches(path, expected))).toBe(true);
    const scratch = join(directory, ".modal-sandbox-fs-tmp-0123456789abcdef");
    const other = join(directory, "unexpected-file");

    await writeFile(scratch, "interrupted copy");
    await writeFile(other, "must remain for package validation to reject");
    await Effect.runPromise(clearInterruptedCloudDownloads(directory));
    expect(await Bun.file(scratch).exists()).toBe(false);
    expect(await readFile(other, "utf8")).toContain("must remain");
    expect(await Effect.runPromise(downloadedCloudFileMatches(path, expected))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const request = () =>
  Schema.decodeUnknownSync(StartCloudReview)({
    commandId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    findingId: crypto.randomUUID(),
    transferScope: "whole-application",
    budget: { maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 },
  });

const fail = () =>
  new CloudReviewError({ reason: "unavailable", message: "Simulated lost response" });

test("missing warm sandboxes permit fallback while permission and transport failures fail closed", async () => {
  const grpc = (code: number) =>
    Object.assign(new Error("Offline SDK failure"), { name: "ClientError", code });

  for (const error of [new NotFoundError("Missing candidate"), grpc(5)])
    expect(await Effect.runPromise(pollWarmSandbox(() => Promise.reject(error)))).toBe(false);

  for (const error of [grpc(7), grpc(14), new Error("Unknown failure")])
    expect(
      (await Effect.runPromise(pollWarmSandbox(() => Promise.reject(error)).pipe(Effect.flip)))
        .reason,
    ).toBe("unavailable");

  expect(await Effect.runPromise(pollWarmSandbox(() => Promise.resolve(null)))).toBe(true);
  expect(await Effect.runPromise(pollWarmSandbox(() => Promise.resolve(137)))).toBe(false);
});

test("warm queue messages preserve millisecond deadlines as JSON instead of SDK integers", () => {
  const expiresAt = 1_793_232_123_456;

  const encoded = Schema.encodeSync(WarmSandboxMessage)({
    sandboxId: "sandbox-warm",
    imageName: "test:one",
    identity: cloudEngineIdentity,
    expiresAt,
  });

  expect(encoded).toContain('"expiresAt":1793232123456');
  expect(Schema.decodeUnknownSync(WarmSandboxMessage)(encoded).expiresAt).toBe(expiresAt);
});

test("the cloud worker protocol rejects pre-scope workers and incompatible deadline precision", () => {
  const job = {
    id: crypto.randomUUID(),
    identity: cloudEngineIdentity,
    request: request(),
    timeoutMs: 61_000,
  };

  expect(Schema.is(CloudWorkerRequest)(job)).toBe(true);
  expect(
    Schema.is(CloudWorkerRequest)({ ...job, identity: { ...cloudEngineIdentity, protocol: 2 } }),
  ).toBe(false);
  expect(
    Schema.is(CloudWorkerRequest)({
      ...job,
      identity: { ...cloudEngineIdentity, packetPrompt: "moke-packet-review-v3" },
    }),
  ).toBe(false);
  expect(Schema.is(CloudWorkerRequest)({ ...job, timeoutMs: 61_001 })).toBe(false);
  expect(Schema.is(CloudWorkerRequest)({ ...job, timeoutMs: 59_000 })).toBe(false);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-test-"));
  const operations: string[] = [];
  let dispatchLost = false;
  let preflightFailure = false;
  let stopLost = false;
  let stopMissing: Error | null = null;
  let restoreLost = false;
  let checkpointReady = true;
  let wrongIdentity = false;
  let changed = false;
  let restorePending = false;
  let progressPhase: "ready" | "running" | "failed" = "ready";
  let sourceStopped = false;
  let last: CloudReviewRecord | null = null;

  const port: CloudSandboxPort = {
    preflight: () =>
      preflightFailure
        ? Effect.fail(
            new CloudReviewError({
              reason: "configuration",
              message:
                "The cloud provider secret is missing. Your workspace has not been uploaded.",
            }),
          )
        : Effect.void,
    changes: () => Stream.never,
    allocate: (record) =>
      Effect.sync(() => {
        last = record;
        operations.push("allocate");

        return "sandbox-one";
      }),
    upload: () =>
      Effect.sync(() => {
        operations.push("upload");

        return "source-checkpoint";
      }),
    dispatch: () =>
      Effect.suspend(() => {
        operations.push("dispatch");

        return dispatchLost ? Effect.fail(fail()) : Effect.void;
      }),
    progress: (record) =>
      Effect.gen(function* () {
        operations.push("progress");

        const progress = yield* parseCloudWorkerProgress(
          record,
          JSON.stringify({
            id: wrongIdentity ? crypto.randomUUID() : record.id,
            identity: cloudEngineIdentity,
            phase: progressPhase,
            execution: null,
            message: "Ready",
          }),
        );

        return {
          progress,
          resultSnapshotId: checkpointReady ? "result-checkpoint" : null,
          sourceStopped,
        };
      }),
    download: () =>
      Effect.sync(() => {
        operations.push("download");
      }),
    stop: () =>
      Effect.suspend(() => {
        operations.push("stop");

        if (stopLost) return Effect.fail(fail());

        return stopMissing === null
          ? Effect.void
          : confirmModalSandboxStopped(() => Promise.reject(stopMissing));
      }),
    seedCache: () => Effect.succeed([]),
  };

  const open = () =>
    ManagedRuntime.make(
      CloudReviews.layer({
        directory,
        modal,
        provider,
        inspect: () =>
          Effect.succeed({ sourceVersion: changed ? 1 : 0, factVersion: 0, projectVersion: 0 }),
        prepare: () => Effect.void,
        restorePending: () => restorePending,
        restore: () =>
          Effect.suspend(() => {
            operations.push("restore");

            return restoreLost ? Effect.fail(fail()) : Effect.void;
          }),
      }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port))),
    );

  return {
    directory,
    open,
    operations,
    last: () => last,
    change: () => {
      changed = true;
    },
    progress: (phase: typeof progressPhase, stopped: boolean) => {
      progressPhase = phase;
      sourceStopped = stopped;
    },
    restorePending: (value: boolean) => {
      restorePending = value;
    },
    failPreflight: (value: boolean) => {
      preflightFailure = value;
    },
    loseDispatch: () => {
      dispatchLost = true;
    },
    stopLost: (value: boolean) => {
      stopLost = value;
    },
    stopMissing: (error: Error) => {
      stopMissing = error;
    },
    restoreLost: (value: boolean) => {
      restoreLost = value;
    },
    checkpointReady: (value: boolean) => {
      checkpointReady = value;
    },
    wrongIdentity: () => {
      wrongIdentity = true;
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test("cloud intents fence local work across restart, deduplicate dispatch, and stop before import", async () => {
  const session = await fixture();
  let runtime = session.open();
  const input = request();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const started = await runtime.runPromise(cloud.start(input));
    expect(started.phase).toBe("dispatching");
    expect((await runtime.runPromise(cloud.start(input))).id).toBe(started.id);
    expect(session.operations).toEqual(["allocate", "upload", "dispatch"]);
    expect(await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip))).toBeInstanceOf(
      CloudReviewError,
    );
    expect(
      (
        await runtime.runPromise(
          cloud.start({ ...input, findingId: request().findingId }).pipe(Effect.flip),
        )
      ).reason,
    ).toBe("conflict");
    const persisted = await readFile(join(session.directory, "state.json"), "utf8");
    expect(persisted).toContain("source-checkpoint");
    expect(persisted).not.toContain("test-modal-secret");
    expect(persisted).not.toContain("test-model-secret");

    await runtime.dispose();
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    expect((await runtime.runPromise(cloud.status))?.id).toBe(started.id);
    expect(await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip))).toBeInstanceOf(
      CloudReviewError,
    );
    expect((await runtime.runPromise(cloud.refresh(started.id))).phase).toBe("ready");
    const imported = await runtime.runPromise(cloud.importResults(started.id));
    expect(imported.phase).toBe("imported");
    expect(imported.revision).toBeGreaterThan(started.revision);
    expect(latestCloudReviewStatus(imported, started)).toBe(imported);
    expect(latestCloudReviewStatus(imported, null)).toBe(imported);

    const newJob = Schema.decodeUnknownSync(CloudReviewStatus)({
      ...Schema.encodeSync(CloudReviewStatus)(imported),
      id: crypto.randomUUID(),
      revision: imported.revision + 1,
      createdAt: started.createdAt - 60_000,
    });

    expect(latestCloudReviewStatus(imported, newJob)).toBe(newJob);
    expect(latestCloudReviewStatus(newJob, imported)).toBe(newJob);
    await runtime.runPromise(cloud.assertLocal);
    await runtime.runPromise(cloud.importResults(started.id));
    expect(session.operations).toEqual([
      "allocate",
      "upload",
      "dispatch",
      "progress",
      "download",
      "stop",
      "restore",
    ]);
    expect((await runtime.runPromise(cloud.start(input))).phase).toBe("imported");
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("an ambiguous dispatch never replays and a failed stop never unlocks local work", async () => {
  const session = await fixture();
  session.loseDispatch();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const input = request();
    await runtime.runPromise(cloud.start(input).pipe(Effect.flip));
    const retried = await runtime.runPromise(cloud.start(input));
    expect(retried.phase).toBe("dispatching");
    expect(session.operations.filter((operation) => operation === "dispatch")).toHaveLength(1);
    session.stopLost(true);
    await runtime.runPromise(cloud.cancel(retried.id).pipe(Effect.flip));
    expect(await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip))).toBeInstanceOf(
      CloudReviewError,
    );
    session.stopLost(false);
    expect((await runtime.runPromise(cloud.cancel(retried.id))).phase).toBe("cancelled");
    await runtime.runPromise(cloud.assertLocal);
    expect((await runtime.runPromise(cloud.start(input))).phase).toBe("cancelled");
    expect(session.operations.filter((operation) => operation === "dispatch")).toHaveLength(1);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("cloud progress must match the job and reach an external checkpoint before becoming ready", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const status = await runtime.runPromise(cloud.start(request()));
    session.checkpointReady(false);
    expect((await runtime.runPromise(cloud.refresh(status.id).pipe(Effect.flip))).reason).toBe(
      "unavailable",
    );
    expect((await runtime.runPromise(cloud.status))?.phase).toBe("dispatching");
    session.checkpointReady(true);
    session.wrongIdentity();
    expect((await runtime.runPromise(cloud.refresh(status.id).pipe(Effect.flip))).reason).toBe(
      "incompatible",
    );
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("changed local source versions reject the cloud package without replacing the workspace", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const status = await runtime.runPromise(cloud.start(request()));
    await runtime.runPromise(cloud.refresh(status.id));
    session.change();
    expect(
      (await runtime.runPromise(cloud.importResults(status.id).pipe(Effect.flip))).reason,
    ).toBe("conflict");
    expect(session.operations).not.toContain("restore");
    expect(await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip))).toBeInstanceOf(
      CloudReviewError,
    );
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("an interrupted import retains its fence and retries only the already downloaded package", async () => {
  const session = await fixture();
  let runtime = session.open();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const status = await runtime.runPromise(cloud.start(request()));
    await runtime.runPromise(cloud.refresh(status.id));
    session.restoreLost(true);
    session.restorePending(true);
    await runtime.runPromise(cloud.importResults(status.id).pipe(Effect.flip));
    expect((await runtime.runPromise(cloud.status))?.phase).toBe("importing");
    expect((await runtime.runPromise(cloud.cancel(status.id).pipe(Effect.flip))).reason).toBe(
      "conflict",
    );
    await runtime.dispose();
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    session.restoreLost(false);
    session.restorePending(false);
    await runtime.runPromise(cloud.importResults(status.id));
    expect(session.operations.filter((operation) => operation === "download")).toHaveLength(1);
    expect(session.operations.filter((operation) => operation === "stop")).toHaveLength(1);
    expect(session.operations.filter((operation) => operation === "restore")).toHaveLength(2);
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("corrupt ownership records fail closed before sandbox operations", async () => {
  const session = await fixture();
  await writeFile(join(session.directory, "state.json"), "not-json");
  const runtime = session.open();

  try {
    const failure = await Effect.runPromise(runtime.contextEffect.pipe(Effect.flip));
    expect(failure.message).toContain("Cloud ownership records are invalid");
    expect(session.operations).toHaveLength(0);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("cloud transfer rejects traversal, duplicate paths, and oversized packages", async () => {
  const manifest = Schema.encodeSync(PackageManifest)(
    new PackageManifest({
      format: "moke-review-package",
      formatVersion: 1,
      scope: "application",
      scopeLabel: "whole-application",
      createdAt: "2026-10-28",
      hash: "sha256",
      engine: "review-pi-1.4.0-v1",
      migrations: [],
      database: { path: "app.sqlite", sha256: "a".repeat(64), bytes: 100 },
      artifacts: [],
      journals: [],
      runs: [],
    }),
  );

  expect(
    (await Effect.runPromise(parseCloudManifest(JSON.stringify(manifest)))).files,
  ).toHaveLength(1);
  const artifact = { path: "../../credentials", sha256: "b".repeat(64), bytes: 1 };
  expect(
    (
      await Effect.runPromise(
        parseCloudManifest(JSON.stringify({ ...manifest, artifacts: [artifact] })).pipe(
          Effect.flip,
        ),
      )
    ).reason,
  ).toBe("incompatible");
  const valid = { ...artifact, path: `artifacts/${artifact.sha256}.pdf` };
  expect(
    (
      await Effect.runPromise(
        parseCloudManifest(JSON.stringify({ ...manifest, artifacts: [valid, valid] })).pipe(
          Effect.flip,
        ),
      )
    ).reason,
  ).toBe("limit");
  expect(
    (
      await Effect.runPromise(
        parseCloudManifest(
          JSON.stringify({
            ...manifest,
            database: { ...manifest.database, bytes: 1024 * 1024 * 1024 },
          }),
        ).pipe(Effect.flip),
      )
    ).reason,
  ).toBe("limit");
});

test("a failed first receipt write cannot create a remote owner or a phantom in-memory owner", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    await mkdir(join(session.directory, "state.json"));
    expect((await runtime.runPromise(cloud.start(request()).pipe(Effect.flip))).reason).toBe(
      "storage",
    );
    expect(await runtime.runPromise(cloud.status)).toBeNull();
    await runtime.runPromise(cloud.assertLocal);
    expect(session.operations).toHaveLength(0);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test.each(["running", "failed"] as const)(
  "stopped or failed worker progress (%s) persists an honest fenced state without repeated readers",
  async (phase) => {
    const session = await fixture();
    let runtime = session.open();

    try {
      let cloud = await runtime.runPromise(CloudReviews);
      const status = await runtime.runPromise(cloud.start(request()));
      session.progress(phase, phase === "running");
      expect((await runtime.runPromise(cloud.refresh(status.id))).phase).toBe("failed");
      await runtime.dispose();
      runtime = session.open();
      cloud = await runtime.runPromise(CloudReviews);
      expect((await runtime.runPromise(cloud.refresh(status.id))).phase).toBe("failed");
      expect(session.operations.filter((operation) => operation === "progress")).toHaveLength(1);
      await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip));
      await runtime.runPromise(cloud.cancel(status.id));
      await runtime.runPromise(cloud.assertLocal);
    } finally {
      await runtime.dispose();
      await session.dispose();
    }
  },
);

test("a permanently invalid result can be downloaded again or abandoned after reopen", async () => {
  const session = await fixture();
  let runtime = session.open();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const status = await runtime.runPromise(cloud.start(request()));
    await runtime.runPromise(cloud.refresh(status.id));
    session.restoreLost(true);
    await runtime.runPromise(cloud.importResults(status.id).pipe(Effect.flip));
    expect((await runtime.runPromise(cloud.status))?.phase).toBe("ready");
    await runtime.dispose();
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    await runtime.runPromise(cloud.importResults(status.id).pipe(Effect.flip));
    expect(session.operations.filter((operation) => operation === "download")).toHaveLength(2);
    await runtime.runPromise(cloud.cancel(status.id));
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test.each(["Modal NotFound", "gRPC NOT_FOUND"])(
  "a provider-forgotten sandbox (%s) can release a persisted failed review",
  async (kind) => {
    const session = await fixture();
    let runtime = session.open();

    try {
      let cloud = await runtime.runPromise(CloudReviews);
      const started = await runtime.runPromise(cloud.start(request()));
      session.progress("failed", true);
      await runtime.runPromise(cloud.refresh(started.id));
      await runtime.dispose();
      runtime = session.open();
      cloud = await runtime.runPromise(CloudReviews);
      session.stopMissing(
        kind === "Modal NotFound"
          ? new NotFoundError("Gone")
          : Object.assign(new Error("Gone"), { name: "ClientError", code: 5 }),
      );
      expect((await runtime.runPromise(cloud.status))?.phase).toBe("failed");
      expect(await runtime.runPromise(cloud.assertLocal.pipe(Effect.flip))).toBeInstanceOf(
        CloudReviewError,
      );
      expect((await runtime.runPromise(cloud.cancel(started.id))).phase).toBe("cancelled");
      await runtime.runPromise(cloud.assertLocal);
    } finally {
      await runtime.dispose();
      await session.dispose();
    }
  },
);

test("stop confirmation rejects transport and permission failures and an owner still running", async () => {
  for (const code of [7, 14]) {
    const error = Object.assign(new Error("Offline failure"), { name: "ClientError", code });
    expect(
      (
        await Effect.runPromise(
          confirmModalSandboxStopped(() => Promise.reject(error)).pipe(Effect.flip),
        )
      ).reason,
    ).toBe("unavailable");
  }

  expect(
    (
      await Effect.runPromise(
        confirmModalSandboxStopped(() => Promise.resolve(null)).pipe(Effect.flip),
      )
    ).reason,
  ).toBe("unavailable");
  await Effect.runPromise(confirmModalSandboxStopped(() => Promise.resolve(137)));
});

test("ownership receipts written before streaming acquire a revision on their next durable change", async () => {
  const session = await fixture();
  let runtime = session.open();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const started = await runtime.runPromise(cloud.start(request()));
    await runtime.dispose();
    const path = join(session.directory, "state.json");

    const legacy = (await readFile(path, "utf8"))
      .replaceAll(/"revision":\d+,/g, "")
      .replaceAll(/"syncFailure":null,/g, "");

    await writeFile(path, legacy);
    runtime = session.open();
    cloud = await runtime.runPromise(CloudReviews);
    expect((await runtime.runPromise(cloud.status))?.revision).toBe(0);
    expect((await runtime.runPromise(cloud.cancel(started.id))).revision).toBe(1);
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("only unmarked dispatched receipts can recover v2 progress with the complete matching identity", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    await runtime.runPromise(cloud.start(request()));

    const recorded = (
      await Effect.runPromise(readCloudState(join(session.directory, "state.json")))
    )[0];

    if (recorded === undefined) throw new Error("Missing admitted receipt");
    expect(recorded.phase).toBe("dispatching");
    const { workerProtocol, ...unmarked } = recorded;
    expect(workerProtocol).toBe(cloudEngineIdentity.protocol);
    const legacy = { ...unmarked, phase: "dispatching" as const };
    const protocol3 = { ...legacy, workerProtocol: 3 as const };
    const protocol4 = { ...legacy, workerProtocol: 4 as const };

    // Workers before protocol 5 shipped packet prompt v3 or earlier and no code index.
    const { codeIndex: _codeIndex, ...priorIdentity } = {
      ...cloudEngineIdentity,
      packetPrompt: "moke-packet-review-v3",
    };

    // Protocol 2 and 3 workers shipped with packet prompts up to v3.
    const progress = {
      id: recorded.id,
      identity: { ...priorIdentity, protocol: 2 },
      phase: "ready",
      execution: null,
      message: "Saved results",
    };

    const parse = (record: CloudReviewRecord, text: string) =>
      Effect.runPromise(parseCloudWorkerProgress(record, text));

    const rejected = (record: CloudReviewRecord, text: string) =>
      Effect.runPromise(parseCloudWorkerProgress(record, text).pipe(Effect.flip));

    expect(Schema.is(CloudWorkerProgress)(progress)).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(WarmSandboxMessage)(
        JSON.stringify({
          sandboxId: "old-worker",
          imageName: "old-image",
          identity: progress.identity,
          expiresAt: recorded.expiresAt,
        }),
      ),
    ).toThrow();

    for (const phase of ["accepted", "running", "ready", "failed"] as const) {
      const oldProgress = { ...progress, phase };
      expect((await parse(legacy, JSON.stringify(oldProgress))).identity.protocol).toBe(2);
      expect(
        (await parse({ ...legacy, phase: "running" }, JSON.stringify(oldProgress))).phase,
      ).toBe(phase);
      expect((await rejected(recorded, JSON.stringify(oldProgress))).reason).toBe("incompatible");
      expect((await rejected(protocol3, JSON.stringify(oldProgress))).reason).toBe("incompatible");
      const currentProgress = { ...oldProgress, identity: cloudEngineIdentity };
      expect(Schema.is(CloudWorkerProgress)(currentProgress)).toBe(true);
      expect((await parse(recorded, JSON.stringify(currentProgress))).identity.protocol).toBe(
        cloudEngineIdentity.protocol,
      );
      // Unmarked, protocol-3 and protocol-4 receipts were saved before protocol 5 existed.
      expect((await rejected(legacy, JSON.stringify(currentProgress))).reason).toBe("incompatible");
      expect((await rejected(protocol3, JSON.stringify(currentProgress))).reason).toBe(
        "incompatible",
      );
      expect((await rejected(protocol4, JSON.stringify(currentProgress))).reason).toBe(
        "incompatible",
      );
      const protocol4Progress = { ...oldProgress, identity: { ...priorIdentity, protocol: 4 } };
      expect(Schema.is(CloudWorkerProgress)(protocol4Progress)).toBe(false);
      expect((await parse(protocol4, JSON.stringify(protocol4Progress))).identity.protocol).toBe(4);
      expect((await rejected(recorded, JSON.stringify(protocol4Progress))).reason).toBe(
        "incompatible",
      );
      expect((await rejected(legacy, JSON.stringify(protocol4Progress))).reason).toBe(
        "incompatible",
      );
      const priorProgress = { ...oldProgress, identity: { ...priorIdentity, protocol: 3 } };
      expect(Schema.is(CloudWorkerProgress)(priorProgress)).toBe(false);
      expect((await parse(legacy, JSON.stringify(priorProgress))).identity.protocol).toBe(3);
      expect((await parse(protocol3, JSON.stringify(priorProgress))).identity.protocol).toBe(3);
      expect((await rejected(recorded, JSON.stringify(priorProgress))).reason).toBe("incompatible");
    }

    for (const phase of [
      "preparing",
      "ready",
      "importing",
      "imported",
      "failed",
      "cancelled",
    ] as const)
      expect((await rejected({ ...legacy, phase }, JSON.stringify(progress))).reason).toBe(
        "incompatible",
      );

    for (const invalid of [
      { ...progress, id: crypto.randomUUID() },
      { ...progress, phase: "complete" },
      { ...progress, execution: {} },
      { ...progress, message: "x".repeat(1001) },
      ...[1, 4, 5].map((protocol) => ({
        ...progress,
        identity: { ...progress.identity, protocol },
      })),
      ...["engine", "prompt", "instructions", "packetPrompt"].map((field) => ({
        ...progress,
        identity: { ...progress.identity, [field]: "unrelated-build" },
      })),
    ])
      expect((await rejected(legacy, JSON.stringify(invalid))).reason).toBe("incompatible");
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("dispatched protocol-4 results survive the protocol 5 upgrade without admitting old workers", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    await runtime.runPromise(cloud.start(request()));

    const recorded = (
      await Effect.runPromise(readCloudState(join(session.directory, "state.json")))
    )[0];

    if (recorded === undefined) throw new Error("Missing admitted receipt");

    const { workerProtocol, ...unmarked } = recorded;
    expect(workerProtocol).toBe(cloudEngineIdentity.protocol);
    const protocol4 = { ...recorded, workerProtocol: 4 as const };

    // Protocol 4 workers shipped packet prompts v3 to v5, and no code index.
    const { codeIndex: _codeIndex, ...protocol4Identity } = { ...cloudEngineIdentity, protocol: 4 };

    for (const packetPrompt of [
      "moke-packet-review-v3",
      "moke-packet-review-v4",
      "moke-packet-review-v5",
    ] as const) {
      const prior = {
        id: recorded.id,
        identity: { ...protocol4Identity, packetPrompt },
        phase: "ready",
        execution: null,
        message: "Saved result from prior protocol",
      };

      expect(Schema.is(CloudWorkerProgress)(prior)).toBe(false);
      expect(() =>
        Schema.decodeUnknownSync(WarmSandboxMessage)(
          JSON.stringify({
            sandboxId: "old-protocol-worker",
            imageName: "old-protocol-image",
            identity: prior.identity,
            expiresAt: recorded.expiresAt,
          }),
        ),
      ).toThrow();

      for (const phase of ["dispatching", "running"] as const)
        expect(
          (
            await Effect.runPromise(
              parseCloudWorkerProgress({ ...protocol4, phase }, JSON.stringify(prior)),
            )
          ).identity.packetPrompt,
        ).toBe(packetPrompt);

      for (const receipt of [
        recorded,
        { ...protocol4, phase: "preparing" as const },
        { ...protocol4, phase: "ready" as const },
        { ...recorded, workerProtocol: 3 as const },
        unmarked,
      ])
        expect(
          (
            await Effect.runPromise(
              parseCloudWorkerProgress(receipt, JSON.stringify(prior)).pipe(Effect.flip),
            )
          ).reason,
        ).toBe("incompatible");
    }
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("cloud setup validates remote prerequisites and failed preflight never creates an owner", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    session.failPreflight(true);
    const setup = await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.setup));

    expect(setup.configured).toBe(false);
    expect(setup.message).toContain("provider secret");

    const failure = await runtime.runPromise(
      Effect.flatMap(CloudReviews, (cloud) => cloud.start(request())).pipe(Effect.flip),
    );

    expect(failure.reason).toBe("configuration");
    expect(
      await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.status)),
    ).toBeNull();
    expect(session.operations).toEqual([]);
    await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.assertLocal));
    session.failPreflight(false);
    expect(
      (await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.setup))).configured,
    ).toBe(true);
  } finally {
    await runtime.dispose();
    await rm(session.directory, { recursive: true, force: true });
  }
});

test("cloud admits the observed accumulated workspace while preserving a bounded transfer cap", async () => {
  const manifest = {
    format: "moke-review-package",
    formatVersion: 1,
    scope: "application",
    scopeLabel: "whole-application",
    createdAt: new Date().toISOString(),
    hash: "sha256",
    engine: cloudEngineIdentity.engine,
    migrations: [],
    database: { path: "app.sqlite", sha256: "a".repeat(64), bytes: 271986285 },
    artifacts: [],
    journals: [],
    runs: [],
  };

  expect(
    (await Effect.runPromise(parseCloudManifest(JSON.stringify(manifest)))).files[0]?.bytes,
  ).toBe(271986285);

  const failure = await Effect.runPromise(
    parseCloudManifest(
      JSON.stringify({
        ...manifest,
        database: { ...manifest.database, bytes: 1024 * 1024 * 1024 },
      }),
    ).pipe(Effect.flip),
  );

  expect(failure.reason).toBe("limit");
  expect(failure.message).toContain("1,024 MiB");
  expect(failure.message).toContain("transfer was refused");
});

test("already-dispatched packet prompt v1 jobs remain recoverable without admitting a v1 worker", async () => {
  const session = await fixture();
  const runtime = session.open();

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    await runtime.runPromise(cloud.start(request()));

    const recorded = (
      await Effect.runPromise(readCloudState(join(session.directory, "state.json")))
    )[0];

    if (recorded === undefined) throw new Error("Missing admitted receipt");
    const protocol3 = { ...recorded, workerProtocol: 3 as const };

    const prior = {
      id: recorded.id,
      identity: { ...cloudEngineIdentity, protocol: 3, packetPrompt: "moke-packet-review-v1" },
      phase: "ready",
      execution: null,
      message: "Saved result from prior build",
    };

    expect(Schema.is(CloudWorkerProgress)(prior)).toBe(false);
    expect(
      (await Effect.runPromise(parseCloudWorkerProgress(protocol3, JSON.stringify(prior)))).identity
        .packetPrompt,
    ).toBe("moke-packet-review-v1");
    // The current protocol accepts only the current packet prompt.
    expect(
      (
        await Effect.runPromise(
          parseCloudWorkerProgress(
            recorded,
            JSON.stringify({
              ...prior,
              identity: { ...prior.identity, protocol: cloudEngineIdentity.protocol },
            }),
          ).pipe(Effect.flip),
        )
      ).reason,
    ).toBe("incompatible");
    expect(
      (
        await Effect.runPromise(
          parseCloudWorkerProgress(
            { ...protocol3, phase: "preparing" },
            JSON.stringify(prior),
          ).pipe(Effect.flip),
        )
      ).reason,
    ).toBe("incompatible");
    expect(
      (
        await Effect.runPromise(
          parseCloudWorkerProgress(
            protocol3,
            JSON.stringify({ ...prior, identity: { ...prior.identity, protocol: 2 } }),
          ).pipe(Effect.flip),
        )
      ).reason,
    ).toBe("incompatible");
    const { workerProtocol, ...unmarked } = recorded;

    expect(workerProtocol).toBe(cloudEngineIdentity.protocol);
    expect(
      (
        await Effect.runPromise(
          parseCloudWorkerProgress(
            unmarked,
            JSON.stringify({ ...prior, identity: { ...prior.identity, protocol: 2 } }),
          ),
        )
      ).identity.protocol,
    ).toBe(2);
  } finally {
    await runtime.dispose();
    await session.dispose();
  }
});

test("a non-canonical provider route fails cloud start before allocation or upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-route-"));
  const operations: Array<string> = [];
  const unused = Effect.die("Cloud work must not start for a non-canonical route.");

  const port: CloudSandboxPort = {
    preflight: () => Effect.sync(() => void operations.push("preflight")),
    changes: () => Stream.never,
    allocate: () => unused,
    upload: () => unused,
    dispatch: () => unused,
    progress: () => unused,
    download: () => unused,
    stop: () => unused,
    seedCache: () => Effect.succeed([]),
  };

  const slashed = Schema.decodeUnknownSync(InferenceConfiguration)({
    ...Schema.encodeSync(InferenceConfiguration)(provider),
    baseUrl: "https://api.meta.ai/v1/",
  });

  const runtime = ManagedRuntime.make(
    CloudReviews.layer({
      directory,
      modal,
      provider: slashed,
      inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
      prepare: () => Effect.sync(() => void operations.push("prepare")),
      restorePending: () => false,
      restore: () => Effect.void,
    }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port))),
  );

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    const error = await runtime.runPromise(cloud.start(request()).pipe(Effect.flip));
    expect(error.reason).toBe("configuration");
    expect(operations).toEqual([]);
    expect(await runtime.runPromise(cloud.status)).toBeNull();
    await runtime.runPromise(cloud.assertLocal);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
