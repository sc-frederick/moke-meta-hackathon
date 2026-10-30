import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import {
  CloudFindingPreview,
  StartCloudPacketReview,
  cloudFindingPreviewLimits,
} from "#lib/review/cloud.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import {
  CloudWorkerProgress,
  cloudEngineIdentity,
  type CloudReviewRecord,
} from "../../backend/cloud/contracts.ts";
import {
  cloudWorkerProgressMaxBytes,
  parseCloudWorkerProgress,
} from "../../backend/cloud/progress.ts";
import {
  cloudFindingPreview,
  cloudSheetReviewProgress,
} from "../../backend/cloud/worker-review.ts";

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

const sheets = Array.from({ length: 10 }, (_, index) => ({
  id: crypto.randomUUID(),
  label: index === 3 ? "" : `S-${index + 1}`,
  pageIndex: index,
}));

const finding = (title: string, sheetIds: ReadonlyArray<string>) => ({
  id: crypto.randomUUID(),
  title,
  severity: "Major" as const,
  discipline: "structural" as const,
  locations: sheetIds.map((sheetId) => ({ sheetId })),
});

const preview = (findings: ReadonlyArray<ReturnType<typeof finding>>) =>
  cloudFindingPreview({ sheets, findings });

test("the cloud finding preview keeps the newest findings, short titles and sheet labels", () => {
  const recorded = Array.from({ length: 80 }, (_, index) =>
    finding(`Finding ${index}`, [sheets[index % sheets.length]?.id ?? ""]),
  );

  const newest = preview(recorded);
  expect(newest).toHaveLength(cloudFindingPreviewLimits.findings);
  expect(newest[0]?.title).toBe("Finding 30");
  expect(newest.at(-1)?.title).toBe("Finding 79");
  // An unlabeled sheet is named by its page.
  expect(newest.find((item) => item.title === "Finding 33")?.sheets).toEqual(["Page 4"]);

  const long = preview([
    finding(`${"a".repeat(198)}😀tail`, [
      ...sheets.map((sheet) => sheet.id),
      sheets[0]?.id ?? "",
      crypto.randomUUID(),
    ]),
  ])[0];

  expect(long?.title).toHaveLength(cloudFindingPreviewLimits.title - 1);
  expect(long?.title.endsWith("…")).toBe(true);
  // The emoji's surrogate pair is dropped whole rather than split.
  expect(long?.title.includes("\uD83D")).toBe(false);
  expect(long?.sheets).toEqual(["S-1", "S-2", "S-3", "Page 4", "S-5", "S-6"]);
  expect(Schema.is(Schema.Array(CloudFindingPreview))(newest)).toBe(true);
});

test("the cloud finding preview drops older findings to stay within its byte bound", () => {
  // Control characters are escaped to six bytes each when the progress record is serialized.
  const recorded = Array.from({ length: 60 }, (_, index) =>
    finding(`${index}:${"\u0001".repeat(190)}`, [sheets[0]?.id ?? ""]),
  );

  const bounded = preview(recorded);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
    cloudFindingPreviewLimits.bytes,
  );
  expect(bounded.length).toBeGreaterThan(0);
  expect(bounded.length).toBeLessThan(cloudFindingPreviewLimits.findings);
  expect(bounded.at(-1)?.title.startsWith("59:")).toBe(true);
});

test("parallel reviews report sheet reviewer counts and single conversations report none", () => {
  expect(cloudSheetReviewProgress({})).toBeUndefined();
  expect(
    cloudSheetReviewProgress({
      parallel: {
        stage: "sheets",
        sheets: [
          { state: "completed" },
          { state: "running" },
          { state: "queued" },
          { state: "failed" },
          { state: "completed" },
        ],
      },
    }),
  ).toEqual({ stage: "sheets", queued: 1, running: 1, completed: 2, failed: 1 });
});

const request = () =>
  Schema.decodeUnknownSync(StartCloudPacketReview)({
    commandId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    model: "muse-spark-1.3",
    discipline: "auto",
    maxCalls: null,
    kind: "packet",
    transferScope: "whole-application",
  });

/** Worker progress is untrusted JSON, so previews here are plain values the parser must check. */
interface PacketExtra {
  readonly findingPreview?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly severity: string;
    readonly discipline: string;
    readonly sheets: ReadonlyArray<string>;
  }>;
  readonly sheetReviews?: {
    readonly stage: string;
    readonly queued: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly lastOpenedDrawing?: string;
}

const packetProgress = (input: typeof StartCloudPacketReview.Type, extra: PacketExtra = {}) => ({
  id: crypto.randomUUID(),
  projectId: input.projectId,
  conversationId: input.conversationId,
  model: input.model,
  state: "running",
  version: 3,
  admittedCalls: 12,
  totalSheets: 10,
  findings: 1,
  ...extra,
});

