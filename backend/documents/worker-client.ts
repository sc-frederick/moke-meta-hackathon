import { Effect, Schema } from "effect";
import { DocumentError } from "#lib/review/contracts.ts";
import type { DocumentsConfig } from "./config.ts";
import { join } from "node:path";
import {
  WorkerInspectRequest,
  WorkerRenderRequest,
  WorkerInspectResult,
  WorkerRenderResult,
  WorkerRequest,
  WorkerResponse,
  WorkerSuccess,
  WorkerTextRequest,
  WorkerTextResult,
} from "./worker-messages.ts";

/** A scoped subprocess is killed on timeout, cancellation, malformed output, or completion. */
export interface PdfWorkerSession {
  readonly call: <A>(
    request: typeof WorkerRequest.Type,
    decode: (result: (typeof WorkerSuccess.Type)["result"]) => A,
  ) => Effect.Effect<A, DocumentError>;
  readonly nextId: () => string;
}

/** Open one process for a bounded PDF job, with explicit lifetime and exit cleanup. */
export const openPdfWorker = Effect.fn("openPdfWorker")(function* (config: DocumentsConfig) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [...config.workerCommand],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: {
            ...process.env,
            MOKE_PDFJS_ASSETS: config.assetsDirectory,
            NAPI_RS_NATIVE_LIBRARY_PATH: config.nativeLibraryPath,
            NODE_PATH: join(config.assetsDirectory, "..", "modules"),
            BUN_OPTIONS: "",
          },
        }),
      catch: () =>
        new DocumentError({
          reason: "unavailable",
          message: "The PDF processing worker could not start.",
        }),
    }),
    (child) =>
      Effect.promise(async () => {
        child.kill("SIGKILL");
        await child.exited;
      }),
  );

  let counter = 0;
  let buffered = "";
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  yield* Effect.addFinalizer(() => Effect.sync(() => reader.releaseLock()));

  const session: PdfWorkerSession = {
    nextId: () => `pdf-${++counter}`,
    call: (request, decode) =>
      Effect.tryPromise({
        try: async (signal) => {
          const abort = () => child.kill("SIGKILL");
          signal.addEventListener("abort", abort, { once: true });

          try {
            await child.stdin.write(JSON.stringify(request) + "\n");
            await child.stdin.flush();

            for (;;) {
              const newline = buffered.indexOf("\n");

              if (newline >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);

                const response = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerResponse))(
                  line,
                );

                if (response.id !== request.id)
                  throw new Error("Unexpected worker response identity");

                if (!response.ok)
                  throw new DocumentError({ reason: response.reason, message: response.message });

                return decode(response.result);
              }

              const chunk = await reader.read();

              if (chunk.done) throw new Error("Worker stopped without a result");
              buffered += decoder.decode(chunk.value, { stream: true });

              if (buffered.length > 96 * 1024 * 1024) throw new Error("Worker output limit");
            }
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        catch: (cause) =>
          cause instanceof DocumentError
            ? cause
            : new DocumentError({
                reason: "unavailable",
                message: "The PDF worker failed or returned invalid data.",
              }),
      }),
  };

  return session;
});

/** Inventory a staged original with schema validation on the subprocess boundary. */
export function workerInspect(worker: PdfWorkerSession, pdfPath: string) {
  return worker.call(
    WorkerInspectRequest.make({ id: worker.nextId(), pdfPath }),
    Schema.decodeUnknownSync(WorkerInspectResult),
  );
}

/** Render only the bounded source region requested by the application. */
export function workerRender(
  worker: PdfWorkerSession,
  input: Omit<typeof WorkerRenderRequest.Type, "_tag" | "id">,
) {
  return worker.call(
    WorkerRenderRequest.make({ ...input, id: worker.nextId() }),
    Schema.decodeUnknownSync(WorkerRenderResult),
  );
}

/** Extract embedded page text from a stored PDF, starting at a one-based page. */
export function workerText(
  worker: PdfWorkerSession,
  input: Omit<typeof WorkerTextRequest.Type, "_tag" | "id">,
) {
  return worker.call(
    WorkerTextRequest.make({ ...input, id: worker.nextId() }),
    Schema.decodeUnknownSync(WorkerTextResult),
  );
}
