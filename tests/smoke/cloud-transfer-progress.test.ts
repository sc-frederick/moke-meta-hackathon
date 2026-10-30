import { expect, test } from "bun:test";
import { Deferred, Effect, Layer, ManagedRuntime, Schema, Semaphore, Stream } from "effect";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudReviewError,
  StartCloudReview,
  type CloudTransferProgress,
} from "#lib/review/cloud.ts";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { PackageError, PackageManifest } from "#lib/review/packages.ts";
import { cloudEngineIdentity } from "../../backend/cloud/contracts.ts";
import { readCloudState } from "../../backend/cloud/files.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { downloadCloudPackage, uploadCloudPackage } from "../../backend/cloud/transfer.ts";
import { estimateReviewPackage } from "../../backend/review/packages.ts";
import { chatResponse, id, open } from "../fixtures/packet-review.ts";

const unavailable = () =>
  new CloudReviewError({ reason: "unavailable", message: "Transfer interrupted" });

const hash = (content: string) => createHash("sha256").update(content).digest("hex");

function packageText() {
  return JSON.stringify(
    Schema.encodeSync(PackageManifest)(
      new PackageManifest({
        format: "moke-review-package",
        formatVersion: 1,
        scope: "application",
        scopeLabel: "whole-application",
        createdAt: "2026-10-29T12:00:00.000Z",
        hash: "sha256",
        engine: cloudEngineIdentity.engine,
        migrations: [],
        database: { path: "app.sqlite", bytes: 8, sha256: hash("database") },
        artifacts: [
          { path: `artifacts/${hash("drawing")}.pdf`, bytes: 7, sha256: hash("drawing") },
        ],
        journals: [],
        runs: [],
      }),
    ),
  );
}

const copy = (source: string, destination: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    },
    catch: unavailable,
  });

