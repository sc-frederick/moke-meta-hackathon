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
import { type PacerLease, type Refusal, RequestPacer, sharedPacer } from "./pacing.ts";
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
  /**
   * Upload Meta request images to the Files API once and reference them by ID instead of resending
   * base64 on every turn. Defaults to on for live routes; recorded tests opt in.
   */
  readonly imageFiles?: boolean;
  /**
   * Paces requests within the credential's rate limits. Live routes share one pacer per key in
   * the process; recorded routes get a private pacer unless a test supplies one.
   */
  readonly pacer?: RequestPacer;
}

/** Meta serves Muse Spark 1.3 with a larger output ceiling than Pi's catalog records (checked 2026-10-29). */
const metaOutputCeilings = new Map([["muse-spark-1.3", 256_000]]);

/** Meta packet reviews reason at the extra-high level Meta's console uses for Muse Spark 1.3. */
const packetReasoning = (provider: string) => (provider === "meta" ? "xhigh" : "high");

/** Meta runs this search server-side and returns cited text; read_source still records evidence. */
const metaWebSearch = { type: "web_search", search_context_size: "high" } as const;

/** Meta deletes uploaded request images after a day; a reference is reused until an hour before. */
const imageFileLifetimeSeconds = 24 * 60 * 60;

/** A failed upload falls back to inline base64 and is not retried for five minutes. */
const imageFileRetryMs = 5 * 60_000;

const MetaFile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^file-[A-Za-z0-9_-]{1,128}$/)),
});

/** Fields the adapter adds to or replaces in Meta's Responses payload. */
interface MetaPayloadChanges {
  input?: Schema.MutableJson;
  tools?: Array<Schema.MutableJson>;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
}

const ModelNotFound = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("model_not_found") }) }),
);

/**
 * A refused request generated nothing, so it can be resent for as long as this budget allows. The
 * provider's limits replenish within a minute; a longer refusal is an outage, not a rate limit.
 */
const refusalBudgetMs = 10 * 60_000;
const maxRefusals = 40;

/** Allowances a recorded transport never reaches. */
const unpacedLimits = { requestsPerMinute: 1e9, tokensPerMinute: 1e15 } as const;

/** Rough request size for pacing: four characters a token, plus an allowance for each image. */
function pacingEstimate(transcript: TranscriptContext) {
  let characters = 0;
  let images = 0;

  for (const message of transcript.messages) {
    if (Predicate.isString(message.content)) {
      characters += message.content.length;
      continue;
    }

    for (const part of message.content)
      if (part.type === "image") images++;
      else if (part.type === "text") characters += part.text.length;
      else if (part.type === "thinking") characters += part.thinking.length;
      else characters += JSON.stringify(part.arguments).length;
  }

  return Math.ceil(characters / 4) + images * 1500;
}

/** A dispatch the provider refused before generating anything, kept to decide how to resend it. */
interface RefusedDispatch {
  readonly kind: Refusal | "model_not_found";
  readonly response: Response;
}

/** Provider-requested wait in milliseconds, when it sends Retry-After seconds. */
function retryAfterMs(response: Response) {
  const requested = Number(response.headers.get("retry-after"));

  return Number.isFinite(requested) && requested > 0 ? requested * 1000 : undefined;
}

/**
 * Why a response refused the request before generating anything: a rate limit (429), missing
 * serving capacity (529), or Meta's intermittent 404 `model_not_found` for a served model (about
 * one request in eight for one team's key on 2026-10-30).
 */
async function refusalOf(response: Response): Promise<Refusal | "model_not_found" | undefined> {
  if (response.status === 429) return "rate_limit";

  if (response.status === 529) return "overloaded";

  if (response.status !== 404) return undefined;
  const reader = response.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  if (reader) {
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        bytes += part.value.length;

        if (bytes > 16384) return undefined;
        chunks.push(part.value);
      }
    } finally {
      // Cancelling a clone settles only once the original body is read, which happens later.
      void reader.cancel().catch(() => undefined);
    }
  }

  return Option.isSome(
    Schema.decodeUnknownOption(ModelNotFound)(Buffer.concat(chunks).toString("utf8")),
  )
    ? "model_not_found"
    : undefined;
}

/**
 * Wait before resending one request after a routing refusal, honouring Retry-After seconds. Rate
 * limits and capacity refusals wait in the shared pacer instead, so all conversations back off.
 */
function refusalDelay(response: Response, retry: number) {
  const requested = retryAfterMs(response);
  const backoff = Math.min(60_000, 2_000 * 2 ** retry);

  return requested === undefined
    ? backoff / 2 + Math.random() * (backoff / 2)
    : Math.min(60_000, requested);
}

