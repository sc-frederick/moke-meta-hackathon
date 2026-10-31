import { Clock, Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  ExperimentalOutboundPolicy,
  ModalClient,
  NotFoundError,
  Probe,
  QueueEmptyError,
  SandboxFilesystemNotFoundError,
  type Sandbox,
  type SandboxCreateParams,
} from "modal";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudCachedFile } from "./cache.ts";
import type { ModalConfiguration } from "#lib/backend-rpc.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import {
  CloudEngineIdentity,
  CloudProvider,
  WarmSandbox,
  WarmSandboxMessage,
  cloudEngineIdentity,
  cloudProviderEndpoints,
  type CloudReviewRecord,
} from "./contracts.ts";
import { CloudSandbox } from "./service.ts";
import { downloadCloudPackage, uploadCloudPackage } from "./transfer.ts";
import { parseCloudWorkerProgress } from "./progress.ts";

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

/** Bounded review capacity shared by cold allocation and optional warm capacity. */
export const modalReviewResources = {
  cpu: 4,
  cpuLimit: 4,
  memoryMiB: 8192,
  memoryLimitMiB: 8192,
} as const;

/** Cache files are named by SHA-256 under this folder of the workspace Volume. */
const cacheFolder = "/cache/sha256";

/** Read back what the cache holds; a sandbox without the mount simply has an empty cache. */
const listCache = (sandbox: Sandbox) =>
  Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<CloudCachedFile>> => {
      try {
        return (await sandbox.filesystem.listFiles(cacheFolder))
          .filter((entry) => entry.type === "file" && /^[a-f0-9]{64}$/.test(entry.name))
          .map((entry) => ({ sha256: entry.name, bytes: entry.size }));
      } catch (error) {
        if (error instanceof SandboxFilesystemNotFoundError) return [];
        throw error;
      }
    },
    catch: unavailable,
  });

/**
 * Staged files become visible only after their bytes match the hash in their name, so a
 * partial or corrupt upload is discarded. `sync` commits a v2 Volume.
 */
const commitCacheScript = `set -eu
mkdir -p ${cacheFolder} /cache/.staging
for staged in /cache/.staging/*.part; do
  [ -e "$staged" ] || continue
  hash=$(basename "$staged" .part)
  if [ "$(sha256sum "$staged" | cut -d' ' -f1)" = "$hash" ]; then mv -f "$staged" "${cacheFolder}/$hash"; else rm -f "$staged"; fi
done
sync /cache`;

/** Copy uploaded snapshot files the cache lacks into staging. Paths are schema-checked names. */
const retainScript = (
  mounts: ReadonlyArray<{
    readonly root: string;
    readonly files: ReadonlyArray<{ readonly sha256: string; readonly path: string }>;
  }>,
) =>
  [
    "set -eu",
    "mkdir -p /cache/.staging",
    ...mounts.flatMap(({ root, files }) =>
      files.map(
        (file) =>
          `[ -f '${cacheFolder}/${file.sha256}' ] || cp -- '${root}/${file.path}' '/cache/.staging/${file.sha256}.part' || true`,
      ),
    ),
  ].join("\n");

