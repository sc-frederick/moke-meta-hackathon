import { Effect, Layer, Logger, ManagedRuntime, Redacted, Schema } from "effect";
import { mkdir, open, readFile } from "node:fs/promises";
import { BackendConfig } from "#lib/backend-rpc.ts";
import { Application, type ApplicationEntry } from "../application.ts";
import {
  CloudProviders,
  CloudWorkerRequest,
  cloudEngineIdentity,
  type CloudWorkerProgress,
} from "./contracts.ts";
import { writeCloudFile } from "./files.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { runCloudReview } from "./worker-review.ts";

const failed = () =>
  new CloudReviewError({
    reason: "unavailable",
    message:
      "The cloud review stopped before it could produce a complete package. Confirm it has stopped before returning to local work; prior model calls may have been charged.",
  });

const main = Effect.scoped(
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile("/moke/request.json", "utf8"),
      catch: failed,
    });

    const job = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudWorkerRequest))(text);

    const [provider, ...alternatives] = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CloudProviders),
    )(process.env.MOKE_CLOUD_PROVIDERS);

    // This exclusive marker fences even two exec requests with an ambiguous delivery outcome.
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir("/moke", { recursive: true, mode: 0o700 });
        const file = await open("/moke/dispatch.lock", "wx", 0o600);

        try {
          await file.writeFile(job.id);
          await file.sync();
        } finally {
          await file.close();
        }
      },
      catch: failed,
    });

    const progress = (update: Omit<typeof CloudWorkerProgress.Type, "id" | "identity">) =>
      writeCloudFile(
        "/moke/progress.json",
        JSON.stringify({ id: job.id, identity: cloudEngineIdentity, ...update }),
      );

    const work = Effect.gen(function* () {
      yield* progress({
        phase: "accepted",
        execution: null,
        message: "The cloud worker accepted this review. Local editing remains paused.",
      });

      const config = new BackendConfig({
        dataDirectory: "/moke/workspace",
        migrationDirectory: "/opt/moke/migrations",
        token: Redacted.make(crypto.randomUUID()),
        inference: provider,
        inferenceAlternatives: alternatives,
        processing: {
          workerCommand: ["bun", "/opt/moke/pdf-worker.mjs"],
          assetsDirectory: "/opt/moke/node_modules/pdfjs-dist",
          nativeLibraryPath:
            "/opt/moke/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node",
        },
      });

      let callbacks: ApplicationEntry | undefined;

      const entry: ApplicationEntry = {
        runPromise: (operation, options) =>
          callbacks === undefined
            ? Promise.reject(failed())
            : callbacks.runPromise(operation, options),
      };

      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          ManagedRuntime.make(
            Application.layer(config, entry).pipe(Layer.provide(Logger.layer([]))),
          ),
        ),
        (runtime) => Effect.promise(() => runtime.dispose()),
      );

      callbacks = runtime;
      const application = yield* Effect.promise(() => runtime.runPromise(Application));
      yield* Effect.promise(() => runtime.runPromise(application.restorePackage("/moke/input")));

      yield* Effect.promise(() =>
        runtime.runPromise(
          runCloudReview(application, job.request, job.timeoutMs, "/moke/output", progress),
        ),
      );
    });

    yield* work.pipe(
      Effect.catchCause(() =>
        progress({ phase: "failed", execution: null, message: failed().message }),
      ),
    );
  }),
);

if (process.argv.includes("--identity")) {
  console.log(JSON.stringify(cloudEngineIdentity));
} else if (import.meta.main) {
  await Effect.runPromise(main.pipe(Effect.provide(Logger.layer([])))).catch(() => {
    process.exitCode = 1;
  });
}
