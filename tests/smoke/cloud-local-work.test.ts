import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Redacted, Schema, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, type ApplicationEntry } from "../../backend/application.ts";
import { CloudSandbox } from "../../backend/cloud/service.ts";
import type { CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { BackendConfig, InferenceConfiguration, ModalConfiguration } from "#lib/backend-rpc.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import { open as openPacketFixture, response, until } from "../fixtures/packet-review.ts";

test("the cloud estimate names projects whose local reviews must finish first", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-cloud-local-work-"));
  const data = join(root, "local");

  // A call budget of one pauses a real local review after its first receipted request.
  const fixture = await openPacketFixture(data, async () =>
    response([{ name: "inventory_packet", arguments: {} }]),
  );

  const request = await fixture.request("Perform a packet QA pass.", { maxCalls: 1 });
  const started = await fixture.run(fixture.packets.start(request));
  await until(fixture, started.id, "paused");
  await fixture.dispose();

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

  // No sandbox work is reached: setup only preflights and estimates the local workspace.
  const unused = Effect.die("Cloud sandbox work is outside this setup test.");

  const port: CloudSandboxPort = {
    preflight: () => Effect.void,
    changes: () => Stream.empty,
    allocate: () => unused,
    upload: () => unused,
    dispatch: () => unused,
    progress: () => unused,
    download: () => unused,
    stop: () => unused,
  };

  let callbacks: ApplicationEntry | undefined;

  const entry: ApplicationEntry = {
    runPromise: (operation, options) =>
      callbacks === undefined
        ? Promise.reject(new Error("Test runtime is not ready"))
        : callbacks.runPromise(operation, options),
  };

  const runtime = ManagedRuntime.make(
    Application.layer(config, entry, Layer.succeed(CloudSandbox, port)),
  );

  callbacks = runtime;

  try {
    const application = await runtime.runPromise(Application);
    const blocked = await runtime.runPromise(application.cloud.setup);
    expect(blocked.workspaceEstimateError).toBeUndefined();
    expect(blocked.workspaceEstimate?.localReviews).toEqual(["Packet QA fixture"]);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
