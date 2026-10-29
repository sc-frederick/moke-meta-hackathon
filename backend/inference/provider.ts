import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { basetenProvider } from "@earendil-works/pi-ai/providers/baseten";
import type {
  AssistantMessage,
  FetchFunction,
  Model,
  Api,
  ProviderRequestOptions,
  TranscriptContext,
  SimpleStreamOptions,
  ImageContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Option, Predicate, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";
import { parseResponseReceipt } from "./response.ts";
import { createExecutionTelemetry, type RequestPhase } from "./telemetry.ts";
import type { ProviderFailure } from "#lib/review/execution.ts";
import { reviewModels } from "#lib/review/models.ts";

/** Injectable HTTP transport; Bun's optional fetch utilities are supplied by the adapter. */
export type ProviderTransport = (
  input: Parameters<FetchFunction>[0],
  init?: Parameters<FetchFunction>[1],
) => Promise<Response>;

/** Private startup credentials and selected route; no environment credential fallback is used. */
export interface ProviderConfiguration {
  readonly provider?: "meta" | "baseten";
  readonly apiKey: Redacted.Redacted<string>;
  readonly route: "live" | "recorded";
  readonly baseUrl?: string;
  readonly model?: string;
  /** Test/recorded transport; still exercises the published SDK request path. */
  readonly transport?: ProviderTransport;
  readonly timeoutMs?: number;
}

/** Catalog capability for a pinned review model; Open's separate serving output maximum is unpublished. */
export function reviewModelCapabilities(modelId: string) {
  if (modelId === "meta-models/muse-spark-open-1026")
    return { contextWindow: 1048576, maxOutputTokens: null };

  const model = metaProvider()
    .getModels()
    .find((entry) => entry.id === modelId);

  if (!model || !reviewModels.some((entry) => entry.id === modelId && entry.provider === "meta"))
    throw new Error("Pinned model catalog is incompatible");

  return { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens };
}

/** Durable admission callbacks are implemented with short application SQL operations. */
interface ProviderAdmission {
  readonly maxInputTokens: number;
  readonly packetReview?: boolean;
  readonly maxOutputTokens: number;
  readonly begin: (phase: RequestPhase, fingerprint: string) => Promise<string | null>;
  readonly send: (phase: RequestPhase) => Promise<void>;
  readonly complete: (phase: RequestPhase, receipt: string) => Promise<void>;
  readonly end: (uncertain: boolean, diagnostic?: typeof ProviderFailure.Type) => Promise<void>;
}

const ImageUrl = Schema.String.check(
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/),
);

/** Reserve UTF-8 text bytes as an upper bound on text tokens; image tokens remain explicitly unknown. */
function requestBounds(body: string) {
  const payload = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(body));
  let imageBytes = 0;
  let images = 0;

  const withoutPixels = (value: Schema.MutableJson): Schema.MutableJson => {
    if (Predicate.isString(value)) {
      if (value.startsWith("data:image/")) {
        const image = Schema.decodeUnknownSync(ImageUrl)(value);
        imageBytes += Buffer.byteLength(image.slice(image.indexOf(",") + 1), "base64");
        images++;

        return "[bounded image]";
      }

      return value;
    }

    if (Array.isArray(value)) return value.map(withoutPixels);

    if (Predicate.isObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          withoutPixels(Schema.decodeUnknownSync(Schema.MutableJson)(child)),
        ]),
      );

    return value;
  };

  const textBytes = Buffer.byteLength(JSON.stringify(withoutPixels(payload)));

  return { textBytes, imageBytes, images, requestBytes: Buffer.byteLength(body) };
}

