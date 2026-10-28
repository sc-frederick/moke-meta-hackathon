import { Effect, Option, Schema, Stream } from "effect";
import { ReviewError, ReviewRpc, ReviewStorageError } from "../src/lib/review/contracts.ts";
import { BackendApi } from "./backend.ts";
import { ExecutionError, ExecutionRpc } from "../src/lib/review/execution.ts";

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
        review
          .ReviewSnapshot({ projectId, afterSequence })
          .pipe(mapError("The review workbench could not load.")),

      ReviewCommand: ({ command }) =>
        review
          .ReviewCommand({ command })
          .pipe(mapError("The review command could not be applied.")),

      RenderSource: (payload) =>
        review.RenderSource(payload).pipe(mapError("The source region could not be rendered.")),

      ReadArtifactChunk: (payload) =>
        review.ReadArtifactChunk(payload).pipe(mapError("The artifact could not be read.")),
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
      StartExecution: (request) => api.StartExecution(request).pipe(safe),
      AcknowledgeUncertainExecution: (request) =>
        api.AcknowledgeUncertainExecution(request).pipe(safe),
      ExecutionStatus: (request) => api.ExecutionStatus(request).pipe(safe),
      ControlExecution: (request) => api.ControlExecution(request).pipe(safe),
      ExecutionEvents: (request) => api.ExecutionEvents(request).pipe(safe),
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