/** Short, stable routing key for one shared prompt prefix; it carries no names or prompt text. */
export function promptCacheKey(role: string, ...prefix: ReadonlyArray<string>) {
  const digest = createHash("sha256").update(JSON.stringify(prefix)).digest("hex");

  return `moke-${role}-${digest.slice(0, 32)}`;
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

  return {
    contextWindow: model.contextWindow,
    maxOutputTokens: metaOutputCeilings.get(modelId) ?? model.maxTokens,
  };
}

/** Durable admission callbacks are implemented with short application SQL operations. */
interface ProviderAdmission {
  readonly maxInputTokens: number;
  readonly packetReview?: boolean;
  readonly maxOutputTokens: number;
  /**
   * Requests that share a prompt prefix share one key, so the provider routes them to the backend
   * already holding that prefix. Meta advises one key per shared prefix rather than per session.
   */
  readonly cacheKey?: (phase: RequestPhase) => string | undefined;
  readonly begin: (phase: RequestPhase, fingerprint: string) => Promise<string | null>;
  readonly send: (phase: RequestPhase) => Promise<void>;
  readonly complete: (phase: RequestPhase, receipt: string) => Promise<void>;
  readonly end: (
    uncertain: boolean,
    diagnostic?: typeof ProviderFailure.Type,
    phase?: RequestPhase,
  ) => Promise<void>;
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

    if (Predicate.isObject(value)) {
      // Uploaded images are sent as Files API references; their bytes were bounded before upload.
      if (value.type === "input_image" && Predicate.isString(value.file_id)) images++;

      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          withoutPixels(Schema.decodeUnknownSync(Schema.MutableJson)(child)),
        ]),
      );
    }

    return value;
  };

  const textBytes = Buffer.byteLength(JSON.stringify(withoutPixels(payload)));

  return { textBytes, imageBytes, images, requestBytes: Buffer.byteLength(body) };
}

/**
 * Keep recent delivered pixels in a bounded stateless request; retain all source metadata and receipts.
 * The window drops the oldest images `step` at a time, so an earlier request position changes once
 * per step instead of on every new image. Each change recomputes the provider's cached prefix.
 * Images after the latest assistant turn have never reached the model, so the window drops only
 * older images to make room for them. A fresh batch beyond the bounds keeps its newest images.
 */
