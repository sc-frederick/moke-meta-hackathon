import { Effect, Option, Schema } from "effect";
import { ReviewError, ReviewRpc, ReviewStorageError } from "../src/lib/review/contracts.ts";
import { BackendApi } from "./backend.ts";

const fallback = (message: string) => new ReviewStorageError({ message });

/** Map Bun review failures to the shared schema; hide RPC transport details. */
const mapError = (message: string) =>
  Effect.mapError((cause: unknown) =>
    Option.match(Schema.decodeUnknownOption(ReviewError)(cause), {
      onNone: () => fallback(message),
      onSome: (value) => value,
    }),
  );

/** Forward the renderer's typed review contract; application work stays in the Bun backend. */
export const ReviewProxy = ReviewRpc.toLayer(
  Effect.gen(function* () {
    const { api } = yield* BackendApi;
    const review = api;

    return {
      ReviewSnapshot: ({ projectId, afterSequence }) =>
        review.ReviewSnapshot({ projectId, afterSequence }).pipe(
          mapError("The review workbench could not load."),
        ),

      ReviewCommand: ({ command }) =>
        review.ReviewCommand({ command }).pipe(mapError("The review command could not be applied.")),

      RenderSource: (payload) =>
        review.RenderSource(payload).pipe(mapError("The source region could not be rendered.")),

      ReadArtifactChunk: (payload) =>
        review.ReadArtifactChunk(payload).pipe(mapError("The artifact could not be read.")),
    };
  }),
);
