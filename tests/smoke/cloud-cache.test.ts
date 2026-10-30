import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import { StartCloudReview, type CloudTransferProgress } from "#lib/review/cloud.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudCacheSeed, CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { cloudEngineIdentity } from "../../backend/cloud/contracts.ts";
import { cloudCacheVolumeName } from "../../backend/cloud/cache.ts";
import {
  downloadCloudPackage,
  materializeCloudInput,
  reuseLocalArtifact,
  uploadCloudPackage,
} from "../../backend/cloud/transfer.ts";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const packageFile = (path: (hash: string) => string, content: string) => {
  const hash = sha256(content);

  return { path: path(hash), sha256: hash, bytes: Buffer.byteLength(content), content };
};

const database = packageFile(() => "app.sqlite", "database bytes");
const pdf = packageFile((hash) => `artifacts/${hash}.pdf`, "original drawing set");
const render = packageFile((hash) => `artifacts/${hash}.png`, "rendered sheet overview");

const journal = {
  ...packageFile(() => "journals/7f1c9c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f.sqlite", "closed journal"),
  journalId: "7f1c9c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
  format: cloudEngineIdentity.engine,
};

const manifestText = (artifacts = [pdf, render], journals = [journal]) =>
  JSON.stringify({
    format: "moke-review-package",
    formatVersion: 1,
    scope: "application",
    scopeLabel: "whole-application",
    createdAt: new Date().toISOString(),
    hash: "sha256",
    engine: cloudEngineIdentity.engine,
    migrations: [],
    database: { path: database.path, sha256: database.sha256, bytes: database.bytes },
    artifacts: artifacts.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    journals: journals.map(({ path, sha256, bytes, journalId, format }) => ({
      path,
      sha256,
      bytes,
      journalId,
      format,
    })),
    runs: [],
  });

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

test("Send uploads only files the workspace cache lacks and reports reused bytes", async () => {
  const copied: string[] = [];
  const reports: Array<typeof CloudTransferProgress.Type> = [];
  const text = manifestText();

  await Effect.runPromise(
    uploadCloudPackage(
      text,
      (file) => Effect.sync(() => void copied.push(file.path)),
      Effect.void,
      (progress) => Effect.sync(() => void reports.push(progress)),
      // A cached database hash must still be uploaded: it is the changed part of every Send.
      (file) => [database.sha256, pdf.sha256, journal.sha256].includes(file.sha256),
    ),
  );

  expect(copied).toEqual([database.path, render.path]);
  const final = reports.at(-1);
  expect(final?.completedFiles).toBe(5);
  expect(final?.totalFiles).toBe(5);
  expect(final?.completedBytes).toBe(final?.totalBytes);
  expect(final?.reusedFiles).toBe(2);
  expect(final?.reusedBytes).toBe(pdf.bytes + journal.bytes);
});

