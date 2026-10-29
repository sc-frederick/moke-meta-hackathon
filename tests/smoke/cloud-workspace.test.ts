import { expect, test } from "bun:test";
import { Deferred, Effect, Layer, ManagedRuntime, PubSub, Redacted, Schema, Stream } from "effect";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, type ApplicationEntry } from "../../backend/application.ts";
import { CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import {
  cloudEngineIdentity,
  CloudWorkerRequest,
  type CloudWorkerProgress,
} from "../../backend/cloud/contracts.ts";
import { BackendConfig, ModalConfiguration, InferenceConfiguration } from "#lib/backend-rpc.ts";
import { CommandId, FindingId, ReviewCommand } from "#lib/review/contracts.ts";
import { ExecutionBudget } from "#lib/review/execution.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { cloudPackageLimits } from "../../backend/cloud/transfer.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";

import { open as openPacketFixture, chatResponse } from "../fixtures/packet-review.ts";
import { runCloudReview } from "../../backend/cloud/worker-review.ts";
import { parseCloudWorkerProgress } from "../../backend/cloud/progress.ts";
import { readCloudState, writeCloudFile } from "../../backend/cloud/files.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

function openApplication(config: BackendConfig, sandbox?: Layer.Layer<CloudSandbox>) {
  let callbacks: ApplicationEntry | undefined;

  const entry: ApplicationEntry = {
    runPromise: (operation, options) => {
      if (callbacks === undefined) return Promise.reject(new Error("Test runtime is not ready"));

      return callbacks.runPromise(operation, options);
    },
  };

  const runtime = ManagedRuntime.make(Application.layer(config, entry, sandbox));
  callbacks = runtime;

  return runtime;
}

async function saveLegacyCloudReceipt(data: string, phase: "dispatching" | "running") {
  const path = `${data}.cloud/state.json`;
  const jobs = await Effect.runPromise(readCloudState(path));

  await Effect.runPromise(
    writeCloudFile(
      path,
      JSON.stringify(
        { version: 1, jobs: jobs.map((record) => ({ ...record, phase })) },
        (key, value) => (key === "workerProtocol" ? undefined : value),
      ),
    ),
  );
}

test.each([
  { corrupt: false, legacyPhase: null },
  { corrupt: true, legacyPhase: null },
  { corrupt: false, legacyPhase: "dispatching" },
  { corrupt: false, legacyPhase: "running" },
  { corrupt: true, legacyPhase: "running" },
] as const)(
  "the application fences writes across reopen and handles real returned packages (%j)",
  async ({ corrupt, legacyPhase }) => {
    const root = await mkdtemp(join(tmpdir(), "moke-cloud-workspace-"));
    const data = join(root, "local");
    const remoteData = join(root, "remote");
    const uploaded = join(root, "uploaded");
    const returned = join(root, "returned");
    const checkpoint = join(root, "result-snapshot");
    let dispatched = 0;
    let stopped = false;
    let remotelyReady = false;
    let downloads = 0;
    const checkpoints: string[] = [];
    const uploadStarted = Effect.runSync(Deferred.make<void>());
    const uploadContinue = Effect.runSync(Deferred.make<void>());
    const downloadStarted = Effect.runSync(Deferred.make<void>());
    const downloadContinue = Effect.runSync(Deferred.make<void>());
    const notifications = Effect.runSync(PubSub.unbounded<void>());
    let remote: ReturnType<typeof openApplication> | undefined;

    const config = new BackendConfig({
      dataDirectory: data,
      migrationDirectory: resolve("migrations"),
      token: Redacted.make("t".repeat(32)),
      modal: Schema.decodeUnknownSync(ModalConfiguration)({
        tokenId: "test",
        tokenSecret: "modal-secret-sentinel",
        appName: "test",
        environment: "main",
        imageName: "test:one",
        timeoutMinutes: 15,
        poolQueue: null,
      }),
      inference: Schema.decodeUnknownSync(InferenceConfiguration)({
        provider: "meta",
        apiKey: "model-secret-sentinel",
        baseUrl: "https://api.meta.ai/v1",
        model: "muse-spark-1.3",
      }),
      processing: {
        workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
        assetsDirectory: resolve("node_modules/pdfjs-dist"),
        nativeLibraryPath: join(
          dirname(fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`))),
          canvasNativeFileName(),
        ),
      },
    });

    const port: CloudSandboxPort = {
      preflight: () => Effect.void,
      changes: () => Stream.fromPubSub(notifications),
      allocate: () => Effect.succeed("local-test-sandbox"),
      upload: (_record, source) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(uploadStarted, undefined);
          yield* Deferred.await(uploadContinue);

          return yield* Effect.tryPromise({
            try: async () => {
              await cp(source, uploaded, { recursive: true });
              const manifest = await readFile(join(uploaded, "manifest.json"), "utf8");
              expect(manifest).not.toContain("secret-sentinel");

              return "test-input-snapshot";
            },
            catch: () =>
              new CloudReviewError({ reason: "unavailable", message: "Test upload failed" }),
          });
        }),
      dispatch: (record) =>
        Effect.gen(function* () {
          dispatched++;
          remote = openApplication(
            new BackendConfig({
              dataDirectory: remoteData,
              migrationDirectory: resolve("migrations"),
              token: Redacted.make("r".repeat(32)),
            }),
          );

          const application = yield* Effect.promise(() =>
            remote === undefined
              ? Promise.reject(new Error("Missing test remote"))
              : remote.runPromise(Application),
          );

          yield* application.restorePackage(uploaded);
          const snapshot = yield* application.review.snapshot(record.request.projectId, 0);
          const conversation = snapshot.conversations[0];

          if (conversation === undefined) return yield* Effect.die("Missing test conversation");
          yield* application.review.command(
            ReviewCommand.cases.PostMessage.make({
              commandId: id(),
              projectId: record.request.projectId,
              expectedVersion: snapshot.project?.version ?? -1,
              conversationId: conversation.id,
              text: "Cloud result imported through the real package boundary.",
            }),
          );
          expect(
            (yield* application
              .exportPackage(join(root, "too-small"), { maxFiles: 5000, maxBytes: 1 })
              .pipe(Effect.flip)).reason,
          ).toBe("limit");
          yield* application.exportPackage(returned, cloudPackageLimits);
        }).pipe(Effect.orDie),
      progress: (record) =>
        Effect.gen(function* () {
          const progress = yield* parseCloudWorkerProgress(
            record,
            JSON.stringify({
              id: record.id,
              identity: {
                ...cloudEngineIdentity,
                protocol: legacyPhase !== null && record.workerProtocol === undefined ? 2 : 3,
              },
              phase: remotelyReady ? "ready" : "running",
              execution: null,
              message: "Test review ready",
            }),
          );

          if (progress.phase === "ready") {
            yield* Effect.promise(() => cp(returned, checkpoint, { recursive: true }));
            checkpoints.push(record.id);
          }

          return {
            progress,
            resultSnapshotId: progress.phase === "ready" ? "test-result-snapshot" : null,
            sourceStopped: remotelyReady && legacyPhase === "running",
          };
        }),
      download: (record, destination) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(downloadStarted, undefined);
          yield* Deferred.await(downloadContinue);
          yield* Effect.promise(async () => {
            expect(record.resultSnapshotId).toBe("test-result-snapshot");
            expect(checkpoints).toContain(record.id);
            downloads++;
            await cp(checkpoint, destination, { recursive: true });

            if (corrupt) {
              const path = join(destination, "app.sqlite");
              const bytes = await readFile(path);
              bytes[0] = (bytes[0] ?? 0) ^ 0xff;
              await writeFile(path, bytes);
            }
          });
        }),
      stop: () =>
        Effect.sync(() => {
          stopped = true;
        }),
    };

    const sandbox = Layer.succeed(CloudSandbox, port);
    let runtime = openApplication(config, sandbox);

    try {
      let application = await runtime.runPromise(Application);

      const created = await runtime.runPromise(
        application.review.command(
          ReviewCommand.cases.CreateProject.make({
            commandId: id(),
            name: "Cloud coordination review",
          }),
        ),
      );

      const projectId = created.projectId;
      const pdf = join(root, "source.pdf");
      await writeFile(pdf, createHeroPdf("A"));
      let state = await runtime.runPromise(application.review.snapshot(projectId, 0));
      await runtime.runPromise(
        application.review.importPdf({
          commandId: id(),
          projectId,
          expectedVersion: state.project?.version ?? -1,
          source: pdf,
          name: "Rev A",
        }),
      );
      state = await runtime.runPromise(application.review.snapshot(projectId, 0));
      const plan = state.sheets[0];
      const schedule = state.sheets[1];

      if (plan === undefined || schedule === undefined)
        throw new Error("Missing test source sheets");

      for (const sheet of [plan, schedule]) {
        await runtime.runPromise(
          application.review.command(
            ReviewCommand.cases.ConfirmSheet.make({
              commandId: id(),
              projectId,
              expectedVersion: state.project?.version ?? -1,
              sheetId: sheet.id,
              label: `L-${sheet.pageIndex}`,
              coverage: "partial",
            }),
          ),
        );
        state = await runtime.runPromise(application.review.snapshot(projectId, 0));
      }

      const finding = await runtime.runPromise(
        application.review.command(
          ReviewCommand.cases.CreateFinding.make({
            commandId: id(),
            projectId,
            expectedVersion: state.project?.version ?? -1,
            title: "Room 101 count",
            objectClass: "lighting",
            drawnSheetId: plan.id,
            scheduledSheetId: schedule.id,
            applicabilityConfirmed: true,
          }),
        ),
      );

      state = await runtime.runPromise(application.review.snapshot(projectId, 0));
      const conversation = state.conversations[0];

      if (conversation === undefined) throw new Error("Missing test conversation");

      const posted = await runtime.runPromise(
        application.review.command(
          ReviewCommand.cases.PostMessage.make({
            commandId: id(),
            projectId,
            expectedVersion: state.project?.version ?? -1,
            conversationId: conversation.id,
            text: "Inspect lighting coordination in the cloud.",
          }),
        ),
      );

      const request = {
        commandId: id(),
        projectId,
        findingId: Schema.decodeUnknownSync(FindingId)(finding.entityId),
        reviewRequest: {
          conversationId: conversation.id,
          messageId: posted.entityId,
          discipline: "electrical" as const,
        },
        budget: new ExecutionBudget({ maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 }),
        transferScope: "whole-application" as const,
      };

      const starting = runtime.runPromise(application.cloud.start(request));
      await runtime.runPromise(Deferred.await(uploadStarted));

      const readingDuringTransfer = runtime.runPromise(
        application.review.snapshot(projectId, 0).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      );

      try {
        expect(
          await Promise.race([
            readingDuringTransfer,
            runtime.runPromise(Effect.sleep("2 seconds").pipe(Effect.as(false))),
          ]),
        ).toBe(true);
      } finally {
        await runtime.runPromise(Deferred.succeed(uploadContinue, undefined));
      }

      const started = await starting;

      expect(await readingDuringTransfer).toBe(true);
      expect(dispatched).toBe(1);

      const command = ReviewCommand.cases.CreateProject.make({
        commandId: id(),
        name: "Must remain blocked",
      });

      expect(
        (await runtime.runPromise(application.review.command(command).pipe(Effect.flip))).message,
      ).toContain("cloud review owns");
      expect(
        (await runtime.runPromise(application.execution.start(request).pipe(Effect.flip))).reason,
      ).toBe("conflict");
      expect(
        (await runtime.runPromise(application.restorePackage(uploaded).pipe(Effect.flip))).reason,
      ).toBe("conflict");
      expect(
        (await runtime.runPromise(application.review.snapshot(projectId, 0))).messages,
      ).toHaveLength(1);

      if (legacyPhase === "dispatching")
        await runtime.runPromise(
          application.cloud.pauseSynchronization(
            started.id,
            new CloudReviewError({
              reason: "incompatible",
              message: "Previously rejected protocol-2 progress",
            }),
          ),
        );

      await runtime.dispose();

      if (legacyPhase !== null) await saveLegacyCloudReceipt(data, legacyPhase);

      runtime = openApplication(config, sandbox);
      application = await runtime.runPromise(Application);
      expect((await runtime.runPromise(application.cloud.status))?.id).toBe(started.id);
      expect(
        (await runtime.runPromise(application.review.command(command).pipe(Effect.flip))).message,
      ).toContain("cloud review owns");
      remotelyReady = true;

      if (legacyPhase === "dispatching") {
        expect((await runtime.runPromise(application.cloud.status))?.syncFailure?.reason).toBe(
          "incompatible",
        );
        expect(downloads).toBe(0);
        await runtime.runPromise(application.cloudSync.retry);
      }

      await Effect.runPromise(PubSub.publish(notifications, undefined));

      await runtime.runPromise(Deferred.await(downloadStarted).pipe(Effect.timeout("5 seconds")));

      try {
        const duringDownload = await runtime.runPromise(
          application.review.snapshot(projectId, 0).pipe(Effect.timeout("2 seconds")),
        );

        expect(duringDownload.messages).toHaveLength(1);
        expect(
          (await runtime.runPromise(application.review.command(command).pipe(Effect.flip))).message,
        ).toContain("maintenance");
      } finally {
        await runtime.runPromise(Deferred.succeed(downloadContinue, undefined));
      }

      if (corrupt) {
        const failedSync = await runtime.runPromise(
          application.cloudSync.observe.pipe(
            Stream.filter((update) => update.error !== null),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("5 seconds"),
          ),
        );

        const failure = failedSync[0]?.error;

        expect(failure?.reason).toBe("incompatible");
        expect(failure?.message).toContain("hash");
        expect((await runtime.runPromise(application.cloud.status))?.phase).toBe("ready");
        expect(stopped).toBe(true);
        expect(downloads).toBe(1);
        expect(checkpoints).toEqual([started.id]);
        expect(
          (await runtime.runPromise(application.review.command(command).pipe(Effect.flip))).message,
        ).toContain("cloud review owns");
        await runtime.dispose();
        runtime = openApplication(config, sandbox);
        application = await runtime.runPromise(Application);
        await runtime.runPromise(application.cloud.cancel(started.id));
        expect(
          (await runtime.runPromise(application.review.snapshot(projectId, 0))).messages,
        ).toHaveLength(1);
        await runtime.runPromise(application.review.command(command));

        return;
      }

      const synced = await runtime.runPromise(
        application.cloudSync.observe.pipe(
          Stream.filter((update) => update.status?.phase === "imported" || update.error !== null),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(synced[0]?.error).toBeNull();
      expect(synced[0]?.status?.phase).toBe("imported");
      expect(stopped).toBe(true);
      expect(downloads).toBe(1);
      expect(checkpoints).toEqual([started.id]);
      const restored = await runtime.runPromise(application.review.snapshot(projectId, 0));
      expect(
        restored.messages.some((message) => message.text.startsWith("Cloud result imported")),
      ).toBe(true);
      expect(restored.revisions[0]?.sha256).toBe(state.revisions[0]?.sha256);
      expect(restored.facts).toHaveLength(0);
      expect(restored.sheets.every((sheet) => sheet.coverage === "partial")).toBe(true);
      await runtime.runPromise(application.review.command(command));
      expect(dispatched).toBe(1);
      expect((await runtime.runPromise(application.cloud.start(request))).phase).toBe("imported");
      await runtime.dispose();
      runtime = openApplication(config, sandbox);
      application = await runtime.runPromise(Application);
      expect((await runtime.runPromise(application.cloud.status))?.phase).toBe("imported");
      expect(dispatched).toBe(1);
      expect(downloads).toBe(1);
    } finally {
      await runtime.dispose();
      await remote?.dispose();
      await Effect.runPromise(PubSub.shutdown(notifications));
      await rm(root, { recursive: true, force: true });
      await rm(`${data}.cloud`, { recursive: true, force: true });
    }
  },
  30000,
);

test.each(["legacy", "whole_set", "selected_sheets", "discipline", "legacy_worker"] as const)(
  "a cloud drawing-set review preserves %s scope and returns its real packet without a count check",
  async (scopeMode) => {
    const root = await mkdtemp(join(tmpdir(), "moke-cloud-packet-"));
    const notifications = Effect.runSync(PubSub.unbounded<void>());
    let remote: Awaited<ReturnType<typeof openPacketFixture>> | undefined;
    let local: ReturnType<typeof openApplication> | undefined;
    let localApplication: Application["Service"] | undefined;

    let latest: Omit<typeof CloudWorkerProgress.Type, "id" | "identity"> = {
      phase: "accepted",
      execution: null,
      message: "Waiting",
    };

    let ready = false;
    let stopped = false;
    let dispatched = 0;
    let modelCalls = 0;
    const input = join(root, "input");
    const output = join(root, "output");
    const data = join(root, "local");

    const base = {
      migrationDirectory: resolve("migrations"),
      token: Redacted.make("t".repeat(32)),
    };

    const meta = Schema.decodeUnknownSync(InferenceConfiguration)({
      provider: "meta",
      apiKey: "test-meta-secret",
      baseUrl: "https://api.meta.ai/v1",
      model: "muse-spark-1.3",
    });

    const baseten = Schema.decodeUnknownSync(InferenceConfiguration)({
      provider: "baseten",
      apiKey: "test-baseten-secret",
      baseUrl: "https://inference.baseten.co/v1",
      model: "meta-models/muse-spark-open-1026",
    });

    const port: CloudSandboxPort = {
      preflight: () => Effect.void,
      changes: () => Stream.fromPubSub(notifications),
      allocate: () => Effect.succeed("packet-sandbox"),
      upload: (_record, source) =>
        Effect.promise(async () => {
          await cp(source, input, { recursive: true });
          expect(await readFile(join(input, "manifest.json"), "utf8")).not.toContain(
            "test-meta-secret",
          );

          return "input-snapshot";
        }),
      dispatch: (record, provider, alternatives) =>
        Effect.promise(async () => {
          expect(provider.provider).toBe("baseten");
          expect(alternatives.map((item) => item.provider)).toEqual(["meta"]);
          expect("kind" in record.request).toBe(true);
          dispatched++;

          const workerRequest = Schema.decodeUnknownSync(Schema.fromJsonString(CloudWorkerRequest))(
            JSON.stringify({
              id: record.id,
              identity: cloudEngineIdentity,
              request: record.request,
              timeoutMs: 60_000,
            }),
          );

          const restore = openApplication(
            new BackendConfig({ ...base, dataDirectory: join(root, "remote") }),
          );

          try {
            const app = await restore.runPromise(Application);
            await restore.runPromise(app.restorePackage(input));
          } finally {
            await restore.dispose();
          }

          remote = await openPacketFixture(
            join(root, "remote"),
            async () => {
              modelCalls++;

              return chatResponse(
                "Electrical review needs the governing permit edition. No source findings were verified.",
              );
            },
            false,
          );

          if (localApplication === undefined) throw new Error("Missing local application");
          await remote.run(
            runCloudReview(
              {
                execution: localApplication.execution,
                packets: remote.packets,
                exportPackage: remote.exportPackage,
              },
              workerRequest.request,
              60_000,
              output,
              (progress) =>
                Effect.sync(() => {
                  latest = progress;
                }),
            ),
          );
          expect(latest.phase).toBe("ready");
          const journals = join(remote.directory, "execution-journals");
          const files = (await readdir(journals)).filter((name) => name.endsWith(".sqlite"));
          expect(files).toHaveLength(1);

          for (const name of files) {
            const database = new DatabaseSync(join(journals, name), { readOnly: true });

            try {
              expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
                journal_mode: "delete",
              });
              expect(
                database
                  .prepare("SELECT count(*) AS n FROM review_journal_identity WHERE id=1")
                  .get(),
              ).toEqual({ n: 1 });
            } finally {
              database.close();
            }
          }
        }),
      progress: (record) =>
        Effect.map(
          parseCloudWorkerProgress(
            record,
            JSON.stringify({
              ...latest,
              id: record.id,
              identity: {
                ...cloudEngineIdentity,
                protocol:
                  scopeMode === "legacy_worker" && record.workerProtocol === undefined ? 2 : 3,
              },
              phase: ready ? "ready" : "running",
            }),
          ),
          (progress) => ({
            progress,
            resultSnapshotId: progress.phase === "ready" ? "result-snapshot" : null,
            sourceStopped: scopeMode === "legacy_worker" && ready,
          }),
        ),
      download: (_record, destination) =>
        Effect.promise(() => cp(output, destination, { recursive: true })),
      stop: () =>
        Effect.sync(() => {
          stopped = true;
        }),
    };

    const config = new BackendConfig({
      ...base,
      dataDirectory: data,
      inference: meta,
      inferenceAlternatives: [baseten],
      modal: Schema.decodeUnknownSync(ModalConfiguration)({
        tokenId: "test",
        tokenSecret: "test",
        appName: "test",
        environment: "main",
        imageName: "test:one",
        timeoutMinutes: 15,
        poolQueue: null,
      }),
    });

    const sandbox = Layer.succeed(CloudSandbox, port);

    try {
      // Seed the same real PDF/project fixture, then transfer ownership to the application.
      const seed = await openPacketFixture(data, async () =>
        chatResponse("No model call expected"),
      );

      let source = await seed.snapshot();
      const selectedSheet = source.sheets[0];

      if (!selectedSheet) throw new Error("Missing scope fixture sheet");
      await seed.command(
        ReviewCommand.cases.AssignSheetDiscipline.make({
          commandId: id(),
          projectId: seed.projectId,
          expectedVersion: source.project?.version ?? -1,
          sheetIds: [selectedSheet.id],
          discipline: "electrical",
        }),
      );
      source = await seed.snapshot();
      await seed.importPdf({
        commandId: id(),
        projectId: seed.projectId,
        expectedVersion: source.project?.version ?? -1,
        source: join(data, "Drawing packet.pdf"),
        name: "Later revision excluded by explicit scope",
      });
      const inventory = await seed.snapshot();

      const unscopedRequest = await seed.request("Review the electrical drawing set", {
        model: "meta-models/muse-spark-open-1026",
        discipline: "electrical",
        maxCalls: 2,
      });

      const request =
        scopeMode === "legacy" || scopeMode === "legacy_worker"
          ? unscopedRequest
          : {
              ...unscopedRequest,
              selection: {
                mode: scopeMode,
                revisionId: selectedSheet.revisionId,
                sheetIds: scopeMode === "selected_sheets" ? [selectedSheet.id] : [],
              },
            };

      await seed.dispose();
      local = openApplication(config, sandbox);
      localApplication = await local.runPromise(Application);

      const started = await local.runPromise(
        localApplication.cloud.start({
          ...request,
          kind: "packet" as const,
          transferScope: "whole-application",
        }),
      );

      expect(started.findingId).toBeNull();

      const steering = {
        commandId: id(),
        projectId: request.projectId,
        reviewId: "remote",
        conversationId: request.conversationId,
        text: "Do not send this instruction to local mirrored state",
      };

      const fencedSteering = await local.runPromise(
        localApplication.packets.steer(steering).pipe(Effect.flip),
      );

      expect(fencedSteering.reason).toBe("conflict");
      expect(fencedSteering.message).toContain("cloud review owns");
      expect(
        (await local.runPromise(localApplication.packets.start(request).pipe(Effect.flip))).reason,
      ).toBe("conflict");
      expect(
        (
          await local.runPromise(
            localApplication.packets
              .control({
                projectId: request.projectId,
                reviewId: "remote",
                expectedVersion: 0,
                action: "cancel",
                commandId: id(),
              })
              .pipe(Effect.flip),
          )
        ).reason,
      ).toBe("conflict");
      expect(
        (
          await local.runPromise(
            localApplication.packets
              .complete({
                projectId: request.projectId,
                reviewId: "remote",
                findingId: "finding",
                completed: true,
                expectedVersion: 0,
              })
              .pipe(Effect.flip),
          )
        ).reason,
      ).toBe("conflict");

      if (scopeMode === "legacy_worker") {
        await local.dispose();
        await saveLegacyCloudReceipt(data, "running");
        ready = true;
        local = openApplication(config, sandbox);
        localApplication = await local.runPromise(Application);
      } else {
        ready = true;
      }

      await Effect.runPromise(PubSub.publish(notifications, undefined));
      await local.runPromise(
        localApplication.cloudSync.observe.pipe(
          Stream.filter((update) => update.status?.phase === "imported"),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("10 seconds"),
        ),
      );
      expect(stopped).toBe(true);
      const reviews = await local.runPromise(localApplication.packets.list(request.projectId));
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.model).toBe(request.model);
      expect(reviews[0]?.scope._tag).toBe(
        scopeMode === "legacy" || scopeMode === "legacy_worker" || scopeMode === "discipline"
          ? "Discipline"
          : scopeMode === "selected_sheets"
            ? "SelectedSheets"
            : "WholeSet",
      );

      const expectedSheets =
        scopeMode === "legacy" || scopeMode === "legacy_worker"
          ? inventory.sheets
          : source.sheets.filter(
              (sheet) => scopeMode === "whole_set" || sheet.id === selectedSheet.id,
            );

      expect(reviews[0]?.sheets.map((sheet) => sheet.id).toSorted()).toEqual(
        expectedSheets.map((sheet) => sheet.id).toSorted(),
      );
      expect(reviews[0]?.sheets.find((sheet) => sheet.id === selectedSheet.id)?.discipline).toBe(
        "electrical",
      );
      expect(reviews[0]?.summary).toContain("governing permit edition");
      expect(
        (await local.runPromise(localApplication.review.snapshot(request.projectId, 0))).findings,
      ).toHaveLength(0);
      expect(dispatched).toBe(1);
      expect(modelCalls).toBe(1);
      await local.dispose();
      local = openApplication(config, sandbox);
      localApplication = await local.runPromise(Application);
      expect((await local.runPromise(localApplication.cloud.status))?.phase).toBe("imported");
      expect(
        (await local.runPromise(localApplication.packets.list(request.projectId)))[0]?.summary,
      ).toContain("governing permit edition");
      expect(dispatched).toBe(1);
      expect(modelCalls).toBe(1);
    } finally {
      await local?.dispose();
      await remote?.dispose();
      await Effect.runPromise(PubSub.shutdown(notifications));
      await rm(root, { recursive: true, force: true });
      await rm(`${data}.cloud`, { recursive: true, force: true });
    }
  },
  30000,
);
