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
import { Predicate, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";
import { parseResponseReceipt } from "./response.ts";
import { createExecutionTelemetry, type RequestPhase } from "./telemetry.ts";

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

/** Durable admission callbacks are implemented with short application SQL operations. */
interface ProviderAdmission {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly begin: (phase: RequestPhase, fingerprint: string) => Promise<string | null>;
  readonly send: (phase: RequestPhase) => Promise<void>;
  readonly complete: (phase: RequestPhase, receipt: string) => Promise<void>;
  readonly end: (uncertain: boolean) => Promise<void>;
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
function boundedImageContext(transcript: TranscriptContext): TranscriptContext {
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

      if (size > 1024 * 1024) throw new Error("Individual source image exceeds its bound");

      if (retained.size < 6 && bytes + size <= 2 * 1024 * 1024) {
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
                text: "Earlier image omitted from the bounded six-image / 2 MiB request window. Its artifact metadata remains available; request a new detail if required.",
              },
        ),
      };
    }),
  };
}

/** Both SDK entrypoints pass the same durable guard, including complete/completeSimple callers. */
export function createAdmittedModels(
  configuration: ProviderConfiguration,
  admission: ProviderAdmission,
) {
  if (configuration.route === "recorded" && configuration.transport === undefined)
    throw new Error("Recorded execution requires a recorded transport");
  const identity = createExecutionTelemetry();
  const base: Provider = configuration.provider === "baseten" ? basetenProvider() : metaProvider();
  const modelId = base.id === "baseten" ? "meta-models/muse-spark-open-1026" : "muse-spark-1.3";

  const baseUrl =
    base.id === "baseten" ? "https://inference.baseten.co/v1" : "https://api.meta.ai/v1";

  if (
    (configuration.model !== undefined && configuration.model !== modelId) ||
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
    contextWindow: 64000,
    maxTokens: 8192,
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

        const bounded = boundedImageContext(transcript);

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

            if (
              dispatched ||
              bounds.textBytes > admission.maxInputTokens ||
              bounds.imageBytes > 2 * 1024 * 1024 ||
              bounds.requestBytes > 3 * 1024 * 1024 ||
              bounds.images > 6
            )
              throw new Error("Transport admission denied");
            dispatched = true;
            await admission.send(phase);

            return (configuration.transport ?? globalThis.fetch)(input, init);
          },
          { preconnect: globalThis.fetch.preconnect },
        );

        // Buffer the final normalized response. No tool can consume a response before its receipt commits.
        const message = parseResponseReceipt(await send(transport, bounded).result());
        const receipt = JSON.stringify(message);

        if (
          Buffer.byteLength(receipt) > 1024 * 1024 ||
          message.usage.output > admission.maxOutputTokens
        )
          throw new Error("Provider response exceeded its reservation");
        await admission.complete(phase, receipt);
        completed = true;
        await admission.end(false);
        admitted = false;
        output.push({ type: "done", reason: message.stopReason, message });
      } catch {
        if (admitted) await admission.end(!completed).catch(() => undefined);

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
    const result: SimpleStreamOptions = {
      apiKey: Redacted.value(configuration.apiKey),
      fetch,
      transport: "sse",
      maxRetries: 0,
      maxTokens: admission.maxOutputTokens,
      timeoutMs: configuration.timeoutMs ?? 60000,
      reasoning: "low",
    };

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
        base.streamSimple(model, bounded, requestOptions(options, fetch)),
      ),
  });

  return {
    models,
    telemetry: identity.telemetry,
    model: { provider: selected.provider, modelId: selected.id },
  };
}