/** Delete cached files outside the keep list, which the caller writes to /tmp/moke-keep. */
const pruneCacheScript = `set -eu
mkdir -p ${cacheFolder}
ls -1 ${cacheFolder} | sort > /tmp/moke-have
sort -u /tmp/moke-keep > /tmp/moke-keep-sorted
comm -23 /tmp/moke-have /tmp/moke-keep-sorted | while read -r hash; do rm -f -- "${cacheFolder}/$hash"; done
sync /cache`;

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
              warm.value.resourceProfile !== "4cpu-8gib" ||
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

        // Without the cache mount the upload lists an empty cache and sends every file.
        const cache =
          record.cacheVolume === undefined
            ? null
            : yield* modalCall(() =>
                client.volumes.fromName(record.cacheVolume ?? "", {
                  createIfMissing: true,
                  version: 2,
                  environment: record.environment,
                }),
              ).pipe(
                Effect.map((volume) => ({ "/cache": volume.withMountOptions({ readOnly: true }) })),
                Effect.catch(() => Effect.succeed(null)),
              );

        const params: SandboxCreateParams = {
          command: ["sleep", "infinity"],
          name: record.sandboxName,
          ...modalReviewResources,
          timeoutMs: config.timeoutMinutes * 60_000 + 120_000,
          experimentalOptions: { enable_exit_snapshot: true },
          experimentalOutboundPolicy: emptyReviewOutboundPolicy(),
          readinessProbe: modalReadinessProbe(),
          tags: { "moke-kind": "review", "moke-job": record.id },
        };

        if (cache !== null) params.volumes = cache;

        const sandbox = yield* modalCall(() => client.sandboxes.create(app, image, params));

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

      let compatibleImageId: string | null = null;

      return CloudSandbox.of({
        preflight: (providers) =>
          Effect.gen(function* () {
            const image = yield* modalCall(() =>
              client.images.fromName(config.imageName, { environment: config.environment }),
            ).pipe(
              Effect.mapError(
                () =>
                  new CloudReviewError({
                    reason: "configuration",
                    message:
                      "The selected cloud worker image could not be found or accessed. Check the image and environment in Cloud setup before sending.",
                  }),
              ),
            );

            for (const provider of providers) {
              yield* modalCall(() =>
                client.secrets.fromName(`${config.appName}-${provider.provider}-api`, {
                  environment: config.environment,
                  requiredKeys: ["MOKE_API_KEY"],
                }),
              ).pipe(
                Effect.mapError(
                  () =>
                    new CloudReviewError({
                      reason: "configuration",
                      message: `The cloud ${provider.provider === "baseten" ? "Muse Spark Open" : "Meta"} connection is missing or inaccessible. Configure the matching provider secret with MOKE_API_KEY in Modal before sending. Your workspace has not been uploaded.`,
                    }),
                ),
              );
            }

            if (compatibleImageId !== image.imageId) {
              const app = yield* modalCall(() =>
                client.apps.fromName(config.appName, { environment: config.environment }),
              );

              yield* Effect.scoped(
                Effect.gen(function* () {
                  const probe = yield* Effect.acquireRelease(
                    modalCall(() =>
                      client.sandboxes.create(app, image, {
                        command: ["sleep", "infinity"],
                        timeoutMs: 60_000,
                        blockNetwork: true,
                        cpu: 1,
                        cpuLimit: 1,
                        memoryMiB: 2048,
                        memoryLimitMiB: 2048,
                        tags: { "moke-kind": "preflight" },
                      }),
                    ),
                    (probe) => modalCall(() => probe.terminate({ wait: true })).pipe(Effect.ignore),
                  );

                  yield* identity(probe);
                }),
              );
              compatibleImageId = image.imageId;
            }
          }),
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
        upload: (record, source, report) =>
          Effect.gen(function* () {
            const sandbox = yield* original(record);
            const text = yield* modalCall(() => readFile(join(source, "manifest.json"), "utf8"));

            // The worker copies skipped files from this same read-only view before restore.
            const cached = new Map(
              (record.cacheVolume === undefined
                ? []
                : yield* listCache(sandbox).pipe(Effect.catch(() => Effect.succeed([])))
              ).map((file) => [file.sha256, file.bytes]),
            );

            yield* uploadCloudPackage(
              text,
              (file) =>
                modalCall(() =>
                  sandbox.filesystem.copyFromLocal(
                    join(source, file.path),
                    `/moke/input/${file.path}`,
                  ),
                ),
              modalCall(() => sandbox.filesystem.writeText(text, "/moke/input/manifest.json")),
              report,
              (file) => cached.get(file.sha256) === file.bytes,
            );
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
              if (connection.baseUrl !== cloudProviderEndpoints[connection.provider])
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

              const progress = yield* parseCloudWorkerProgress(record, text);

              const checkpoint =
                progress.phase === "ready"
                  ? yield* modalCall(() =>
                      sandbox.snapshotDirectory("/moke/output", { ttlMs: 7 * 24 * 60 * 60_000 }),
                    )
                  : null;

              return { progress, resultSnapshotId: checkpoint?.imageId ?? null, sourceStopped };
            }),
          ),
        download: (record, destination, report, reuse) =>
          reading(record, (sandbox) =>
            Effect.gen(function* () {
              const text = yield* modalCall(() =>
                sandbox.filesystem.readText("/moke/output/manifest.json"),
              );

              yield* downloadCloudPackage(
                text,
                destination,
                (file, local) =>
                  Effect.gen(function* () {
                    const info = yield* modalCall(() =>
                      sandbox.filesystem.stat(`/moke/output/${file.path}`),
                    );

                    if (info.type !== "file" || info.size !== file.bytes)
                      return yield* new CloudReviewError({
                        reason: "incompatible",
                        message: "A cloud package file changed before download.",
                      });
                    yield* modalCall(() =>
                      sandbox.filesystem.copyToLocal(`/moke/output/${file.path}`, local),
                    );
                  }),
                report,
                reuse,
              );
            }),
          ),
        seedCache: (request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const app = yield* modalCall(() =>
                client.apps.fromName(config.appName, {
                  createIfMissing: true,
                  environment: config.environment,
                }),
              );

              const image = yield* modalCall(() =>
                client.images.fromName(config.imageName, { environment: config.environment }),
              );

              const volume = yield* modalCall(() =>
                client.volumes.fromName(request.volume, {
                  createIfMissing: true,
                  version: 2,
                  environment: config.environment,
                }),
              );

              // Allow the measured ~1.8 MiB/s uplink at half speed and in-cloud copies at
              // 10 MiB/s, between 5 and 60 minutes.
              const uploaded = request.local.reduce((total, file) => total + file.bytes, 0);

              const copied = request.snapshots
                .flatMap((snapshot) => snapshot.files)
                .reduce((total, file) => total + file.bytes, 0);

              const timeoutMs = Math.min(
                3_600_000,
                300_000 +
                  Math.ceil(uploaded / (900 * 1024)) * 1000 +
                  Math.ceil(copied / (10 * 1024 * 1024)) * 1000,
              );

              const uploader = yield* Effect.acquireRelease(
                modalCall(() =>
                  client.sandboxes.create(app, image, {
                    command: ["sleep", "infinity"],
                    timeoutMs,
                    blockNetwork: true,
                    cpu: 0.25,
                    memoryMiB: 512,
                    volumes: { "/cache": volume },
                    tags: { "moke-kind": "cache" },
                  }),
                ),
                (sandbox) => modalCall(() => sandbox.terminate({ wait: true })).pipe(Effect.ignore),
              );

              const script = (text: string) =>
                modalCall(async () => {
                  const process = await uploader.exec(["sh", "-c", text], {
                    stdout: "ignore",
                    stderr: "ignore",
                    timeoutMs: 300_000,
                  });

                  if ((await process.wait()) !== 0) throw new Error("Cache command failed");
                });

              const mounts: Array<{
                readonly root: string;
                readonly files: (typeof request.snapshots)[number]["files"];
              }> = [];

              // An expired or deleted snapshot only means its files are uploaded on a later Send.
              for (const [index, snapshot] of request.snapshots.entries()) {
                const mounted = yield* modalCall(async () => {
                  const source = await client.images.fromId(snapshot.imageId);
                  await uploader.mountImage(`/mnt/source-${index}`, source);
                }).pipe(
                  Effect.as(true),
                  Effect.catch(() => Effect.succeed(false)),
                );

                if (mounted) mounts.push({ root: `/mnt/source-${index}`, files: snapshot.files });
              }

              if (mounts.length > 0) yield* script(retainScript(mounts));

              // Commit in batches so a long seed keeps its progress if the desktop closes.
              let staged = 0;

              for (const file of request.local) {
                if (yield* request.paused) break;
                yield* modalCall(() =>
                  uploader.filesystem.copyFromLocal(
                    file.path,
                    `/cache/.staging/${file.sha256}.part`,
                  ),
                );
                staged += file.bytes;

                if (staged >= 64 * 1024 * 1024) {
                  yield* script(commitCacheScript);
                  staged = 0;
                }
              }

              yield* script(commitCacheScript);

              const keep = request.keep;

              if (keep !== null && !(yield* request.paused)) {
                yield* modalCall(() =>
                  uploader.filesystem.writeText(`${keep.join("\n")}\n`, "/tmp/moke-keep"),
                );
                yield* script(pruneCacheScript);
              }

              return yield* listCache(uploader);
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
