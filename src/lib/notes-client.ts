import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { RendererRpcClient } from "electron-effect-rpc/renderer";
import { NotesRpc } from "./notes.ts";

class NotesApi extends Context.Service<
  NotesApi,
  RpcClient.FromGroup<typeof NotesRpc, RpcClientError.RpcClientError>
>()("app/NotesApi") {}

/** Acquire a scoped MessagePort RPC client for the desktop renderer. */
export function createNotesClient() {
  const api = Layer.effect(NotesApi, RpcClient.make(NotesRpc)).pipe(
    Layer.provide(RendererRpcClient.layerProtocol()),
  );

  const runtime = ManagedRuntime.make(api);

  return {
    list: (signal: AbortSignal) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const client = yield* NotesApi;

            return { notes: yield* client.ListNotes(), error: "" };
          }).pipe(
            Effect.catch(() => Effect.succeed({ notes: [], error: "Notes could not be loaded." })),
          ),
          { signal },
        )
        .catch(() => ({ notes: [], error: "" })),
    add: (text: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* NotesApi;

          return { note: yield* client.AddNote({ text }), error: "" };
        }).pipe(
          Effect.catch(() =>
            Effect.succeed({ note: undefined, error: "The note could not be saved." }),
          ),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}
