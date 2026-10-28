import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  BackendConfig,
  BackendReady,
  BackendRpc,
  BackendUnavailable,
} from "../src/lib/backend-rpc.ts";

/** Desktop-owned launch configuration; callers never expose backend credentials to the renderer. */
export interface BackendLaunch {
  readonly command: readonly [string, ...Array<string>];
  readonly dataDirectory: string;
  readonly migrationDirectory: string;
  readonly onUnexpectedExit?: () => void;
  readonly processing?: BackendConfig["processing"];
  readonly inference?: BackendConfig["inference"];
}

const stopped = (child: ChildProcessWithoutNullStreams) =>
  child.exitCode !== null || child.signalCode !== null;

const stop = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<void>((resume) => {
    if (child.pid === undefined || stopped(child)) {
      resume(Effect.void);

      return;
    }

    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    const exited = () => resume(Effect.void);
    child.once("exit", exited);
    child.stdin.end();

    return Effect.sync(() => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
    });
  });

const readiness = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<BackendReady, BackendUnavailable>((resume) => {
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });

    const failed = () =>
      resume(
        Effect.fail(
          new BackendUnavailable({ message: "The Bun backend exited before becoming ready." }),
        ),
      );

    const line = (value: string) =>
      resume(
        Schema.decodeUnknownEffect(Schema.fromJsonString(BackendReady))(value).pipe(
          Effect.mapError(
            () =>
              new BackendUnavailable({ message: "The Bun backend returned invalid startup data." }),
          ),
        ),
      );

    output.once("line", line);
    child.once("error", failed);
    child.once("exit", failed);

    return Effect.sync(() => {
      output.close();
      child.removeListener("error", failed);
      child.removeListener("exit", failed);
    });
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () => new BackendUnavailable({ message: "The Bun backend could not become ready." }),
    ),
  );

/** A scoped, schema-validated client for the privately authenticated Bun process. */
export class BackendApi extends Context.Service<
  BackendApi,
  {
    readonly api: RpcClient.FromGroup<typeof BackendRpc, RpcClientError.RpcClientError>;
    readonly ready: BackendReady;
  }
>()("app/BackendApi") {
  /** Start one backend, validate its readiness, and stop it when the desktop runtime closes. */
  static layer(options: BackendLaunch) {
    return Layer.effect(
      BackendApi,
      Effect.gen(function* () {
        const token = Redacted.make(randomBytes(32).toString("hex"));
        let closing = false;

        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              spawn(options.command[0], options.command.slice(1), {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              }),
            catch: () =>
              new BackendUnavailable({ message: "The Bun executable could not be started." }),
          }),
          (child) => {
            closing = true;

            return stop(child);
          },
        );

        child.stderr.pipe(process.stderr, { end: false });

        const paths = { dataDirectory: options.dataDirectory,migrationDirectory: options.migrationDirectory,token };
        const processing = options.processing === undefined ? paths : { ...paths,processing: options.processing };
        const startup = new BackendConfig(options.inference === undefined ? processing : { ...processing,inference: options.inference });

        const ready = yield* Effect.all(
          [
            readiness(child),
            Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  child.stdin.write(
                    JSON.stringify(Schema.encodeSync(BackendConfig)(startup)) + "\n",
                    (error) => {
                      if (error) reject(error);
                      else resolve();
                    },
                  );
                }),
              catch: () =>
                new BackendUnavailable({ message: "Backend configuration could not be sent." }),
            }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([ready]) => ready));

        const onExit = () => {
          if (!closing) options.onUnexpectedExit?.();
        };

        yield* Effect.acquireRelease(
          Effect.sync(() => child.once("exit", onExit)),
          () => Effect.sync(() => child.removeListener("exit", onExit)),
        );

        const protocol = RpcClient.layerProtocolHttp({
          url: `http://127.0.0.1:${ready.port}/rpc`,
          transformClient: (client) =>
            HttpClient.mapRequest(
              client,
              HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`),
            ),
        }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerJson));

        const context = yield* Layer.build(protocol);
        const api = yield* RpcClient.make(BackendRpc).pipe(Effect.provide(context));

        return BackendApi.of({ api, ready });
      }),
    );
  }
}
