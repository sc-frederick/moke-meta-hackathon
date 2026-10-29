import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, PubSub, Redacted, Schema, Stream } from "effect";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, type ApplicationEntry } from "../../backend/application.ts";
import { CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { cloudEngineIdentity, type CloudWorkerProgress } from "../../backend/cloud/contracts.ts";
import { BackendConfig, ModalConfiguration, InferenceConfiguration } from "#lib/backend-rpc.ts";
import { CommandId, FindingId, ReviewCommand } from "#lib/review/contracts.ts";
import { ExecutionBudget } from "#lib/review/execution.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { cloudPackageLimits } from "../../backend/cloud/transfer.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";

import { open as openPacketFixture, chatResponse } from "../fixtures/packet-review.ts";
import { runCloudReview } from "../../backend/cloud/worker-review.ts";

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

test.each([false, true])(
  "the application fences writes across reopen and handles real returned packages (corrupt: %s)",
  async (corrupt) => {
    const root = await mkdtemp(join(tmpdir(), "moke-cloud-workspace-"));
    const data = join(root, "local");
    const remoteData = join(root, "remote");
    const uploaded = join(root, "uploaded");
    const returned = join(root, "returned");
    let dispatched = 0;
    let stopped = false;
    let remotelyReady = false;
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
      changes: () => Stream.fromPubSub(notifications),
      allocate: () => Effect.succeed("local-test-sandbox"),
      upload: (_record, source) =>
        Effect.tryPromise({
          try: async () => {
            await cp(source, uploaded, { recursive: true });
            const manifest = await readFile(join(uploaded, "manifest.json"), "utf8");
            expect(manifest).not.toContain("secret-sentinel");

            return "test-input-snapshot";
          },
          catch: () =>
            new CloudReviewError({ reason: "unavailable", message: "Test upload failed" }),
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
        Effect.succeed({
          progress: {
            id: record.id,
            identity: cloudEngineIdentity,
            phase: remotelyReady ? "ready" : "running",
            execution: null,
            message: "Test review ready",
          },
          resultSnapshotId: remotelyReady ? "test-result-snapshot" : null,
          sourceStopped: false,
        }),
      download: (_record, destination) =>
        Effect.promise(async () => {
          await cp(returned, destination, { recursive: true });

          if (corrupt) {
            const path = join(destination, "app.sqlite");
            const bytes = await readFile(path);
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            await writeFile(path, bytes);
          }
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

      const started = await runtime.runPromise(application.cloud.start(request));
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

      await runtime.dispose();
      runtime = openApplication(config, sandbox);
      application = await runtime.runPromise(Application);
      expect((await runtime.runPromise(application.cloud.status))?.id).toBe(started.id);
      expect(
        (await runtime.runPromise(application.review.command(command).pipe(Effect.flip))).message,
      ).toContain("cloud review owns");
      remotelyReady = true;
      await Effect.runPromise(PubSub.publish(notifications, undefined));

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

      await runtime.runPromise(
        application.cloudSync.observe.pipe(
          Stream.filter((update) => update.status?.phase === "imported"),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
        ),
      );
      expect(stopped).toBe(true);
      const restored = await runtime.runPromise(application.review.snapshot(projectId, 0));
      expect(
        restored.messages.some((message) => message.text.startsWith("Cloud result imported")),
      ).toBe(true);
      expect(restored.revisions[0]?.sha256).toBe(state.revisions[0]?.sha256);
      expect(restored.facts).toHaveLength(0);
      expect(restored.sheets.every((sheet) => sheet.coverage === "partial")).toBe(true);
      await runtime.runPromise(application.review.command(command));
      expect(dispatched).toBe(1);
    } finally {
      await runtime.dispose();
      await remote?.dispose();
      await Effect.runPromise(PubSub.shutdown(notifications));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test("a drawing-set review uses the selected provider and returns its real packet without a count check", async () => {
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
  const base = { migrationDirectory: resolve("migrations"), token: Redacted.make("t".repeat(32)) };

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
        const packet = remote;
        await remote.run(
          runCloudReview(
            {
              execution: localApplication.execution,
              packets: remote.packets,
              exportPackage: (destination, limits) =>
                packet.exportPackage(destination, limits).pipe(
                  Effect.tapError(() =>
                    Effect.promise(async () => {
                      const journals = join(packet.directory, "execution-journals");

                      for (const name of await readdir(journals)) {
                        if (!name.endsWith(".sqlite")) continue;
                        const database = new DatabaseSync(join(journals, name), { readOnly: true });

                        try {
                          console.error("packet_journal_diagnostic", {
                            file: name,
                            tables: database
                              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                              .all(),
                            identity: database
                              .prepare(
                                "SELECT journal_id,format FROM review_journal_identity WHERE id=1",
                              )
                              .get(),
                          });
                        } catch (cause) {
                          console.error("packet_journal_diagnostic", {
                            file: name,
                            error: String(cause),
                          });
                        } finally {
                          database.close();
                        }
                      }
                    }),
                  ),
                ),
            },
            record.request,
            60_000,
            output,
            (progress) =>
              Effect.sync(() => {
                latest = progress;
              }),
          ),
        );
        expect(latest.phase).toBe("ready");
      }),
    progress: (record) =>
      Effect.succeed({
        progress: {
          ...latest,
          id: record.id,
          identity: cloudEngineIdentity,
          phase: ready ? "ready" : "running",
        },
        resultSnapshotId: ready ? "result-snapshot" : null,
        sourceStopped: false,
      }),
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
    const seed = await openPacketFixture(data, async () => chatResponse("No model call expected"));

    const request = await seed.request("Review the electrical drawing set", {
      model: "meta-models/muse-spark-open-1026",
      discipline: "electrical",
      maxCalls: 2,
    });

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
    ready = true;
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
    expect(reviews[0]?.scope._tag).toBe("Discipline");
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
  } finally {
    await local?.dispose();
    await remote?.dispose();
    await Effect.runPromise(PubSub.shutdown(notifications));
    await rm(root, { recursive: true, force: true });
    await rm(`${data}.cloud`, { recursive: true, force: true });
  }
}, 30000);