test("the worker fills skipped files from the cache and refuses a mismatched cache file", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-materialize-"));
  const input = join(root, "input");
  const cache = join(root, "cache");

  try {
    await mkdir(join(input, "artifacts"), { recursive: true });
    await mkdir(join(cache, "sha256"), { recursive: true });
    await writeFile(join(input, "manifest.json"), manifestText());
    await writeFile(join(input, database.path), database.content);
    await writeFile(join(input, render.path), render.content);

    for (const file of [pdf, journal])
      await writeFile(join(cache, "sha256", file.sha256), file.content);

    const result = await Effect.runPromise(materializeCloudInput(input, cache));
    expect(result).toEqual({ files: 4, materialized: 2 });
    expect(await readFile(join(input, pdf.path), "utf8")).toBe(pdf.content);
    expect(await readFile(join(input, journal.path), "utf8")).toBe(journal.content);

    // Same length, different bytes: the cache entry must not reach restore.
    await rm(join(input, pdf.path));
    await writeFile(join(cache, "sha256", pdf.sha256), "X".repeat(pdf.bytes));

    const mismatch = await Effect.runPromise(materializeCloudInput(input, cache).pipe(Effect.flip));

    expect(mismatch.reason).toBe("incompatible");
    expect(mismatch.message).toContain("does not match");

    await rm(join(cache, "sha256", pdf.sha256));
    await rm(join(input, pdf.path), { force: true });
    const missing = await Effect.runPromise(materializeCloudInput(input, cache).pipe(Effect.flip));
    expect(missing.reason).toBe("incompatible");
    expect(missing.message).toContain("missing from cloud storage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result download copies matching local artifacts and downloads everything else", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-reuse-"));
  const data = join(root, "data");
  const destination = join(root, "output");
  const crop = packageFile((hash) => `artifacts/${hash}.png`, "new crop rendered in the cloud");
  const downloaded: string[] = [];
  const reports: Array<typeof CloudTransferProgress.Type> = [];
  const remote = new Map([database, pdf, render, crop, journal].map((file) => [file.path, file]));

  try {
    await mkdir(join(data, "artifacts"), { recursive: true });
    await writeFile(join(data, pdf.path), pdf.content);
    // A same-sized local file with different bytes is never trusted.
    await writeFile(join(data, render.path), "Y".repeat(render.bytes));

    await Effect.runPromise(
      downloadCloudPackage(
        manifestText([pdf, render, crop]),
        destination,
        (file, local) =>
          Effect.promise(async () => {
            downloaded.push(file.path);
            await mkdir(join(local, ".."), { recursive: true });
            await writeFile(local, remote.get(file.path)?.content ?? "");
          }),
        (progress) => Effect.sync(() => void reports.push(progress)),
        reuseLocalArtifact(data),
      ),
    );

    // Files download concurrently, so only the set is fixed.
    expect(downloaded.toSorted()).toEqual(
      [database.path, render.path, crop.path, journal.path].toSorted(),
    );
    expect(await readFile(join(destination, pdf.path), "utf8")).toBe(pdf.content);
    expect(await readFile(join(destination, render.path), "utf8")).toBe(render.content);
    expect(reports.at(-1)?.reusedFiles).toBe(1);
    expect(reports.at(-1)?.reusedBytes).toBe(pdf.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function cacheFixture() {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-cache-"));
  const directory = join(root, "data.cloud");
  const data = join(root, "data");
  const seeds: CloudCacheSeed[] = [];
  const waiting: Array<() => void> = [];
  // Stands in for the Volume: uploads and snapshot copies land here, pruning removes entries.
  const volume = new Map<string, number>();
  let paused: boolean | null = null;
  let allocatedVolume: string | undefined;

  await mkdir(join(data, "artifacts"), { recursive: true });

  for (const file of [pdf, render]) await writeFile(join(data, file.path), file.content);

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => Stream.never,
    allocate: (record) =>
      Effect.sync(() => {
        allocatedVolume = record.cacheVolume;

        return "sandbox-one";
      }),
    upload: () => Effect.succeed("input-snapshot"),
    dispatch: () => Effect.void,
    progress: () => Effect.die("unused"),
    download: () => Effect.void,
    stop: () => Effect.void,
    seedCache: (request) =>
      Effect.gen(function* () {
        paused = yield* request.paused;

        for (const file of [...request.snapshots.flatMap((entry) => entry.files), ...request.local])
          volume.set(file.sha256, file.bytes);

        const keep = request.keep === null ? null : new Set(request.keep);

        for (const hash of volume.keys()) if (keep?.has(hash) === false) volume.delete(hash);

        seeds.push(request);
        waiting.splice(0).forEach((resolve) => resolve());

        return [...volume].map(([sha256, bytes]) => ({ sha256, bytes }));
      }),
  };

  const open = () =>
    ManagedRuntime.make(
      CloudReviews.layer({
        directory,
        dataDirectory: data,
        modal,
        provider,
        inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
        prepare: (destination) =>
          Effect.promise(async () => {
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, "manifest.json"), manifestText());
          }),
        estimate: Effect.succeed({ bytes: 1000, files: 5, projects: 1, measuredAt: 0 }),
        restorePending: () => false,
        restore: () => Effect.void,
      }).pipe(Layer.provide(Layer.succeed(CloudSandbox, port))),
    );

  return {
    root,
    seeds,
    open,
    allocatedVolume: () => allocatedVolume,
    pausedDuringLastSeed: () => paused,
    volume,
    /** Resolves after the background seeder has called the port `count` times in total. */
    seeded: (count: number) =>
      seeds.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const check = () => (seeds.length >= count ? resolve() : waiting.push(check));
            waiting.push(check);
          }),
  };
}

