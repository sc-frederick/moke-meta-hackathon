import { PacketReviewRpc } from "../src/lib/review/packet.ts";
import { Effect, Option, Schema, Stream } from "effect";
import { ReviewError, ReviewRpc, ReviewStorageError } from "../src/lib/review/contracts.ts";
import { BackendApi } from "./backend.ts";
import { ExecutionError, ExecutionRpc } from "../src/lib/review/execution.ts";

const mapError = (message: string) =>
  Effect.mapError((cause: unknown) =>
    Option.match(Schema.decodeUnknownOption(ReviewError)(cause), {
      onNone: () => new ReviewStorageError({ message }),
      onSome: (value) => value,
    }),
  );

/** Forward the renderer's typed review contract; application work stays in the Bun backend. */
export const ReviewProxy = ReviewRpc.toLayer(
  Effect.gen(function* () {
    const { api } = yield* BackendApi;

    return {
      ReviewSnapshot: ({ projectId, afterSequence }) =>
        api
          .ReviewSnapshot({ projectId, afterSequence })
          .pipe(mapError("The review workbench could not load.")),

      ReviewCommand: ({ command }) =>
        api.ReviewCommand({ command }).pipe(mapError("The review command could not be applied.")),

      RenderSource: (payload) =>
        api.RenderSource(payload).pipe(mapError("The source region could not be rendered.")),

      ReadArtifactChunk: (payload) =>
        api.ReadArtifactChunk(payload).pipe(mapError("The artifact could not be read.")),
    };
  }),
);

/** Model controls use the same trusted frame policy and never expose provider configuration. */
export const ExecutionProxy = ExecutionRpc.toLayer(
  Effect.gen(function* () {
    const { api } = yield* BackendApi;

    const safe = Effect.mapError((cause) =>
      cause instanceof ExecutionError
        ? cause
        : new ExecutionError({
            reason: "unavailable",
            message:
              "Review execution is unavailable. Reopen the application or check provider configuration.",
          }),
    );

    return {
      ExecutionSetup: () => api.ExecutionSetup({}).pipe(safe),
      StartExecution: (request) => api.StartExecution(request).pipe(safe),
      AcknowledgeUncertainExecution: (request) =>
        api.AcknowledgeUncertainExecution(request).pipe(safe),
      ExecutionStatus: (request) => api.ExecutionStatus(request).pipe(safe),
      ControlExecution: (request) => api.ControlExecution(request).pipe(safe),
      ObserveExecution: (request) =>
        api.ObserveExecution(request).pipe(
          Stream.mapError((cause) =>
            cause instanceof ExecutionError
              ? cause
              : new ExecutionError({
                  reason: "unavailable",
                  message: "Progress disconnected. Reopen the finding to reconnect.",
                }),
          ),
        ),
    };
  }),
);

/** Packet review work remains in Bun and uses the same trusted top-level desktop frame. */
export const PacketProxy = PacketReviewRpc.toLayer(
  Effect.gen(function* () {
    const { api } = yield* BackendApi;

    const safe = Effect.mapError((cause) =>
      cause instanceof ExecutionError
        ? cause
        : new ExecutionError({
            reason: "unavailable",
            message: "The packet review operation is unavailable.",
          }),
    );

    return {
      StartPacketReview: (request) => api.StartPacketReview(request).pipe(safe),
      ListPacketReviews: (request) => api.ListPacketReviews(request).pipe(safe),
      GetPacketReview: (request) => api.GetPacketReview(request).pipe(safe),
      ControlPacketReview: (request) => api.ControlPacketReview(request).pipe(safe),
      CompletePacketFinding: (request) => api.CompletePacketFinding(request).pipe(safe),
      ObservePacketReviews: (request) =>
        api.ObservePacketReviews(request).pipe(
          Stream.mapError((cause) =>
            cause instanceof ExecutionError
              ? cause
              : new ExecutionError({
                  reason: "unavailable",
                  message: "Review progress disconnected.",
                }),
          ),
        ),
    };
  }),
);