test("older progress without a preview still decodes and oversized previews are refused", async () => {
  const input = request();
  const id = crypto.randomUUID();

  const progress = (packet: ReturnType<typeof packetProgress>) =>
    JSON.stringify({
      id,
      identity: cloudEngineIdentity,
      phase: "running",
      execution: null,
      packet,
      message: "Running",
    });

  const record: CloudReviewRecord = {
    id,
    workerProtocol: cloudEngineIdentity.protocol,
    revision: 0,
    syncFailure: null,
    fingerprint: "",
    request: input,
    phase: "running",
    createdAt: 0,
    expiresAt: 60_000,
    sandboxId: "sandbox-one",
    inputSnapshotId: null,
    resultSnapshotId: null,
    sandboxName: "moke-review-test",
    appName: "test",
    environment: "main",
    sourceVersion: 0,
    factVersion: 0,
    projectVersion: 0,
    execution: null,
    message: "Running",
  };

  const older = await Effect.runPromise(
    parseCloudWorkerProgress(record, progress(packetProgress(input))),
  );

  expect(older.packet?.findingPreview).toBeUndefined();

  const entry = {
    id: crypto.randomUUID(),
    title: "Footing schedule conflicts with S-2",
    severity: "Critical",
    discipline: "structural",
    sheets: ["S-1", "S-2"],
  };

  const current = await Effect.runPromise(
    parseCloudWorkerProgress(
      record,
      progress(
        packetProgress(input, {
          findingPreview: [entry],
          sheetReviews: { stage: "sheets", queued: 1, running: 2, completed: 3, failed: 0 },
        }),
      ),
    ),
  );

  expect(current.packet?.findingPreview?.[0]?.title).toBe(entry.title);
  expect(current.packet?.sheetReviews?.completed).toBe(3);

  for (const packet of [
    packetProgress(input, {
      findingPreview: Array.from({ length: cloudFindingPreviewLimits.findings + 1 }, () => ({
        ...entry,
        id: crypto.randomUUID(),
      })),
    }),
    packetProgress(input, { findingPreview: [{ ...entry, title: "x".repeat(201) }] }),
    packetProgress(input, {
      findingPreview: [{ ...entry, sheets: Array.from({ length: 7 }, () => "S-1") }],
    }),
    packetProgress(input, { findingPreview: [{ ...entry, severity: "Severe" }] }),
  ])
    expect(Schema.is(CloudWorkerProgress)(JSON.parse(progress(packet)))).toBe(false);

  expect(
    (
      await Effect.runPromise(
        parseCloudWorkerProgress(
          record,
          progress(
            packetProgress(input, { lastOpenedDrawing: "x".repeat(cloudWorkerProgressMaxBytes) }),
          ),
        ).pipe(Effect.flip),
      )
    ).reason,
  ).toBe("incompatible");
});

test("the finding preview survives refresh and restart and is dropped once results import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-cloud-preview-"));
  const input = request();
  let phase: "running" | "ready" = "running";

  const entry = {
    id: crypto.randomUUID(),
    title: "Panel schedule load exceeds the 400 A service",
    severity: "Major" as const,
    discipline: "electrical" as const,
    sheets: ["E-1", "E-3"],
  };

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => Stream.never,
    allocate: () => Effect.succeed("sandbox-one"),
    upload: () => Effect.succeed("source-checkpoint"),
    dispatch: () => Effect.void,
    progress: (record) =>
      Effect.map(
        parseCloudWorkerProgress(
          record,
          JSON.stringify({
            id: record.id,
            identity: cloudEngineIdentity,
            phase,
            execution: null,
            packet: packetProgress(input, {
              findingPreview: [entry],
              sheetReviews: { stage: "sheets", queued: 0, running: 4, completed: 6, failed: 0 },
            }),
            message: "Running",
          }),
        ),
        (progress) => ({
          progress,
          resultSnapshotId: phase === "ready" ? "result-checkpoint" : null,
          sourceStopped: false,
        }),
      ),
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

  let runtime = open();

  try {
    let cloud = await runtime.runPromise(CloudReviews);
    const started = await runtime.runPromise(cloud.start(input));
    const running = await runtime.runPromise(cloud.refresh(started.id));
    expect(running.phase).toBe("running");
    expect(running.packet?.findingPreview).toEqual([entry]);
    expect(running.packet?.sheetReviews?.running).toBe(4);

    await runtime.dispose();
    runtime = open();
    cloud = await runtime.runPromise(CloudReviews);
    expect((await runtime.runPromise(cloud.status))?.packet?.findingPreview).toEqual([entry]);

    phase = "ready";
    expect((await runtime.runPromise(cloud.refresh(started.id))).packet?.findingPreview).toEqual([
      entry,
    ]);
    const imported = await runtime.runPromise(cloud.importResults(started.id));
    expect(imported.phase).toBe("imported");
    expect(imported.packet?.findingPreview).toBeUndefined();
    expect(imported.packet?.sheetReviews?.completed).toBe(6);
    expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain(entry.title);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
