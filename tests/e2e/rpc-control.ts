import type { Page } from "@playwright/test";
import { Schema } from "effect";

/* oxlint-disable anti-slop-effect/no-manual-tag-comparison, anti-slop-effect/no-manual-tagged-construction -- The serialized page init script has no module imports. It deliberately inspects, delays and answers the installed RPC wire envelope at the renderer's transport boundary. Application handlers and clients still decode every payload, chunk and exit with their real schemas. */

/** Structured-clone RPC wire data: encoded payloads, values and errors. */
type Wire = typeof Schema.Json.Type;

const RecordedRequests = Schema.Array(Schema.Struct({ tag: Schema.String, payload: Schema.Json }));

/** One renderer RPC request as it crossed the transport boundary, still encoded. */
export type RecordedRequest = (typeof RecordedRequests.Type)[number];

declare global {
  interface Window {
    rpcControl: {
      /** Every request the renderer sent, in order, including ones answered locally. */
      requests: Array<{ tag: string; id: string; payload: Wire }>;
      /** The next server message of this kind for a request with this tag is held until released. */
      hold: (tag: string, kind?: "Exit" | "Chunk") => void;
      /** Held messages, oldest first. */
      held: () => ReadonlyArray<string>;
      /** Deliver the oldest (or newest) held message for this tag, then anything queued behind it. */
      release: (tag: string, newest?: boolean) => void;
      /** The next request with this tag never reaches the backend; this exit answers it. */
      answer: (tag: string, exit: Wire) => void;
      /** Blob URLs the renderer created and revoked, in order. */
      urls: { created: string[]; revoked: string[] };
    };
  }
}

/**
 * Control real RPC delivery between the renderer and the backend: record requests, hold chosen
 * replies or stream chunks, and answer chosen requests locally so they never reach a provider.
 * Install before reloading the page so the client's port is wrapped from the start.
 */
export async function installRpcControl(page: Page) {
  await page.getByTestId("review-workbench").waitFor();
  await page.addInitScript(() => {
    const tags = new Map<string, string>();
    const holds: Array<{ tag: string; kind: string }> = [];
    const held: Array<{ tag: string; requestId: string; deliver: () => void }> = [];
    const blocked = new Map<string, Array<() => void>>();
    const answers: Array<{ tag: string; exit: Wire }> = [];
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);

    URL.createObjectURL = (object) => {
      const url = createObjectURL(object);
      created.push(url);

      return url;
    };

    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revokeObjectURL(url);
    };

    window.rpcControl = {
      requests: [],
      hold: (tag, kind = "Exit") => {
        holds.push({ tag, kind });
      },
      held: () => held.map((entry) => entry.tag),
      release: (tag, newest = false) => {
        const index = newest
          ? held.findLastIndex((entry) => entry.tag === tag)
          : held.findIndex((entry) => entry.tag === tag);

        const [entry] = index < 0 ? [] : held.splice(index, 1);

        if (!entry) throw new Error(`No held ${tag} message`);
        const queued = blocked.get(entry.requestId) ?? [];
        blocked.delete(entry.requestId);
        entry.deliver();

        for (const deliver of queued) deliver();
      },
      answer: (tag, exit) => {
        answers.push({ tag, exit });
      },
      urls: { created, revoked },
    };

    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original port as `this`.
    const post = MessagePort.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original port as `this`.
    const listen = MessagePort.prototype.addEventListener;

    MessagePort.prototype.postMessage = function (message, transfer) {
      // SAFETY: this fixture observes the installed Effect RPC envelope; handlers still parse every payload.
      const request = message as { _tag?: string; tag?: string; id?: string; payload?: Wire };

      if (request._tag === "Request" && request.tag && request.id !== undefined) {
        const id = String(request.id);
        tags.set(id, request.tag);
        window.rpcControl.requests.push({ tag: request.tag, id, payload: request.payload ?? null });
        const index = answers.findIndex((entry) => entry.tag === request.tag);

        if (index >= 0) {
          const [answer] = answers.splice(index, 1);

          // Answer asynchronously, as the backend would, through the same listeners and holds.
          setTimeout(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: { _tag: "Exit", requestId: request.id, exit: answer?.exit },
              }),
            ),
          );

          return;
        }
      }

      return post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };

    MessagePort.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (!listener) return;

      if (type !== "message") return listen.call(this, type, listener, options);

      const deliver = (event: Event) => {
        if ("handleEvent" in listener) listener.handleEvent(event);
        else listener.call(this, event);
      };

      return listen.call(
        this,
        type,
        (event) => {
          if (!(event instanceof MessageEvent)) return deliver(event);

          // SAFETY: only the known RPC chunk and exit envelopes are inspected; all other messages pass through.
          const message = event.data as { _tag?: string; requestId?: string };
          const requestId = String(message.requestId);
          const tag = tags.get(requestId);
          const queue = blocked.get(requestId);

          if (queue) {
            queue.push(() => deliver(event));

            return;
          }

          const index = holds.findIndex(
            (entry) => entry.tag === tag && entry.kind === message._tag,
          );

          if (tag && index >= 0) {
            holds.splice(index, 1);
            blocked.set(requestId, []);
            held.push({ tag, requestId, deliver: () => deliver(event) });

            return;
          }

          deliver(event);
        },
        options,
      );
    };
  });
}

/** Requests the renderer sent with this tag, in order. */
export async function requests(page: Page, tag: string): Promise<ReadonlyArray<RecordedRequest>> {
  return Schema.decodeUnknownSync(RecordedRequests)(
    await page.evaluate(
      (name) =>
        window.rpcControl.requests
          .filter((request) => request.tag === name)
          .map((request) => ({ tag: request.tag, payload: request.payload })),
      tag,
    ),
  );
}

/** An RPC failure exit carrying an encoded typed error, in the wire shape the client decodes. */
export const failure = (error: Wire): Wire => ({
  _tag: "Failure",
  cause: [{ _tag: "Fail", error }],
});

/** An RPC success exit carrying an encoded value. */
export const success = (value: Wire): Wire => ({ _tag: "Success", value });
