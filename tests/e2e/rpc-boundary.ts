import type { Page } from "@playwright/test";

/* oxlint-disable anti-slop-effect/no-manual-tag-comparison, anti-slop-effect/no-manual-tagged-construction -- The serialized page init script has no module imports. It deliberately inspects/injects the installed RPC wire envelope at the transport boundary. Application handlers and clients still decode it with their real schemas. */

declare global {
  interface Window {
    auditRpc: {
      holdRender: boolean;
      held: boolean;
      release: () => void;
      loseImportResponse: boolean;
      imports: string[];
      renderDpis: number[];
    };
  }
}

/** Delay real RPC delivery, or lose one successful import response, without replacing application handlers. */
export async function installRpcBoundary(page: Page) {
  await page.getByTestId("review-workbench").waitFor();
  await page.addInitScript(() => {
    const requests = new Map<string, string>();
    window.auditRpc = {
      holdRender: false,
      held: false,
      release: () => {},
      loseImportResponse: false,
      imports: [],
      renderDpis: [],
    };
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original port as `this`.
    const post = MessagePort.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original port as `this`.
    const listen = MessagePort.prototype.addEventListener;

    MessagePort.prototype.postMessage = function (message, transfer) {
      // SAFETY: this fixture observes the installed Effect RPC envelope; handlers still parse every payload.
      const request = message as {
        _tag?: string;
        tag?: string;
        id?: string;
        payload?: { dpi?: number };
      };

      if (request._tag === "Request" && request.tag && request.id !== undefined) {
        requests.set(String(request.id), request.tag);

        if (request.tag === "ChooseReviewPdf")
          window.auditRpc.imports.push(JSON.stringify(request.payload));

        if (request.tag === "RenderSource" && request.payload?.dpi !== undefined)
          window.auditRpc.renderDpis.push(request.payload.dpi);
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
          // SAFETY: only the known RPC exit envelope is inspected; all other messages pass through untouched.

          const message = event.data as {
            _tag?: string;
            requestId?: string;
            exit?: { _tag?: string };
          };

          const tag = requests.get(String(message.requestId));

          if (message._tag === "Exit" && message.exit?._tag === "Success") {
            if (tag === "RenderSource" && window.auditRpc.holdRender) {
              window.auditRpc.holdRender = false;
              window.auditRpc.held = true;
              window.auditRpc.release = () => {
                window.auditRpc.held = false;
                deliver(event);
              };

              return;
            }

            if (tag === "ChooseReviewPdf" && window.auditRpc.loseImportResponse) {
              window.auditRpc.loseImportResponse = false;
              // Model a transport-reported failure after the backend committed the import.
              deliver(
                new MessageEvent("message", {
                  data: {
                    _tag: message._tag,
                    requestId: message.requestId,
                    exit: {
                      _tag: "Failure",
                      cause: [
                        {
                          _tag: "Fail",
                          error: {
                            _tag: "ReviewStorageError",
                            message: "Injected lost import response. Retry the saved request.",
                          },
                        },
                      ],
                    },
                  },
                }),
              );

              return;
            }
          }

          deliver(event);
        },
        options,
      );
    };
  });
}
