import { Clock, Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  ExperimentalOutboundPolicy,
  ModalClient,
  NotFoundError,
  Probe,
  QueueEmptyError,
  SandboxFilesystemNotFoundError,
  type Sandbox,
} from "modal";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModalConfiguration } from "#lib/backend-rpc.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import {
  CloudEngineIdentity,
  CloudProvider,
  CloudWorkerProgress,
  WarmSandbox,
  WarmSandboxMessage,
  cloudEngineIdentity,
  type CloudReviewRecord,
} from "./contracts.ts";
import { CloudSandbox } from "./service.ts";
import { parseCloudManifest } from "./transfer.ts";

const ModalFileChange = Schema.Struct({
  eventType: Schema.Literals(["Access", "Create", "Modify", "Remove", "Unknown"]),
  paths: Schema.Array(Schema.String),
});

const unavailable = () =>
  new CloudReviewError({
    reason: "unavailable",
    message:
      "The cloud service could not confirm this action. Refresh to reconnect; the review will not be started again automatically.",
  });

class MissingModalSandbox extends Schema.TaggedError<MissingModalSandbox>()(
  "MissingModalSandbox",
  {},
) {}

const sandboxResult = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof NotFoundError ||
      Schema.is(Schema.Struct({ name: Schema.Literal("ClientError"), code: Schema.Literal(5) }))(
        error,
      )
        ? new MissingModalSandbox({})
        : unavailable(),
  });

/** A missing warm candidate is disposable; other polling failures retain ownership. */
export const pollWarmSandbox = (poll: () => Promise<number | null>) =>
  sandboxResult(poll).pipe(
    Effect.map((exit) => exit === null),
    Effect.catchTag("MissingModalSandbox", () => Effect.succeed(false)),
  );

/** Explicit provider absence confirms stop; unreachable or unauthorized resources remain fenced. */
export const confirmModalSandboxStopped = (stopAndPoll: () => Promise<number | null>) =>
  sandboxResult(stopAndPoll).pipe(
    Effect.flatMap((exit) => (exit === null ? Effect.fail(unavailable()) : Effect.void)),
    Effect.catchTag("MissingModalSandbox", () => Effect.void),
  );

class ModalRequestFailure extends Schema.TaggedError<ModalRequestFailure>()("ModalRequestFailure", {
  category: Schema.String,
  message: Schema.String,
}) {}

/** Readiness checks use the worker itself, without exposing a public HTTP tunnel. */
export const modalReadinessProbe = () =>
  Probe.withExec(["bun", "/opt/moke/worker.mjs", "--identity"]);

/** Pooled sandboxes start without credentials and can later receive an outbound policy. */
export const emptyReviewOutboundPolicy = () =>
  new ExperimentalOutboundPolicy().withHeaderReplacement({
    domain: "api.meta.ai",
    headers: { "X-Moke-Sandbox": "review" },
  });