/** Keep recent delivered pixels in a bounded stateless request; retain all source metadata and receipts. */
function boundedImageContext(
  transcript: TranscriptContext,
  limits = { images: 6, imageBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 },
): TranscriptContext {
  const retained = new Set<ImageContent>();
  let bytes = 0;

  for (const message of transcript.messages.toReversed()) {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      Predicate.isString(message.content)
    )
      continue;

    for (const part of message.content.toReversed()) {
      if (part.type !== "image") continue;
      const size = Buffer.byteLength(part.data, "base64");

      if (size > limits.imageBytes) throw new Error("Individual source image exceeds its bound");

      if (retained.size < limits.images && bytes + size <= limits.totalBytes) {
        retained.add(part);
        bytes += size;
      }
    }
  }

  return {
    ...transcript,
    messages: transcript.messages.map((message) => {
      if (
        (message.role !== "user" && message.role !== "toolResult") ||
        Predicate.isString(message.content)
      )
        return message;

      return {
        ...message,
        content: message.content.map((part) =>
          part.type !== "image" || retained.has(part)
            ? part
            : {
                type: "text" as const,
                text: "Earlier image omitted from the current request image window. Its source metadata and durable artifact remain available. Render that sheet or detail again before making a new claim about its contents.",
              },
        ),
      };
    }),
  };
}

const ProviderRejection = Schema.Struct({
  error: Schema.Union([Schema.String, Schema.Struct({ message: Schema.String })]),
});

