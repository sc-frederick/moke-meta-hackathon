import { Context, Effect, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { RendererRpcClient } from "electron-effect-rpc/renderer";
import {
  type Artifact,
  CommandId,
  type OperationId,
  type ProjectId,
  type Region,
  ReviewError,
  ReviewCommand,
  ReviewStorageError,
  type SheetId,
} from "#lib/review/contracts.ts";
import { ReviewDesktopRpc } from "#lib/review/shell.ts";
import {
  ExecutionError,
  type ExecutionEvent,
  type RunId,
  type StartExecution,
} from "#lib/review/execution.ts";

const ClientError = Schema.Union([ReviewError, ExecutionError]);

class ReviewDesktopApi extends Context.Service<
  ReviewDesktopApi,
  RpcClient.FromGroup<typeof ReviewDesktopRpc, RpcClientError.RpcClientError>
>()("app/ReviewDesktopApi") {}

function mapClientError(cause: unknown, fallback: string): typeof ClientError.Type {
  return Option.match(Schema.decodeUnknownOption(ClientError)(cause), {
    onNone: () => new ReviewStorageError({ message: fallback }),
    onSome: (value) => value,
  });
}

type ReviewClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: typeof ClientError.Type };

/** Acquire a scoped MessagePort client for review workbench operations. */
export function createReviewClient() {
  const api = Layer.effect(ReviewDesktopApi, RpcClient.make(ReviewDesktopRpc)).pipe(
    Layer.provide(RendererRpcClient.layerProtocol()),
  );

  const runtime = ManagedRuntime.make(api);

  const run = async <T>(
    operation: Effect.Effect<T, unknown, ReviewDesktopApi>,
    fallback: string,
    signal?: AbortSignal,
  ): Promise<ReviewClientResult<T>> => {
    try {
      const value = await runtime.runPromise(
        operation.pipe(
          Effect.catch((cause: unknown) => Effect.fail(mapClientError(cause, fallback))),
        ),
        signal === undefined ? undefined : { signal },
      );

      return { ok: true, value };
    } catch (cause) {
      return { ok: false, error: mapClientError(cause, fallback) };
    }
  };

  return {
    executionSetup: () =>
      run(
        Effect.flatMap(ReviewDesktopApi, (api) => api.ExecutionSetup({})),
        "Review configuration is unavailable. Reopen the application to reconnect.",
      ),
    observeExecution: (
      projectId: typeof ProjectId.Type,
      afterSequence: number,
      onEvent: (event: ExecutionEvent) => Promise<void>,
      signal: AbortSignal,
    ) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const api = yield* ReviewDesktopApi;
            yield* Stream.runForEach(api.ObserveExecution({ projectId, afterSequence }), (event) =>
              Effect.promise(() => onEvent(event)),
            );
          }),
          { signal },
        )
        .catch(() => undefined),
    startExecution: (request: typeof StartExecution.Type) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (api) => api.StartExecution(request)),
        "The review could not start.",
      ),
    executionStatus: (projectId: typeof ProjectId.Type, runId: typeof RunId.Type) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (api) => api.ExecutionStatus({ projectId, runId })),
        "Execution status is unavailable.",
      ),
    controlExecution: (
      projectId: typeof ProjectId.Type,
      runId: typeof RunId.Type,
      expectedVersion: number,
      action: "pause" | "resume" | "cancel",
    ) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (api) =>
          api.ControlExecution({
            projectId,
            runId,
            expectedVersion,
            action,
            commandId: newCommandId(),
          }),
        ),
        "The execution control could not be applied.",
      ),
    acknowledgeExecution: (
      projectId: typeof ProjectId.Type,
      runId: typeof RunId.Type,
      expectedVersion: number,
    ) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (api) =>
          api.AcknowledgeUncertainExecution({
            projectId,
            runId,
            expectedVersion,
            commandId: newCommandId(),
            possibleChargeAcknowledged: true,
          }),
        ),
        "The uncertainty acknowledgement could not be saved.",
      ),
    snapshot: (
      projectId: typeof ProjectId.Type | null,
      afterSequence: number,
      signal?: AbortSignal,
    ) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) =>
          client.ReviewSnapshot({ projectId, afterSequence }),
        ),
        "The review workbench could not load.",
        signal,
      ),

    command: (command: typeof ReviewCommand.Type) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) => client.ReviewCommand({ command })),
        "The review command could not be applied.",
      ),

    renderSource: (payload: {
      projectId: typeof ProjectId.Type;
      sheetId: typeof SheetId.Type;
      operationId: typeof OperationId.Type;
      region: Region;
      dpi: number;
    }) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) => client.RenderSource(payload)),
        "The source region could not be rendered.",
      ),

    chooseReviewPdf: (payload: {
      projectId: typeof ProjectId.Type;
      expectedVersion: number;
      commandId: typeof CommandId.Type;
    }) =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) => client.ChooseReviewPdf(payload)),
        "The PDF could not be imported.",
      ),

    chooseReviewExport: () =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) => client.ChooseReviewExport({})),
        "The review package could not be exported.",
      ),

    chooseReviewRestore: () =>
      run(
        Effect.flatMap(ReviewDesktopApi, (client) => client.ChooseReviewRestore({})),
        "The review package could not be restored.",
      ),

    /** Load a PNG artifact through bounded chunks and return an object URL. */
    loadArtifactBlobUrl: async (
      projectId: typeof ProjectId.Type,
      artifact: Artifact,
    ): Promise<ReviewClientResult<string>> => {
      const chunks: Array<BlobPart> = [];
      let offset = 0;
      let totalBytes = artifact.byteLength;

      while (offset < totalBytes) {
        const limit = Math.min(256 * 1024, totalBytes - offset);

        const chunk = await run(
          Effect.flatMap(ReviewDesktopApi, (client) =>
            client.ReadArtifactChunk({
              projectId,
              artifactId: artifact.id,
              offset,
              limit,
            }),
          ),
          "The source image could not be loaded.",
        );

        if (!chunk.ok) return chunk;
        const part = chunk.value;
        totalBytes = part.totalBytes;
        chunks.push(Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0)));
        offset += limit;
      }

      const blob = new Blob(chunks, { type: artifact.mediaType });

      return { ok: true, value: URL.createObjectURL(blob) };
    },

    dispose: () => runtime.dispose(),
  };
}

/** Scoped workbench operations and resource disposal owned by the mounted page. */
export type ReviewClient = ReturnType<typeof createReviewClient>;

/** Build a validated review command for renderer-initiated mutations. */
export function reviewCommand(input: typeof ReviewCommand.Type): typeof ReviewCommand.Type {
  return Schema.decodeUnknownSync(ReviewCommand)(input);
}

/** Allocate a fresh command id for idempotent writes. */
export function newCommandId(): typeof CommandId.Type {
  return Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());
}