/** Official Modal SDK adapter; API keys are injected into outbound HTTPS outside the workload. */
export const modalSandboxLayer = (
  config: typeof ModalConfiguration.Type,
  providerKey?: Redacted.Redacted<string>,
) =>
  Layer.effect(
    CloudSandbox,
    Effect.gen(function* () {
      const secrets =
        providerKey === undefined
          ? [config.tokenId, config.tokenSecret]
          : [config.tokenId, config.tokenSecret, providerKey];

      const modalCall = <A>(operation: () => Promise<A>) =>
        Effect.tryPromise({
          try: operation,
          catch: (cause) => {
            let message = cause instanceof Error ? cause.message : "Unclassified SDK failure";

            for (const secret of secrets)
              message = message.replaceAll(Redacted.value(secret), "[redacted]");

            return new ModalRequestFailure({
              category: cause instanceof Error ? cause.name : "unknown",
              message: message.slice(0, 1000),
            });
          },
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("cloud_sdk_failure", {
              category: error.category,
              detail: error.message,
            }),
          ),
          Effect.mapError(unavailable),
        );

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ModalClient({
              tokenId: Redacted.value(config.tokenId),
              tokenSecret: Redacted.value(config.tokenSecret),
              environment: config.environment,
              timeoutMs: 60_000,
              maxRetries: 0,
              logLevel: "error",
            }),
        ),
        (client) => Effect.sync(() => client.close()),
      );

      const original = (record: CloudReviewRecord) =>
        modalCall(() =>
          record.sandboxId === null
            ? client.sandboxes.fromName(record.appName, record.sandboxName, {
                environment: record.environment,
                includeTerminated: true,
              })
            : client.sandboxes.fromId(record.sandboxId),
        );

      const identity = Effect.fn("Modal.identity")(function* (sandbox: Sandbox) {
        const text = yield* modalCall(async () => {
          const process = await sandbox.exec(["bun", "/opt/moke/worker.mjs", "--identity"], {
            timeoutMs: 15_000,
          });

          const output = await process.stdout.readText();

          if ((await process.wait()) !== 0) throw new Error("Worker identity unavailable");

          return output.trim();
        });

        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudEngineIdentity))(text).pipe(
          Effect.mapError(
            () =>
              new CloudReviewError({
                reason: "incompatible",
                message:
                  "The cloud service needs an update before it can review these drawings. Your local workspace is unchanged.",
              }),
          ),
        );
      });

      const allocate = Effect.fn("Modal.allocate")(function* (record: CloudReviewRecord) {
        if (config.poolQueue !== null) {
          const queue = yield* modalCall(() =>
            client.queues.fromName(config.poolQueue ?? "", { createIfMissing: true }),
          );

          for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = yield* Effect.tryPromise({
              try: async () => {
                const value = await queue.get({ timeoutMs: 0 });
                const reference = Schema.Struct({ sandboxId: WarmSandbox.fields.sandboxId });

                return Option.map(
                  Schema.decodeUnknownOption(
                    Schema.Union([Schema.fromJsonString(reference), reference]),
                  )(value),
                  (reference) => ({ ...reference, value }),
                );
              },
              catch: (error) =>
                error instanceof QueueEmptyError
                  ? new CloudReviewError({ reason: "limit", message: "empty" })
                  : unavailable(),
            }).pipe(
              Effect.catch((error) =>
                error.reason === "limit" ? Effect.succeed(Option.none()) : Effect.fail(error),
              ),
            );

            if (Option.isNone(candidate)) continue;

            const sandbox = yield* modalCall(() =>
              client.sandboxes.fromId(candidate.value.sandboxId),
            );

            const live = yield* pollWarmSandbox(() => sandbox.poll()).pipe(
              Effect.tapError(() => modalCall(() => sandbox.terminate({ wait: true }))),
            );

            if (!live) continue;

            const warm = Schema.decodeUnknownOption(WarmSandboxMessage)(candidate.value.value);

            if (
              Option.isNone(warm) ||
              warm.value.imageName !== config.imageName ||
              warm.value.expiresAt < record.expiresAt + 30_000
            ) {
              yield* modalCall(() => sandbox.terminate({ wait: true }));
              continue;
            }

            const compatible = yield* identity(sandbox).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );

            if (!compatible) {
              yield* modalCall(() => sandbox.terminate({ wait: true }));
              continue;
            }

            // Only a compatible candidate claims the durable execution name.
            yield* modalCall(() => sandbox.experimentalSetName(record.sandboxName)).pipe(
              Effect.tapError(() => modalCall(() => sandbox.terminate({ wait: true }))),
            );

            return sandbox.sandboxId;
          }
        }

        const app = yield* modalCall(() =>
          client.apps.fromName(record.appName, {
            createIfMissing: true,
            environment: record.environment,
          }),
        );

        const image = yield* modalCall(() =>
          client.images.fromName(config.imageName, { environment: record.environment }),
        );

        const sandbox = yield* modalCall(() =>
          client.sandboxes.create(app, image, {
            command: ["sleep", "infinity"],
            name: record.sandboxName,
            cpu: 1,
            cpuLimit: 1,
            memoryMiB: 2048,
            memoryLimitMiB: 2048,
            timeoutMs: config.timeoutMinutes * 60_000 + 120_000,
            experimentalOptions: { enable_exit_snapshot: true },
            experimentalOutboundPolicy: emptyReviewOutboundPolicy(),
            readinessProbe: modalReadinessProbe(),
            tags: { "moke-kind": "review", "moke-job": record.id },
          }),
        );

        yield* identity(sandbox).pipe(
          Effect.tapError(() =>
            modalCall(() => sandbox.terminate({ wait: true })).pipe(Effect.ignore),
          ),
        );

        return sandbox.sandboxId;
      });

      // Recovery sandboxes never run the entrypoint or admit inference; only package files are read.
      const readable = Effect.fn("Modal.readable")(function* (record: CloudReviewRecord) {
        if (record.resultSnapshotId !== null) {
          const app = yield* modalCall(() =>
            client.apps.fromName(record.appName, { environment: record.environment }),
          );

          const base = yield* modalCall(() =>
            client.images.fromName(config.imageName, { environment: record.environment }),
          );

          const snapshot = yield* modalCall(() =>
            client.images.fromId(record.resultSnapshotId ?? ""),
          );

          const recovery = yield* modalCall(() =>
            client.sandboxes.create(app, base, {
              command: ["sleep", "infinity"],
              timeoutMs: 120_000,
              blockNetwork: true,
              cpu: 0.25,
              memoryMiB: 512,
            }),
          );

          yield* modalCall(() => recovery.mountImage("/moke/output", snapshot)).pipe(
            Effect.tapError(() => modalCall(() => recovery.terminate()).pipe(Effect.ignore)),
          );

          return { sandbox: recovery, recovery: true, sourceStopped: false };
        }

        const sandbox = yield* original(record);

        if ((yield* modalCall(() => sandbox.poll())) === null)
          return { sandbox, recovery: false, sourceStopped: false };

        const image = yield* modalCall(() =>
          sandbox.experimentalGetExitSnapshot({ timeoutMs: 55_000 }),
        );

        const app = yield* modalCall(() =>
          client.apps.fromName(record.appName, { environment: record.environment }),
        );

        const recovery = yield* modalCall(() =>
          client.sandboxes.create(app, image, {
            command: ["sleep", "infinity"],
            timeoutMs: 120_000,
            blockNetwork: true,
            cpu: 0.25,
            memoryMiB: 512,
          }),
        );

        return { sandbox: recovery, recovery: true, sourceStopped: true };
      });

      const reading = <A>(
        record: CloudReviewRecord,
        use: (sandbox: Sandbox, sourceStopped: boolean) => Effect.Effect<A, CloudReviewError>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* Effect.acquireRelease(readable(record), (handle) =>
              handle.recovery
                ? modalCall(() => handle.sandbox.terminate()).pipe(Effect.ignore)
                : Effect.sync(() => handle.sandbox.detach()),
            );

            return yield* use(handle.sandbox, handle.sourceStopped);
          }),
        );

      return CloudSandbox.of({
        changes: (record) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const sandbox = yield* original(record);
              yield* Effect.addFinalizer(() => Effect.sync(() => sandbox.detach()));

              const iterator = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  sandbox.filesystem
                    .watch("/moke", {
                      recursive: false,
                      filter: ["Create", "Modify"],
                      timeoutMs: 30_000,
                    })
                    [Symbol.asyncIterator](),
                ),
                // The SDK queues return behind a pending next(). Bound local shutdown; the
                // read-only remote watcher also has its own 30-second deadline.
                (iterator) =>
                  Effect.tryPromise({
                    try: async () => {
                      await iterator.return?.();
                    },
                    catch: unavailable,
                  }).pipe(Effect.timeout("2 seconds"), Effect.ignore),
              );

              return Stream.fromAsyncIterable(
                { [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }) },
                unavailable,
              ).pipe(
                Stream.mapEffect((event) =>
                  Schema.decodeUnknownEffect(ModalFileChange)(event).pipe(
                    Effect.mapError(unavailable),
                  ),
                ),
                Stream.filter((event) => event.paths.includes("/moke/progress.json")),
                Stream.map(() => undefined),
              );
            }),
          ),
        allocate,
        upload: (record, source) =>
          Effect.gen(function* () {
            const sandbox = yield* original(record);
            const text = yield* modalCall(() => readFile(join(source, "manifest.json"), "utf8"));
            const { files } = yield* parseCloudManifest(text);

            for (const file of files)
              yield* modalCall(() =>
                sandbox.filesystem.copyFromLocal(
                  join(source, file.path),
                  `/moke/input/${file.path}`,
                ),
              );
            yield* modalCall(() => sandbox.filesystem.writeText(text, "/moke/input/manifest.json"));
            yield* modalCall(() =>
              sandbox.filesystem.writeText(
                JSON.stringify({
                  id: record.id,
                  identity: cloudEngineIdentity,
                  request: record.request,
                  timeoutMs: config.timeoutMinutes * 60_000,
                }),
                "/moke/request.json",
              ),
            );

            const checkpoint = yield* modalCall(() =>
              sandbox.snapshotDirectory("/moke", { ttlMs: 7 * 24 * 60 * 60_000 }),
            );

            return checkpoint.imageId;
          }),
        dispatch: (record, provider, alternatives) =>
          Effect.gen(function* () {
            const sandbox = yield* original(record);
            const now = yield* Clock.currentTimeMillis;
            const remainingMs = Math.floor((record.expiresAt - now) / 1000) * 1000;

            if (remainingMs < 60_000)
              return yield* new CloudReviewError({
                reason: "limit",
                message:
                  "The drawing transfer used the available review time. Stop this cloud review before trying again with a longer time limit.",
              });

            // Transfer and setup consume the same deadline checked when claiming warm capacity.
            yield* modalCall(() =>
              sandbox.filesystem.writeText(
                JSON.stringify({
                  id: record.id,
                  identity: cloudEngineIdentity,
                  request: record.request,
                  timeoutMs: remainingMs,
                }),
                "/moke/request.json",
              ),
            );
            const providers = [provider, ...alternatives];
            let policy = new ExperimentalOutboundPolicy();

            for (const connection of providers) {
              if (
                connection.baseUrl !==
                (connection.provider === "meta"
                  ? "https://api.meta.ai/v1"
                  : "https://inference.baseten.co/v1")
              )
                return yield* new CloudReviewError({
                  reason: "configuration",
                  message: "Cloud reviews require canonical provider endpoints.",
                });

              const secret = yield* modalCall(() =>
                client.secrets.fromName(`${record.appName}-${connection.provider}-api`, {
                  environment: record.environment,
                  requiredKeys: ["MOKE_API_KEY"],
                }),
              );

              policy = policy.withHeaderReplacement({
                domain: new URL(connection.baseUrl).hostname,
                secret,
                headers: { Authorization: "Bearer $MOKE_API_KEY" },
              });
            }

            yield* modalCall(() => sandbox.experimentalUpdateOutboundPolicy(policy));

            const routes = providers.map((connection) =>
              Schema.encodeSync(CloudProvider)({
                ...connection,
                apiKey: Redacted.make("modal-outbound-injection"),
              }),
            );

            yield* modalCall(async () => {
              const process = await sandbox.exec(["bun", "/opt/moke/worker.mjs"], {
                env: { MOKE_CLOUD_PROVIDERS: JSON.stringify(routes) },
                stdout: "ignore",
                stderr: "ignore",
                timeoutMs: remainingMs + 60_000,
              });

              await process.closeStdin();
              sandbox.detach();
            });
          }),
        progress: (record) =>
          reading(record, (sandbox, sourceStopped) =>
            Effect.gen(function* () {
              const text = yield* Effect.tryPromise({
                try: async () => {
                  try {
                    return await sandbox.filesystem.readText("/moke/progress.json");
                  } catch (error) {
                    if (sourceStopped && error instanceof SandboxFilesystemNotFoundError)
                      return JSON.stringify({
                        id: record.id,
                        identity: cloudEngineIdentity,
                        phase: "failed",
                        execution: null,
                        message: "The cloud worker stopped before acknowledging the review.",
                      });
                    throw error;
                  }
                },
                catch: (error) =>
                  error instanceof SandboxFilesystemNotFoundError
                    ? new CloudReviewError({
                        reason: "unavailable",
                        message:
                          "The worker has not acknowledged this review. Refresh to reconnect, or stop it before returning to local work.",
                      })
                    : unavailable(),
              });

              const progress = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(CloudWorkerProgress),
              )(text).pipe(
                Effect.mapError(
                  () =>
                    new CloudReviewError({
                      reason: "incompatible",
                      message:
                        "The cloud service returned unreadable review progress. Refresh to reconnect.",
                    }),
                ),
              );

              const checkpoint =
                progress.phase === "ready"
                  ? yield* modalCall(() =>
                      sandbox.snapshotDirectory("/moke/output", { ttlMs: 7 * 24 * 60 * 60_000 }),
                    )
                  : null;

              return { progress, resultSnapshotId: checkpoint?.imageId ?? null, sourceStopped };
            }),
          ),
        download: (record, destination) =>
          reading(record, (sandbox) =>
            Effect.gen(function* () {
              const text = yield* modalCall(() =>
                sandbox.filesystem.readText("/moke/output/manifest.json"),
              );

              const { files } = yield* parseCloudManifest(text);
              yield* modalCall(() => mkdir(destination, { recursive: true, mode: 0o700 }));

              for (const file of files) {
                const info = yield* modalCall(() =>
                  sandbox.filesystem.stat(`/moke/output/${file.path}`),
                );

                if (info.type !== "file" || info.size !== file.bytes)
                  return yield* new CloudReviewError({
                    reason: "incompatible",
                    message: "A cloud package file changed before download.",
                  });
                yield* modalCall(() =>
                  sandbox.filesystem.copyToLocal(
                    `/moke/output/${file.path}`,
                    join(destination, file.path),
                  ),
                );
              }

              yield* modalCall(() => Bun.write(join(destination, "manifest.json"), text));
            }),
          ),
        stop: (record) =>
          confirmModalSandboxStopped(async () => {
            const sandbox = await (record.sandboxId === null
              ? client.sandboxes.fromName(record.appName, record.sandboxName, {
                  environment: record.environment,
                  includeTerminated: true,
                })
              : client.sandboxes.fromId(record.sandboxId));

            await sandbox.terminate({ wait: true });

            return sandbox.poll();
          }),
      });
    }),
  );