test("live cloud status and flushed receipts expose completed upload/download files before transfer ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-progress-"));
  const source = join(root, "package");
  const remote = join(root, "remote");
  const directory = join(root, "receipts");
  const text = packageText();
  const artifact = `artifacts/${hash("drawing")}.pdf`;
  const uploadBlocked = Effect.runSync(Deferred.make<void>());
  const uploadContinue = Effect.runSync(Deferred.make<void>());
  const downloadBlocked = Effect.runSync(Deferred.make<void>());
  const downloadContinue = Effect.runSync(Deferred.make<void>());
  await mkdir(join(source, "artifacts"), { recursive: true });
  await writeFile(join(source, "app.sqlite"), "database");
  await writeFile(join(source, artifact), "drawing");
  let dispatches = 0;

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => Stream.never,
    allocate: () => Effect.succeed("sandbox"),
    upload: (_record, _source, report) =>
      Effect.gen(function* () {
        yield* uploadCloudPackage(
          text,
          (file) =>
            Effect.gen(function* () {
              if (file.path === artifact) {
                yield* Deferred.succeed(uploadBlocked, undefined);
                yield* Deferred.await(uploadContinue);
              }

              yield* copy(join(source, file.path), join(remote, file.path));
            }),
          copy(join(source, "manifest.json"), join(remote, "manifest.json")),
          report,
        );

        return "input-snapshot";
      }),
    dispatch: () =>
      Effect.sync(() => {
        dispatches++;
      }),
    progress: (record) =>
      Effect.succeed({
        progress: {
          id: record.id,
          identity: cloudEngineIdentity,
          phase: "ready",
          execution: null,
          message: "Ready",
        },
        resultSnapshotId: "immutable-result-snapshot",
        sourceStopped: false,
      }),
    download: (record, destination, report) =>
      Effect.gen(function* () {
        expect(record.resultSnapshotId).toBe("immutable-result-snapshot");
        yield* downloadCloudPackage(
          text,
          destination,
          (file, local) =>
            Effect.gen(function* () {
              if (file.path === artifact) {
                yield* Deferred.succeed(downloadBlocked, undefined);
                yield* Deferred.await(downloadContinue);
              }

              yield* copy(join(remote, file.path), local);
            }),
          report,
        );
      }),
    stop: () => Effect.void,
    seedCache: () => Effect.succeed([]),
  };

  await writeFile(join(source, "manifest.json"), text);

  const layer = CloudReviews.layer({
    directory,
    modal: Schema.decodeUnknownSync(ModalConfiguration)({
      tokenId: "test",
      tokenSecret: "test",
      appName: "test",
      environment: "main",
      imageName: "test",
      timeoutMinutes: 15,
      poolQueue: null,
    }),
    provider: Schema.decodeUnknownSync(InferenceConfiguration)({
      provider: "meta",
      apiKey: "test",
      baseUrl: "https://api.meta.ai/v1",
      model: "muse-spark-1.3",
    }),
    inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
    prepare: () => Effect.void,
    restore: () => Effect.void,
    restorePending: () => false,
  }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port)));

  let runtime = ManagedRuntime.make(layer);

  try {
    const cloud = await runtime.runPromise(CloudReviews);

    const request = Schema.decodeUnknownSync(StartCloudReview)({
      commandId: id(),
      projectId: id(),
      findingId: id(),
      transferScope: "whole-application",
      budget: { maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 },
    });

    const starting = runtime.runPromise(cloud.start(request));
    await runtime.runPromise(Deferred.await(uploadBlocked).pipe(Effect.timeout("5 seconds")));

    const [upload] = await runtime.runPromise(
      cloud.observe.pipe(Stream.take(1), Stream.runCollect),
    );

    expect(upload?.transfer).toMatchObject({
      direction: "upload",
      completedFiles: 1,
      completedBytes: 8,
      totalFiles: 3,
      totalBytes: 15 + Buffer.byteLength(text),
    });
    const persisted = (await Effect.runPromise(readCloudState(join(directory, "state.json"))))[0];
    expect(persisted?.transfer).toEqual(upload?.transfer);
    expect(dispatches).toBe(0);
    await runtime.runPromise(Deferred.succeed(uploadContinue, undefined));
    const sent = await starting;
    expect(sent.transfer?.completedBytes).toBe(sent.transfer?.totalBytes);
    expect(sent.transfer?.completedFiles).toBe(3);
    expect(sent.revision).toBeGreaterThan(upload?.revision ?? 0);
    await runtime.runPromise(cloud.refresh(sent.id));
    const importing = runtime.runPromise(cloud.importResults(sent.id));
    await runtime.runPromise(Deferred.await(downloadBlocked).pipe(Effect.timeout("5 seconds")));
    const download = await runtime.runPromise(cloud.status);
    expect(download?.transfer).toMatchObject({
      direction: "download",
      completedFiles: 1,
      completedBytes: 8,
    });
    expect(download?.revision).toBeGreaterThan(sent.revision);
    expect(
      (await Effect.runPromise(readCloudState(join(directory, "state.json"))))[0]?.transfer,
    ).toEqual(download?.transfer);
    await runtime.runPromise(Deferred.succeed(downloadContinue, undefined));
    const imported = await importing;
    expect(imported.transfer?.completedFiles).toBe(3);
    expect(imported.transfer?.completedBytes).toBe(imported.transfer?.totalBytes);
    expect(await readFile(join(directory, sent.id, "output", artifact), "utf8")).toBe("drawing");
    await runtime.dispose();
    runtime = ManagedRuntime.make(layer);
    expect(
      (await runtime.runPromise(Effect.flatMap(CloudReviews, (value) => value.status)))?.transfer,
    ).toEqual(imported.transfer);
    expect(dispatches).toBe(1);
  } finally {
    await Effect.runPromise(Deferred.succeed(uploadContinue, undefined));
    await Effect.runPromise(Deferred.succeed(downloadContinue, undefined));
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("download progress counts verified resumed files and refuses same-size corrupt bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-progress-resume-"));
  const text = packageText();
  const progress: Array<typeof CloudTransferProgress.Type> = [];

  const report = (value: typeof CloudTransferProgress.Type) =>
    Effect.sync(() => {
      progress.push(value);
    });

  try {
    await writeFile(join(root, "app.sqlite"), "database");

    const first = await Effect.runPromise(
      downloadCloudPackage(text, root, () => Effect.fail(unavailable()), report).pipe(Effect.flip),
    );

    expect(first.reason).toBe("unavailable");
    expect(progress.at(-1)?.completedBytes).toBe(8);
    await mkdir(join(root, "artifacts"));

    const corrupt = await Effect.runPromise(
      downloadCloudPackage(
        text,
        root,
        (_file, destination) =>
          Effect.tryPromise({
            try: () => writeFile(destination, "corrupt"),
            catch: unavailable,
          }),
        report,
      ).pipe(Effect.flip),
    );

    expect(corrupt.reason).toBe("incompatible");
    expect(progress.at(-1)?.completedFiles).toBe(1);
    const copied: string[] = [];
    await Effect.runPromise(
      downloadCloudPackage(
        text,
        root,
        (file, destination) =>
          Effect.tryPromise({
            try: async () => {
              copied.push(file.path);
              await writeFile(destination, "drawing");
            },
            catch: unavailable,
          }),
        report,
      ),
    );
    expect(copied).toEqual([`artifacts/${hash("drawing")}.pdf`]);
    expect(progress.at(-1)).toMatchObject({
      direction: "download",
      completedFiles: 3,
      completedBytes: 15 + Buffer.byteLength(text),
      totalFiles: 3,
    });
    const resumed: Array<typeof CloudTransferProgress.Type> = [];
    await Effect.runPromise(
      downloadCloudPackage(
        text,
        root,
        () => Effect.fail(unavailable()),
        (value) =>
          Effect.sync(() => {
            resumed.push(value);
          }),
      ),
    );
    expect(resumed.map((value) => value.completedBytes)).toEqual([
      0,
      8,
      15,
      15 + Buffer.byteLength(text),
    ]);
    expect(await readFile(join(root, "manifest.json"), "utf8")).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace sizing checks replacement safety under SQL exclusion before opening SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-estimate-guard-"));

  const queries = Semaphore.makeUnsafe(1);

  const blocked = new PackageError({
    reason: "conflict",
    message: "Recover the interrupted restore before measuring this workspace.",
  });

  await writeFile(join(root, "app.sqlite"), "interrupted replacement is not readable SQLite");

  try {
    const failure = await Effect.runPromise(
      estimateReviewPackage({
        dataDirectory: root,
        queries,
        assertReadable: Effect.gen(function* () {
          const permitAvailable = yield* Semaphore.takeIfAvailable(queries, 1);

          if (permitAvailable) yield* Semaphore.release(queries, 1);

          expect(permitAvailable).toBe(false);

          return yield* blocked;
        }),
      }).pipe(Effect.flip),
    );

    expect(failure).toEqual(blocked);
    expect(await readdir(root)).toEqual(["app.sqlite"]);
    expect(await Effect.runPromise(Semaphore.takeIfAvailable(queries, 1))).toBe(true);
    await Effect.runPromise(Semaphore.release(queries, 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace sizing measures referenced files and project count without stopping an active review", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-estimate-"));
  const admitted = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();

  const session = await open(root, async () => {
    admitted.resolve();

    return response.promise;
  });

  const config = { dataDirectory: root, queries: Semaphore.makeUnsafe(1) };

  try {
    const initial = await session.run(estimateReviewPackage(config));
    expect(initial.projects).toBe(1);
    await mkdir(join(root, "backups"), { recursive: true });
    await writeFile(join(root, "backups", "large.sqlite"), Buffer.alloc(1024 * 1024));
    await writeFile(join(root, "credentials.json"), "secret sentinel");
    await writeFile(join(root, "inference.log"), "log sentinel");
    await writeFile(join(root, "artifacts", `${"f".repeat(64)}.png`), Buffer.alloc(1024 * 1024));
    const unchanged = await session.run(estimateReviewPackage(config));
    expect(unchanged.bytes).toBe(initial.bytes);
    expect(unchanged.files).toBe(initial.files);
    await session.command(
      ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Second project" }),
    );
    expect((await session.run(estimateReviewPackage(config))).projects).toBe(2);
    const request = await session.request("Review this drawing", { maxCalls: 1 });
    const started = await session.run(session.packets.start(request));
    await session.run(Effect.promise(() => admitted.promise).pipe(Effect.timeout("5 seconds")));

    const before = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const active = await session.run(
      estimateReviewPackage(config).pipe(Effect.timeout("5 seconds")),
    );

    const stillRunning = await session.run(session.packets.get(session.projectId, started.id));
    expect(stillRunning.state).toBe("running");
    expect(stillRunning.admittedCalls).toBe(1);
    expect(active.files).toBe(initial.files + 1);
    expect(active.projects).toBe(2);
    expect(active.bytes).toBeGreaterThan(initial.bytes);
    expect(
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(before);
    expect(await readFile(join(root, "credentials.json"), "utf8")).toBe("secret sentinel");
  } finally {
    response.resolve(chatResponse("Review paused"));
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
