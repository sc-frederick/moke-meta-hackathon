import { Effect, Layer, Logger, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpEffect } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  BackendConfig,
  BackendReady,
  BackendRpc,
  BackendUnavailable,
} from "../src/lib/backend-rpc.ts";
import { Application, BackendHandlers, type ApplicationEntry } from "./application.ts";

const program = Effect.gen(function* () {
  const input = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input: process.stdin, crlfDelay: Infinity })),
    (input) => Effect.sync(() => input.close()),
  );

  const lines = input[Symbol.asyncIterator]();

  const first = yield* Effect.tryPromise({
    try: () => lines.next(),
    catch: () => new BackendUnavailable({ message: "Backend configuration could not be read." }),
  });

  if (first.done)
    return yield* new BackendUnavailable({ message: "Backend configuration is missing." });

  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BackendConfig))(
    first.value,
  );

  const directory = join(config.dataDirectory, "logs");
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: () => new BackendUnavailable({ message: "Backend logs could not be opened." }),
  });
  const logFile = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);

  const logger = Logger.make((options) =>
    appendFileSync(logFile, Logger.formatJson.log(options) + "\n"),
  );

  let callbackEntry: ApplicationEntry | undefined;

  const entry: ApplicationEntry = {
    runPromise: (effect, options) => {
      if (callbackEntry === undefined)
        return Promise.reject(
          new BackendUnavailable({ message: "The application runtime is not ready." }),
        );

      return callbackEntry.runPromise(effect, options);
    },
  };

  const applicationRuntime = yield* Effect.acquireRelease(
    Effect.sync(() =>
      ManagedRuntime.make(
        Layer.mergeAll(
          BackendHandlers.pipe(Layer.provide(Application.layer(config, entry))),
          RpcSerialization.layerNdjson,
        ).pipe(
          // Construction, its scoped background fibers and later operations all log to the file.
          // Stdout carries only the readiness envelope.
          Layer.provideMerge(Logger.layer([logger])),
        ),
      ),
    ),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );

  callbackEntry = applicationRuntime;

  const services = yield* applicationRuntime.contextEffect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        appendFileSync(
          logFile,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "backend_startup_failed",
            message: error.message,
          }) + "\n",
        ),
      ),
    ),
  );

  const http = yield* RpcServer.toHttpEffect(BackendRpc, { disableFatalDefects: true }).pipe(
    Effect.provide(services),
  );

  const handler = HttpEffect.toWebHandler(http);
  const authorization = `Bearer ${Redacted.value(config.token)}`;

  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          maxRequestBodySize: 64 * 1024,
          idleTimeout: 0, // Authenticated progress streams can be quiet during bounded provider operations.
          fetch(request) {
            if (request.headers.get("origin") !== null) return new Response(null, { status: 403 });

            if (request.headers.get("authorization") !== authorization)
              return new Response(null, { status: 401 });
            const path = new URL(request.url).pathname;

            if (request.method !== "POST" || (path !== "/rpc" && path !== "/rpc/")) {
              return new Response(null, { status: 404 });
            }

            return handler(request);
          },
        }),
      catch: () => new BackendUnavailable({ message: "The Bun API could not start." }),
    }),
    (server) => Effect.promise(() => server.stop(true)),
  );

  const ready = yield* Schema.decodeUnknownEffect(BackendReady)({
    protocolVersion: 1,
    runtime: "bun",
    version: Bun.version,
    pid: process.pid,
    port: server.port,
  });

  yield* Effect.sync(() =>
    process.stdout.write(JSON.stringify(Schema.encodeSync(BackendReady)(ready)) + "\n"),
  );

  const terminate = () => input.close();
  yield* Effect.acquireRelease(
    Effect.sync(() => process.once("SIGTERM", terminate)),
    () => Effect.sync(() => process.removeListener("SIGTERM", terminate)),
  );
  // Closing the parent's pipe ends the backend and its scoped RPC server, including on parent death.
  yield* Effect.promise(() => lines.next());
}).pipe(Effect.scoped);

void Effect.runPromise(program).catch(() => {
  // A schema failure can contain its input. Never print private startup configuration.
  console.error(
    "The Bun backend could not start or stopped unexpectedly. Existing data was preserved.",
  );
  process.exitCode = 1;
});