function boundedImageContext(
  transcript: TranscriptContext,
  limits = { images: 6, step: 3, imageBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 },
): TranscriptContext {
  const images: Array<{ readonly part: ImageContent; readonly bytes: number }> = [];
  let seen = 0;

  for (const message of transcript.messages) {
    if (message.role === "assistant") seen = images.length;

    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      Predicate.isString(message.content)
    )
      continue;

    for (const part of message.content) {
      if (part.type !== "image") continue;
      const bytes = Buffer.byteLength(part.data, "base64");

      if (bytes > limits.imageBytes) throw new Error("Individual source image exceeds its bound");
      images.push({ part, bytes });
    }
  }

  // The step stops short at the first fresh image, then resumes once those images are older.
  const firstFresh = Math.max(seen, images.length - limits.images);

  let cut =
    images.length <= limits.images
      ? 0
      : Math.min(
          firstFresh,
          Math.ceil((images.length - limits.images) / limits.step) * limits.step,
        );

  const retainedBytes = () => images.slice(cut).reduce((total, image) => total + image.bytes, 0);

  while (cut < firstFresh && retainedBytes() > limits.totalBytes)
    cut = Math.min(firstFresh, cut + limits.step);

  while (cut < images.length - 1 && retainedBytes() > limits.totalBytes) cut++;

  const retained = new Set(images.slice(cut).map((image) => image.part));

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
  const selected: Model<Api> = catalog
    ? { ...catalog, maxTokens: metaOutputCeilings.get(catalog.id) ?? catalog.maxTokens }
    : {
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

  // A recorded transport replays at full speed; it still waits out refusals like a live route.
  const pacer =
    configuration.pacer ??
    (configuration.route === "live"
      ? sharedPacer(selected.provider === "baseten" ? "baseten" : "meta", configuration.apiKey)
      : new RequestPacer(unpacedLimits));

  const imageFiles =
    selected.provider === "meta" && (configuration.imageFiles ?? configuration.route === "live")
      ? new Map<string, { readonly id: Promise<string | null>; readonly reusableUntil: number }>()
      : undefined;

  /** Upload one delivered image once; concurrent requests for the same bytes share the upload. */
  const imageFileId = (files: NonNullable<typeof imageFiles>, image: string) => {
    const sha256 = createHash("sha256").update(image).digest("hex");
    const known = files.get(sha256);

    if (known !== undefined && known.reusableUntil > Date.now()) return known.id;
    const mediaType = image.slice("data:".length, image.indexOf(";"));

    const id = (async () => {
      const form = new FormData();
      form.append("purpose", "user_data");
      form.append("expires_after[anchor]", "created_at");
      form.append("expires_after[seconds]", String(imageFileLifetimeSeconds));
      form.append(
        "file",
        new File(
          [Buffer.from(image.slice(image.indexOf(",") + 1), "base64")],
          `${sha256}.${mediaType.slice("image/".length)}`,
          { type: mediaType },
        ),
      );

      const response = await (configuration.transport ?? globalThis.fetch)(`${baseUrl}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Redacted.value(configuration.apiKey)}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        await response.body?.cancel();

        return null;
      }

      return Option.getOrNull(
        Option.map(Schema.decodeUnknownOption(MetaFile)(await response.json()), (file) => file.id),
      );
    })().catch(() => null);

    files.set(sha256, {
      id,
      reusableUntil: Date.now() + (imageFileLifetimeSeconds - 3600) * 1000,
    });
    void id.then((uploaded) => {
      if (uploaded === null)
        files.set(sha256, { id, reusableUntil: Date.now() + imageFileRetryMs });
    });

    return id;
  };

  /** Replace inline images with Files API references; an image whose upload failed stays inline. */
  const referenceImages = async (value: Schema.MutableJson): Promise<Schema.MutableJson> => {
    if (imageFiles === undefined) return value;

    if (Array.isArray(value)) return Promise.all(value.map(referenceImages));

    if (!Predicate.isObject(value)) return value;

    const entries = Object.entries(value).map(
      ([key, child]) => [key, Schema.decodeUnknownSync(Schema.MutableJson)(child)] as const,
    );

    const image = entries.find(([key]) => key === "image_url")?.[1];

    if (
      entries.some(([key, child]) => key === "type" && child === "input_image") &&
      Predicate.isString(image) &&
      image.startsWith("data:image/")
    ) {
      const id = await imageFileId(imageFiles, image);

      return id === null
        ? value
        : Object.fromEntries([...entries.filter(([key]) => key !== "image_url"), ["file_id", id]]);
    }

    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([key, child]) => [key, await referenceImages(child)] as const),
      ),
    );
  };

  const guarded = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options: ProviderRequestOptions | undefined,
    send: (
      fetch: FetchFunction,
      context: TranscriptContext,
      cacheKey: string | undefined,
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
      let phase: RequestPhase | undefined;
      let estimate = 0;
      let lease: PacerLease | undefined;
      let dispatched = false;
      let dispatchedAt = 0;
      let refusal: RefusedDispatch | undefined;

      /** Reset the per-dispatch outcome before the SDK sends, or resends, the request. */
      const nextDispatch = (current: PacerLease) => {
        dispatchedAt = current.dispatchedAt;
        dispatched = false;
        refusal = undefined;
        httpStatus = null;
        rejectionDetail = undefined;
        transportFailure = undefined;
      };

      try {
        phase = identity.phase(options?.telemetry);

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
                step: 4,
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

        estimate = pacingEstimate(bounded);
        // Wait for rate-limit capacity before the durable attempt exists, so a cancel or shutdown
        // while waiting leaves nothing unresolved. The SDK's deadline starts after this wait.
        lease = await pacer.acquire(estimate, options?.signal);
        const cached = await admission.begin(phase, fingerprint);
        admitted = true;

        if (cached !== null) {
          lease.refund();
          lease = undefined;
          const message = parseResponseReceipt(JSON.parse(cached));
          completed = true;
          await admission.end(false, undefined, phase);
          admitted = false;
          output.push({ type: "done", reason: message.stopReason, message });

          return;
        }

        const dispatchPhase = phase;
        let sent = false;

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

            // One durable attempt covers every resend of a request the provider refused.
            if (!sent) {
              await admission.send(dispatchPhase);
              sent = true;
            }

            failurePhase = "dispatch";

            try {
              const dispatch = configuration.transport ?? globalThis.fetch;
              const response = await dispatch(input, init);

              httpStatus = response.status;
              failurePhase = "response";

              // A rate-limit, capacity or model-routing refusal happens before generation, so
              // resending it cannot duplicate paid work. Parallel sheet reviewers rely on this.
              const refused = await refusalOf(response);

              // Start the shared cooldown before anything returns capacity to the pacer, or a
              // waiting conversation would be released into the same refusal.
              if (refused === "rate_limit" || refused === "overloaded")
                pacer.refused(refused, dispatchedAt, retryAfterMs(response));

              pacer.observe(response.headers);

              if (refused !== undefined) {
                refusal = { kind: refused, response };
                await response.body?.cancel();
                transportFailure = "http";
                rejectionDetail = refused === "rate_limit" ? "rate_limit" : "unclassified";

                return Response.json(
                  { error: { message: `Provider refused request: ${rejectionDetail}` } },
                  { status: response.status },
                );
              }

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

        let response: AssistantMessage | undefined;

        // The first dispatch uses the capacity reserved before admission. Each resend is a fresh
        // SDK call, so its deadline covers one dispatch and none of the waiting.
        for (let refusals = 0; response === undefined; refusals++) {
          const current = lease ?? (await pacer.acquire(estimate, options?.signal));
          lease = current;
          nextDispatch(current);

          // Buffer the final normalized response. No tool can consume a response before its
          // receipt commits.
          const result = await send(
            transport,
            bounded,
            admission.cacheKey?.(dispatchPhase),
          ).result();

          const refused = refusal;
          lease = undefined;

          if (refused === undefined) {
            pacer.accepted(current.dispatchedAt);
            current.settle(
              result.stopReason === "error" || result.stopReason === "aborted"
                ? estimate
                : result.usage.input +
                    result.usage.cacheRead +
                    result.usage.cacheWrite +
                    result.usage.output,
            );
            response = result;
            continue;
          }

          // A refused request counted against the request limit but used no tokens.
          current.settle(0);

          if (
            refusals + 1 >= maxRefusals ||
            performance.now() - started > refusalBudgetMs ||
            options?.signal?.aborted
          )
            response = result;
          // Rate limits and capacity refusals already started the shared cooldown.
          else if (refused.kind === "model_not_found")
            await Bun.sleep(refusalDelay(refused.response, refusals));
        }

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
        await admission.end(false, undefined, phase);
        admitted = false;
        output.push({ type: "done", reason: message.stopReason, message });
      } catch {
        // A request that reached the provider keeps its reservation; one never sent returns it.
        if (dispatched) lease?.settle(estimate);
        else lease?.refund();

        if (admitted)
          await admission
            .end(
              !completed,
              {
                category:
                  transportFailure ?? (failurePhase === "admission" ? "admission" : "response"),
                phase: failurePhase,
                elapsedMs: Math.max(0, performance.now() - started),
                httpStatus,
                detail: rejectionDetail ?? "unclassified",
                requestImages,
                requestBytes,
              },
              phase,
            )
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
    cacheKey: string | undefined,
  ): SimpleStreamOptions => {
    const effort = packetReasoning(selected.provider);

    const result: SimpleStreamOptions & { reasoningEffort?: "high" | "xhigh" } = {
      apiKey: Redacted.value(configuration.apiKey),
      fetch,
      transport: "sse",
      maxRetries: 0,
      timeoutMs: configuration.timeoutMs ?? (admission.packetReview ? 300_000 : 60_000),
      reasoning: admission.packetReview ? effort : "low",
    };

    if (admission.packetReview) result.reasoningEffort = effort;

    // Pi's per-conversation session ID is deliberately not forwarded: sheet reviewers share a prefix.
    if (selected.provider === "meta")
      result.onPayload = async (payload) => {
        if (!Predicate.isObject(payload)) return payload;
        const changes: MetaPayloadChanges = {};

        // The SDK payload holds undefined fields; read it the way the request body serializes it.
        if (imageFiles !== undefined && payload.input !== undefined)
          changes.input = await referenceImages(
            Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(payload.input))),
          );

        if (admission.packetReview)
          changes.tools = [...(Array.isArray(payload.tools) ? payload.tools : []), metaWebSearch];

        if (cacheKey !== undefined) {
          changes.prompt_cache_key = cacheKey;
          changes.prompt_cache_retention = "24h";
        }

        return { ...payload, ...changes };
      };
    // Baseten routes cache hits by replica affinity rather than a request field.
    else if (cacheKey !== undefined) result.headers = { "x-session-affinity": cacheKey };

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
      guarded(model, context, options, (fetch, bounded, cacheKey) =>
        base.stream<Api>(model, bounded, requestOptions(options, fetch, cacheKey)),
      ),
    streamSimple: (model, context, options) =>
      guarded(model, context, options, (fetch, bounded, cacheKey) =>
        // Simple options inject a context-sized output limit. Packet requests on Baseten
        // use the API default; reasoning is already set explicitly in requestOptions.
        admission.packetReview && selected.provider === "baseten"
          ? base.stream<Api>(model, bounded, requestOptions(options, fetch, cacheKey))
          : base.streamSimple(model, bounded, requestOptions(options, fetch, cacheKey)),
      ),
  });

  return {
    models,
    telemetry: identity.telemetry,
    model: { provider: selected.provider, modelId: selected.id },
    capabilities: { contextWindow: selected.contextWindow, maxTokens: selected.maxTokens },
  };
}
