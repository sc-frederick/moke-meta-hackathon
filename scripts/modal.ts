import { Effect, Option, Redacted, Result, Schema } from "effect";
import { ModalClient } from "modal";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readModalConfiguration } from "../desktop/modal-credentials.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import {
  CloudEngineIdentity,
  WarmSandboxMessage,
  cloudEngineIdentity,
} from "../backend/cloud/contracts.ts";
import { emptyReviewOutboundPolicy, modalReadinessProbe } from "../backend/cloud/modal.ts";

const failed = () =>
  new CloudReviewError({
    reason: "unavailable",
    message:
      "Modal setup failed. Check the account, image name, environment, and available credits.",
  });

const call = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: failed });

const main = Effect.scoped(
  Effect.gen(function* () {
    const action = process.argv[2];

    if (action !== "image" && action !== "warm")
      return yield* new CloudReviewError({
        reason: "configuration",
        message:
          "Usage: bun run modal:image | bun run modal:warm. Image publishes the current engine; warm prepares one single-use sandbox for a short demo window.",
      });
    const config = yield* readModalConfiguration(false);

    if (config === undefined)
      return yield* new CloudReviewError({
        reason: "configuration",
        message:
          "Configure Modal using MOKE_MODAL_CONFIG or MODAL_TOKEN_ID and MODAL_TOKEN_SECRET first. See docs/cloud-reviews.md.",
      });

    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new ModalClient({
            tokenId: Redacted.value(config.tokenId),
            tokenSecret: Redacted.value(config.tokenSecret),
            environment: config.environment,
            maxRetries: 0,
            logLevel: "error",
          }),
      ),
      (client) => Effect.sync(() => client.close()),
    );

    const app = yield* call(() =>
      client.apps.fromName(config.appName, {
        createIfMissing: true,
        environment: config.environment,
      }),
    );

    if (action === "image") {
      const output = resolve("dist/cloud");

      const builds = yield* call(() =>
        Bun.build({
          entrypoints: ["backend/cloud/worker-main.ts", "backend/documents/pdf-worker-main.ts"],
          outdir: output,
          naming: "[name].mjs",
          target: "bun",
          external: ["@napi-rs/canvas", "pdfjs-dist"],
        }),
      );

      if (!builds.success) return yield* failed();

      // All tooling and both workloads use Bun; no Python deployment script or public source upload.
      const base = client.images
        .fromRegistry("oven/bun:1.4.4")
        .dockerfileCommands([
          "WORKDIR /opt/moke",
          "RUN bun add --exact @napi-rs/canvas@1.0.13 @napi-rs/canvas-linux-x64-gnu@1.0.13 pdfjs-dist@6.4.299",
        ]);

      const image = yield* call(() => base.build(app));

      const sandbox = yield* Effect.acquireRelease(
        call(() =>
          client.sandboxes.create(app, image, {
            command: ["sleep", "infinity"],
            timeoutMs: 300_000,
            cpu: 1,
            memoryMiB: 2048,
            blockNetwork: true,
          }),
        ),
        (sandbox) => call(() => sandbox.terminate({ wait: true })).pipe(Effect.ignore),
      );

      yield* call(() =>
        sandbox.filesystem.copyFromLocal(join(output, "worker-main.mjs"), "/opt/moke/worker.mjs"),
      );
      yield* call(() =>
        sandbox.filesystem.copyFromLocal(
          join(output, "pdf-worker-main.mjs"),
          "/opt/moke/pdf-worker.mjs",
        ),
      );
      const migrations = yield* call(() => readdir("migrations"));

      for (const file of migrations.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort())
        yield* call(() =>
          sandbox.filesystem.copyFromLocal(
            join("migrations", file),
            `/opt/moke/migrations/${file}`,
          ),
        );

      const text = yield* call(async () => {
        const process = await sandbox.exec(["bun", "/opt/moke/worker.mjs", "--identity"]);
        const text = await process.stdout.readText();

        if ((await process.wait()) !== 0) throw failed();

        return text.trim();
      });

      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudEngineIdentity))(text);
      const built = yield* call(() => sandbox.snapshotFilesystem({ ttlMs: null }));
      yield* call(() => built.publish(config.imageName));
      console.log(`Published ${config.imageName}. No drawings or model credentials were included.`);

      return;
    }

    if (config.poolQueue === null)
      return yield* new CloudReviewError({
        reason: "configuration",
        message:
          "Set MOKE_MODAL_POOL_QUEUE to opt into a warm sandbox. Warm capacity uses credits even before a review starts.",
      });

    const queue = yield* call(() =>
      client.queues.fromName(config.poolQueue ?? "", { createIfMissing: true }),
    );

    // One bounded warm candidate, with no scheduler or background replenishment.
    const alreadyWarm = yield* call(async () => {
      for await (const raw of queue.iterate()) {
        const candidate = Schema.decodeUnknownOption(WarmSandboxMessage)(raw);

        if (
          Option.isSome(candidate) &&
          candidate.value.imageName === config.imageName &&
          candidate.value.expiresAt > Date.now()
        )
          return true;
      }

      return false;
    });

    if (alreadyWarm) {
      console.log("A warm sandbox is already available; no additional capacity was started.");

      return;
    }

    const image = yield* call(() => client.images.fromName(config.imageName));
    const ttlMs = Math.min(3_900_000, config.timeoutMinutes * 60_000 + 600_000);
    const createdAt = Date.now();

    const sandbox = yield* call(() =>
      client.sandboxes.create(app, image, {
        command: ["sleep", "infinity"],
        timeoutMs: ttlMs,
        cpu: 1,
        cpuLimit: 1,
        memoryMiB: 2048,
        memoryLimitMiB: 2048,
        experimentalOptions: { enable_exit_snapshot: true },
        experimentalOutboundPolicy: emptyReviewOutboundPolicy(),
        readinessProbe: modalReadinessProbe(),
        tags: { "moke-kind": "warm" },
      }),
    );

    const offered = yield* Effect.result(
      call(async () => {
        await sandbox.waitUntilReady(30_000);
        await queue.put(
          Schema.encodeSync(WarmSandboxMessage)({
            sandboxId: sandbox.sandboxId,
            imageName: config.imageName,
            identity: cloudEngineIdentity,
            expiresAt: createdAt + ttlMs,
          }),
          { timeoutMs: 1000, partitionTtlMs: ttlMs },
        );
      }),
    );

    if (Result.isFailure(offered)) {
      yield* call(() => sandbox.terminate()).pipe(Effect.ignore);

      return yield* failed();
    }

    sandbox.detach();
    console.log(
      `One warm sandbox is available for approximately ${Math.round(ttlMs / 60_000)} minutes. It will be discarded after one review.`,
    );
  }),
);

await Effect.runPromise(main).catch(() => {
  console.error(
    "Modal setup did not finish. See docs/cloud-reviews.md and check the private Modal configuration.",
  );
  process.exitCode = 1;
});