test("the workspace cache seeds local files, prunes only unreferenced files and keeps its Volume", async () => {
  const session = await cacheFixture();
  const stale = "c".repeat(64);
  let runtime = session.open();

  try {
    // Launch seeds both local artifacts into this workspace's own Volume.
    await runtime.runPromise(CloudReviews);
    await session.seeded(1);
    const first = session.seeds[0];
    expect(first?.local.map((file) => file.sha256).sort()).toEqual(
      [pdf.sha256, render.sha256].sort(),
    );
    expect(first?.keep).toBeNull();
    expect(first?.volume).toMatch(/^test-cache-[a-f0-9]{16}$/);
    const volume = first?.volume;

    await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.syncCache));
    await Bun.sleep(50);
    // Nothing is missing and nothing is unreferenced, so no uploader sandbox starts.
    expect(session.seeds).toHaveLength(1);

    const setup = await runtime.runPromise(Effect.flatMap(CloudReviews, (cloud) => cloud.setup));
    expect(setup.workspaceEstimate?.syncedFiles).toBe(2);
    expect(setup.workspaceEstimate?.syncedBytes).toBe(pdf.bytes + render.bytes);

    // The Volume later also holds a file this workspace no longer stores or references.
    await runtime.dispose();
    session.volume.set(stale, 9);

    const state = JSON.parse(
      await readFile(join(session.root, "data.cloud", "cache.json"), "utf8"),
    );

    await writeFile(
      join(session.root, "data.cloud", "cache.json"),
      JSON.stringify({ ...state, cached: [...state.cached, { sha256: stale, bytes: 9 }] }),
    );
    runtime = session.open();
    await runtime.runPromise(CloudReviews);
    await session.seeded(2);
    const pruning = session.seeds[1];
    expect(pruning?.volume).toBe(volume);
    expect(pruning?.local).toEqual([]);
    expect([...(pruning?.keep ?? [])].sort()).toEqual([pdf.sha256, render.sha256].sort());
    expect(session.pausedDuringLastSeed()).toBe(false);
    expect(session.volume.has(stale)).toBe(false);
  } finally {
    await runtime.dispose();
    await rm(session.root, { recursive: true, force: true });
  }

  expect(cloudCacheVolumeName("a".repeat(60), "0123456789abcdef")).toBe(
    "moke-cache-0123456789abcdef",
  );
});

test("Send mounts the cache and copies its uploaded files from the input snapshot, never pruning", async () => {
  const session = await cacheFixture();
  const runtime = session.open();

  try {
    await runtime.runPromise(CloudReviews);
    await session.seeded(1);

    await runtime.runPromise(
      Effect.flatMap(CloudReviews, (cloud) =>
        cloud.start(
          Schema.decodeUnknownSync(StartCloudReview)({
            commandId: crypto.randomUUID(),
            projectId: crypto.randomUUID(),
            findingId: crypto.randomUUID(),
            transferScope: "whole-application",
            budget: { maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 },
          }),
        ),
      ),
    );

    expect(session.allocatedVolume()).toBe(session.seeds[0]?.volume);
    await session.seeded(2);
    const retain = session.seeds[1];
    expect(retain?.snapshots).toHaveLength(1);
    expect(retain?.snapshots[0]?.imageId).toBe("input-snapshot");
    // The database is never cached, and both artifacts were seeded at launch.
    expect(retain?.snapshots[0]?.files.map((file) => file.path)).toEqual([`input/${journal.path}`]);
    expect(session.volume.has(journal.sha256)).toBe(true);
    // The review owns the workspace: no local uploads and no pruning.
    expect(retain?.local).toEqual([]);
    expect(retain?.keep).toBeNull();
    expect(session.pausedDuringLastSeed()).toBe(true);
  } finally {
    await runtime.dispose();
    await rm(session.root, { recursive: true, force: true });
  }
});