/** Classify a bounded error body without retaining raw provider text or echoed inputs. */
async function providerRejectionDetail(
  response: Response,
): Promise<NonNullable<(typeof ProviderFailure.Type)["detail"]>> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  if (reader) {
    try {
      while (true) {
        const part = await reader.read();

        if (part.done) break;
        bytes += part.value.length;

        if (bytes > 16384) {
          await reader.cancel();
          break;
        }

        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const decoded =
    bytes <= 16384
      ? Schema.decodeUnknownOption(Schema.fromJsonString(ProviderRejection))(
          Buffer.concat(chunks).toString("utf8"),
        )
      : Option.none();

  const message = Option.match(decoded, {
    onNone: () => "",
    onSome: (body) => (Predicate.isString(body.error) ? body.error : body.error.message),
  });

  if (
    /too many images|(?:image|images).{0,40}(?:maximum|limit)|max(?:imum)? .{0,20}images/i.test(
      message,
    )
  )
    return "image_limit";

  if (
    /context.{0,30}(?:length|limit|exceed)|(?:token|tokens).{0,30}(?:limit|maximum|exceed)/i.test(
      message,
    )
  )
    return "context_limit";

  if (
    response.status === 413 ||
    /payload.{0,30}(?:large|limit)|(?:media|image|request).{0,30}(?:size|bytes).{0,30}(?:large|limit|exceed)/i.test(
      message,
    )
  )
    return "payload_limit";

  if (response.status === 401 || response.status === 403) return "authentication";

  if (response.status === 429) return "rate_limit";

  if (response.status === 400 || response.status === 422) return "invalid_request";

  return "unclassified";
}

/** Both SDK entrypoints pass the same durable guard, including complete/completeSimple callers. */
export function createAdmittedModels(
  configuration: ProviderConfiguration,
  admission: ProviderAdmission,
) {
  if (configuration.route === "recorded" && configuration.transport === undefined)
    throw new Error("Recorded execution requires a recorded transport");
  const identity = createExecutionTelemetry(admission.packetReview === true);
  const base: Provider = configuration.provider === "baseten" ? basetenProvider() : metaProvider();

  const modelId =
    configuration.model ??
    (base.id === "baseten" ? "meta-models/muse-spark-open-1026" : "muse-spark-1.3");

  const baseUrl =
    base.id === "baseten" ? "https://inference.baseten.co/v1" : "https://api.meta.ai/v1";

  if (
    !reviewModels.some((model) => model.id === modelId && model.provider === base.id) ||
    (configuration.baseUrl !== undefined && configuration.baseUrl.replace(/\/$/, "") !== baseUrl)
  )
    throw new Error("Inference route does not match the selected pinned model");
  const catalog = base.getModels().find((model) => model.id === modelId);

  const metaModel = metaProvider()
    .getModels()
    .find((model) => model.id === "muse-spark-1.3");

  if (metaModel === undefined) throw new Error("Pinned model catalog is incompatible");

  // The alternative route is organizer-provided and absent from Pi's catalog. Its rates are unknown.
  // SDK-required zero rates are an internal sentinel only; application cost remains null for both routes.
  const selected: Model<Api> = catalog ?? {
    id: modelId,
    name: "Muse Spark Open",
    api: "openai-completions",
    provider: "baseten",
    baseUrl: "https://inference.baseten.co/v1",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1048576,
    // Open serving does not publish a separate output ceiling; the context is the upper bound.
    maxTokens: 1048576,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const guarded = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options: ProviderRequestOptions | undefined,
    send: (
      fetch: FetchFunction,
      context: TranscriptContext,
    ) => ReturnType<typeof createAssistantMessageEventStream>,
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const started = performance.now();
      let failurePhase: (typeof ProviderFailure.Type)["phase"] = "admission";
      let httpStatus: number | null = null;
      let rejectionDetail: (typeof ProviderFailure.Type)["detail"];
      let requestImages = 0;
      let requestBytes = 0;
      let transportFailure: (typeof ProviderFailure.Type)["category"] | undefined;
      let admitted = false;
      let completed = false;

      try {
        const phase = identity.phase(options?.telemetry);

        if (
          phase === undefined ||
          model.provider !== selected.provider ||
          model.id !== selected.id ||
          model.api !== selected.api
        )
          throw new Error("Provider admission denied");

        // Baseten's Muse Spark media encoder accepts at most eight images per request,
        // including images retained in earlier tool results. The durable journal stays intact.
        const bounded = admission.packetReview
          ? selected.provider === "baseten"
            ? boundedImageContext(transcript, {
                images: 8,
                imageBytes: 10 * 1024 * 1024,
                totalBytes: 64 * 1024 * 1024,
              })
            : transcript
          : boundedImageContext(transcript);

        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              model: model.id,
              api: model.api,
              transcript: bounded,
              output: admission.maxOutputTokens,
            }),
          )
          .digest("hex");

        const cached = await admission.begin(phase, fingerprint);
        admitted = true;

        if (cached !== null) {
          const message = parseResponseReceipt(JSON.parse(cached));
          completed = true;
          await admission.end(false);
          admitted = false;
          output.push({ type: "done", reason: message.stopReason, message });

          return;
        }

        let dispatched = false;

        const transport: FetchFunction = Object.assign(
          async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
            const body = Schema.decodeUnknownSync(Schema.String)(init?.body);
            const bounds = requestBounds(body);
            requestImages = bounds.images;
            requestBytes = bounds.requestBytes;

            if (
              dispatched ||
              bounds.textBytes > admission.maxInputTokens ||
              bounds.imageBytes > (admission.packetReview ? 64 : 2) * 1024 * 1024 ||
              bounds.requestBytes > (admission.packetReview ? 72 : 3) * 1024 * 1024 ||
              (!admission.packetReview && bounds.images > 6) ||
              (selected.provider === "baseten" && bounds.images > 8)
            )
              throw new Error("Transport admission denied");
            dispatched = true;
            await admission.send(phase);

            failurePhase = "dispatch";

            try {
              const response = await (configuration.transport ?? globalThis.fetch)(input, init);
              httpStatus = response.status;
              failurePhase = "response";

              if (!response.ok) {
                transportFailure = "http";
                rejectionDetail = await providerRejectionDetail(response);

                // Do not pass potentially sensitive provider error text into SDK diagnostics.
                return Response.json(
                  { error: { message: `Provider rejected request: ${rejectionDetail}` } },
                  { status: response.status },
                );
              }

              return response;
            } catch (cause) {
              transportFailure = init?.signal?.aborted
                ? init.signal.reason instanceof DOMException &&
                  init.signal.reason.name === "TimeoutError"
                  ? "timeout"
                  : "aborted"
                : cause instanceof Error && /timeout|timed out/i.test(cause.message)
                  ? "timeout"
                  : "network";
              throw cause;
            }
          },
          { preconnect: globalThis.fetch.preconnect },
        );

        // Buffer the final normalized response. No tool can consume a response before its receipt commits.
        const response = await send(transport, bounded).result();

        if (response.stopReason === "error" || response.stopReason === "aborted") {
          // The SDK's deadline abort uses a plain AbortError internally. Its normalized
          // timeout result distinguishes that deadline from an explicit caller abort.
          if (
            !options?.signal?.aborted &&
            (transportFailure === undefined || transportFailure === "aborted") &&
            /timeout|timed out/i.test(response.errorMessage ?? "")
          )
            transportFailure = "timeout";

          transportFailure ??=
            response.stopReason === "aborted"
              ? "aborted"
              : /timeout|timed out/i.test(response.errorMessage ?? "")
                ? "timeout"
                : "response";
        }

        failurePhase = transportFailure ? failurePhase : "receipt";
        const message = parseResponseReceipt(response);
        const receipt = JSON.stringify(message);

        if (
          Buffer.byteLength(receipt) > (admission.packetReview ? 8 : 1) * 1024 * 1024 ||
          message.usage.output > admission.maxOutputTokens
        )
          throw new Error("Provider response exceeded its reservation");
        await admission.complete(phase, receipt);
        completed = true;
        await admission.end(false);
        admitted = false;
        output.push({ type: "done", reason: message.stopReason, message });
      } catch {
        if (admitted)
          await admission
            .end(!completed, {
              category:
                transportFailure ?? (failurePhase === "admission" ? "admission" : "response"),
              phase: failurePhase,
              elapsedMs: Math.max(0, performance.now() - started),
              httpStatus,
              detail: rejectionDetail ?? "unclassified",
              requestImages,
              requestBytes,
            })
            .catch(() => undefined);

        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "Execution requires review before further provider work.",
          timestamp: Date.now(),
        };

        output.push({ type: "error", reason: "error", error: message });
      }
    })();

    return output;
  };

  const requestOptions = (
    options: ProviderRequestOptions | undefined,
    fetch: FetchFunction,
  ): SimpleStreamOptions => {
    const result: SimpleStreamOptions & { reasoningEffort?: "high" } = {
      apiKey: Redacted.value(configuration.apiKey),
      fetch,
      transport: "sse",
      maxRetries: 0,
      timeoutMs: configuration.timeoutMs ?? (admission.packetReview ? 300_000 : 60_000),
      reasoning: admission.packetReview ? "high" : "low",
    };

    if (admission.packetReview) result.reasoningEffort = "high";

    if (!admission.packetReview || selected.provider !== "baseten")
      result.maxTokens = admission.maxOutputTokens;

    if (options?.signal !== undefined) result.signal = options.signal;

    if (options?.telemetry !== undefined) result.telemetry = options.telemetry;

    return result;
  };

  const models = createModels();
  models.setProvider({
    id: base.id,
    name: base.name,
    auth: {
      apiKey: {
        name: "Private startup credential",
        resolve: async () => ({ auth: { apiKey: Redacted.value(configuration.apiKey) } }),
      },
    },
    getModels: () => [selected],
    stream: (model, context, options) =>
      guarded(model, context, options, (fetch, bounded) =>
        base.stream<Api>(model, bounded, requestOptions(options, fetch)),
      ),
    streamSimple: (model, context, options) =>
      guarded(model, context, options, (fetch, bounded) =>
        // Simple options inject a context-sized output limit. Packet requests on Baseten
        // use the API default; reasoning is already set explicitly in requestOptions.
        admission.packetReview && selected.provider === "baseten"
          ? base.stream<Api>(model, bounded, requestOptions(options, fetch))
          : base.streamSimple(model, bounded, requestOptions(options, fetch)),
      ),
  });

  return {
    models,
    telemetry: identity.telemetry,
    model: { provider: selected.provider, modelId: selected.id },
    capabilities: { contextWindow: selected.contextWindow, maxTokens: selected.maxTokens },
  };
}
