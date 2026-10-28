import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { RendererRpcClient } from "electron-effect-rpc/renderer";
import {
  type Artifact,
  type ArtifactChunk,
  type ArtifactId,
  CommandId,
  type CommandReceipt,
  type OperationId,
  type ProjectId,
  type Region,
  ReviewError,
  ReviewCommand,
  ReviewStorageError,
  type SheetId,
} from "#lib/review/contracts.ts";
import { ReviewDesktopRpc } from "#lib/review/shell.ts";

class ReviewDesktopApi extends Context.Service<
  ReviewDesktopApi,
  RpcClient.FromGroup<typeof ReviewDesktopRpc, RpcClientError.RpcClientError>
>()("app/ReviewDesktopApi") {}

/** Map RPC failures to stable review errors for the workbench. */
export function mapClientError(cause: unknown, fallback: string): typeof ReviewError.Type {
  return Option.match(Schema.decodeUnknownOption(ReviewError)(cause), {
    onNone: () => new ReviewStorageError({ message: fallback }),
    onSome: (value) => value,
  });
}

export type ReviewClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: typeof ReviewError.Type };

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
    snapshot: (
      projectId: typeof ProjectId.Type | null,
      afterSequence: number,
      signal?: AbortSignal,
    ) =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ReviewSnapshot({ projectId, afterSequence });
        }),
        "The review workbench could not load.",
        signal,
      ),

    command: (command: typeof ReviewCommand.Type) =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ReviewCommand({ command });
        }),
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
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.RenderSource(payload);
        }),
        "The source region could not be rendered.",
      ),

    readArtifactChunk: (
      projectId: typeof ProjectId.Type,
      artifactId: typeof ArtifactId.Type,
      offset: number,
      limit: number,
    ) =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ReadArtifactChunk({ projectId, artifactId, offset, limit });
        }),
        "The artifact could not be read.",
      ),

    chooseReviewPdf: (payload: {
      projectId: typeof ProjectId.Type;
      expectedVersion: number;
      commandId: typeof CommandId.Type;
    }) =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ChooseReviewPdf(payload);
        }),
        "The PDF could not be imported.",
      ),

    chooseReviewExport: () =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ChooseReviewExport({});
        }),
        "The review package could not be exported.",
      ),

    chooseReviewRestore: () =>
      run(
        Effect.gen(function* () {
          const client = yield* ReviewDesktopApi;

          return yield* client.ChooseReviewRestore({});
        }),
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
          Effect.gen(function* () {
            const client = yield* ReviewDesktopApi;

            return yield* client.ReadArtifactChunk({
              projectId,
              artifactId: artifact.id,
              offset,
              limit,
            });
          }),
          "The source image could not be loaded.",
        );

        if (!chunk.ok) return chunk;
        // SAFETY: ReadArtifactChunk success schema is ArtifactChunk.
        const part = chunk.value as ArtifactChunk;
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

export type ReviewClient = ReturnType<typeof createReviewClient>;

/** Build a validated review command for renderer-initiated mutations. */
export function reviewCommand(input: typeof ReviewCommand.Type): typeof ReviewCommand.Type {
  return Schema.decodeUnknownSync(ReviewCommand)(input);
}

/** Allocate a fresh command id for idempotent writes. */
export function newCommandId(): typeof CommandId.Type {
  return Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());
}

/** Convenience helper after a successful command. */
export function receiptProjectVersion(receipt: CommandReceipt): number {
  return receipt.version;
}
