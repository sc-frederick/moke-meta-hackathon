import { expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import { createCanvas } from "@napi-rs/canvas";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { type PacerClock, type Refusal, RequestPacer } from "../../backend/inference/pacing.ts";
import { createAdmittedModels } from "../../backend/inference/provider.ts";
import type { RequestPhase } from "../../backend/inference/telemetry.ts";
import type { ProviderFailure } from "#lib/review/execution.ts";

/** Counts events and resolves a wait once a count is reached, so no test sleeps to let work arrive. */
function counter() {
  let count = 0;
  const waiting: Array<{ readonly target: number; readonly resolve: () => void }> = [];

  return {
    get count() {
      return count;
    },
    add() {
      count++;

      for (const waiter of waiting.filter((entry) => entry.target <= count)) waiter.resolve();
    },
    reached(target: number) {
      if (target <= count) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      waiting.push({ target, resolve: reached.resolve });

      return reached.promise;
    },
  };
}

/** A real pacer that reports each acquisition and refusal, so a test moves its clock only after them. */
class SignalledPacer extends RequestPacer {
  readonly acquired = counter();
  readonly refusals = counter();
  /** When each lease was released, stamped on the pacer's clock at the moment of release. */
  readonly released: Array<number> = [];

  override acquire(tokens: number, signal?: AbortSignal) {
    const lease = super.acquire(tokens, signal).then((granted) => {
      this.released.push(granted.dispatchedAt);

      return granted;
    });

    this.acquired.add();

    return lease;
  }

  override refused(refusal: Refusal, dispatchedAt: number, retryAfterMs?: number) {
    const remaining = super.refused(refusal, dispatchedAt, retryAfterMs);
    this.refusals.add();

    return remaining;
  }
}

function response(provider: "meta" | "baseten", outputTokens = 6000) {
  if (provider === "baseten") {
    const chunks = [
      {
        id: "packet-baseten",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Packet review result." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "packet-baseten",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: outputTokens,
          total_tokens: outputTokens + 20,
        },
      },
    ];

    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  const item = {
    type: "message",
    id: "packet-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Packet review result.", annotations: [] }],
  };

  const events = [
    { type: "response.created", response: { id: "packet-response" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "packet-response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: outputTokens, total_tokens: outputTokens + 20 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Optional refusal shape, headers and pacer for one fixture. */
interface FixtureOptions {
  readonly status?: number;
  readonly retryAfter?: string;
  readonly headers?: Record<string, string>;
  readonly pacer?: RequestPacer;
  /** After its refusals, the transport fails as a connection lost after dispatch would. */
  readonly networkFailure?: boolean;
}

function fixture(
  provider: "meta" | "baseten" = "meta",
  packetReview = true,
  refusals = 0,
  options: FixtureOptions = { retryAfter: "1" },
) {
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
  const receipts: string[] = [];
  const phases: RequestPhase[] = [];
  const endings: boolean[] = [];
  const refused: Array<typeof ProviderFailure.Type> = [];
  const sent = counter();
  const maxOutputTokens = provider === "meta" ? 256000 : 1048576;

  const admitted = createAdmittedModels(
    {
      provider,
      model: provider === "meta" ? "muse-spark-1.3" : "meta-models/muse-spark-open-1026",
      apiKey: Redacted.make(`packet-${provider}-fixture-key`),
      route: "recorded",
      pacer: options.pacer ?? new RequestPacer({ requestsPerMinute: 1e9, tokensPerMinute: 1e15 }),
      transport: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
        });
        sent.add();

        if (requests.length <= refusals)
          return Response.json(
            { error: "Rate limit exceeded" },
            {
              status: options.status ?? 429,
              headers:
                options.retryAfter === undefined ? {} : { "retry-after": options.retryAfter },
            },
          );

        if (options.networkFailure) throw new TypeError("fetch failed");
        const answer = response(provider);

        for (const [name, value] of Object.entries(options.headers ?? {}))
          answer.headers.set(name, value);

        return answer;
      },
    },
    {
      packetReview,
      maxInputTokens: 1048576,
      maxOutputTokens,
      begin: async (phase) => {
        phases.push(phase);

        return null;
      },
      send: async () => undefined,
      complete: async (_phase, receipt) => {
        receipts.push(receipt);
      },
      refused: async (_phase, diagnostic) => {
        refused.push(diagnostic);
      },
      end: async (uncertain) => {
        endings.push(uncertain);
      },
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!model) throw new Error("Fixture model not available");

  return { admitted, model, requests, receipts, phases, endings, refused, sent };
}

const generation = {
  name: "pi.durable.phase",
  attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
};

const shortContext = {
  messages: [{ role: "user" as const, content: "Review this packet.", timestamp: 0 }],
};

const MetaRequest = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    max_output_tokens: Schema.Int,
    reasoning: Schema.Struct({ effort: Schema.String }),
    tools: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.String }))),
  }),
);

test("packet requests retain more than 64k text and all eight images and accept native-budget output", async () => {
  const session = fixture();
  const text = "Packet source context. ".repeat(5000);

  const images = Array.from({ length: 8 }, (_, index) => {
    const canvas = createCanvas(16, 16);
    canvas.getContext("2d").fillText(String(index), 1, 12);

    return {
      type: "image" as const,
      mimeType: "image/png",
      data: canvas.toBuffer("image/png").toString("base64"),
    };
  });

  const context = {
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text }, ...images],
        timestamp: 0,
      },
    ],
  };

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, context, {
      telemetry,
      maxTokens: 4096,
      reasoning: "low",
    }),
  );

  expect(answer.stopReason).toBe("stop");
  expect(answer.usage.output).toBe(6000);
  expect(session.requests).toHaveLength(1);
  const captured = session.requests[0];

  if (!captured) throw new Error("No packet request reached transport");
  expect(Buffer.byteLength(text)).toBeGreaterThan(64000);
  expect(captured.body.includes(text)).toBe(true);
  expect(captured.body.split("data:image/png;base64,").length - 1).toBe(8);
  expect(captured.body.includes("Earlier image omitted")).toBe(false);
  const wire = Schema.decodeUnknownSync(MetaRequest)(captured.body);
  expect(wire.max_output_tokens).toBe(256000);
  expect(wire.reasoning.effort).toBe("xhigh");
  expect(wire.tools?.some((tool) => tool.type === "web_search")).toBe(true);

  const catalog = metaProvider()
    .getModels()
    .find((model) => model.id === "muse-spark-1.3");

  // Meta serves Muse Spark 1.3 with a 256k output ceiling above the catalog record.
  expect(catalog?.maxTokens).toBe(131072);
  expect(session.admitted.capabilities.maxTokens).toBe(256000);
  expect(session.receipts).toHaveLength(1);
  expect(session.endings).toEqual([false]);
});

test("the generic SDK completion entrypoint uses the same native output and reasoning policy", async () => {
  const session = fixture();

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.complete(session.model, shortContext, { telemetry, maxTokens: 4096 }),
  );

  expect(answer.stopReason).toBe("stop");
  const wire = Schema.decodeUnknownSync(MetaRequest)(session.requests[0]?.body);
  expect(wire.max_output_tokens).toBe(256000);
  expect(wire.reasoning.effort).toBe("xhigh");
  expect(wire.tools?.some((tool) => tool.type === "web_search")).toBe(true);
  expect(answer.usage.output).toBeGreaterThan(4096);
  expect(session.receipts).toHaveLength(1);
});

test.each(["simple", "generic"] as const)(
  "packet Spark Open preserves provider output defaults through %s",
  async (entrypoint) => {
    const session = fixture("baseten");

    const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      entrypoint === "simple"
        ? session.admitted.models.completeSimple(session.model, shortContext, { telemetry })
        : session.admitted.models.complete(session.model, shortContext, { telemetry }),
    );

    expect(answer.stopReason).toBe("stop");
    expect(answer.usage.output).toBe(6000);
    expect(session.requests).toHaveLength(1);
    const captured = session.requests[0];

    if (!captured) throw new Error("No Baseten request reached transport");

    const wire = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          model: Schema.String,
          reasoning_effort: Schema.String,
          max_tokens: Schema.optional(Schema.Int),
          max_completion_tokens: Schema.optional(Schema.Int),
        }),
      ),
    )(captured.body);

    expect(captured.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(captured.authorization).toBe("Bearer packet-baseten-fixture-key");
    expect(wire.model).toBe("meta-models/muse-spark-open-1026");
    expect(wire.reasoning_effort).toBe("high");
    expect(session.admitted.capabilities.contextWindow).toBe(1048576);
    expect(wire.max_tokens).toBeUndefined();
    expect(wire.max_completion_tokens).toBeUndefined();

    expect(session.receipts).toHaveLength(1);
  },
);

test("only packet review admits the actual compaction summarize phase while invalid phases stay blocked", async () => {
  const phase = {
    name: "pi.durable.phase",
    attributes: { "task.id": 12, "task.name": "pi.compaction", phase: "summarize", attempt: 1 },
  } as const;

  const packet = fixture();

  const answer = await packet.admitted.telemetry.startSpan(phase, (telemetry) =>
    packet.admitted.models.completeSimple(packet.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("stop");
  expect(packet.phases).toEqual([phase.attributes]);
  expect(packet.requests).toHaveLength(1);
  const legacy = fixture("meta", false);

  const denied = await legacy.admitted.telemetry.startSpan(phase, (telemetry) =>
    legacy.admitted.models.completeSimple(legacy.model, shortContext, { telemetry }),
  );

  expect(denied.stopReason).toBe("error");
  expect(legacy.requests).toHaveLength(0);

  const wrong = await packet.admitted.telemetry.startSpan(
    { ...phase, attributes: { ...phase.attributes, phase: "request" } },
    (telemetry) => packet.admitted.models.completeSimple(packet.model, shortContext, { telemetry }),
  );

  expect(wrong.stopReason).toBe("error");
  expect(packet.requests).toHaveLength(1);
});

test("Spark Open retains the latest eight image bytes and all source metadata without changing the durable transcript", async () => {
  const session = fixture("baseten");

  const images = Array.from({ length: 12 }, (_, index) => {
    const canvas = createCanvas(32, 32);
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = `rgb(${index * 20}, 50, 100)`;
    drawing.fillRect(0, 0, 32, 32);

    return {
      type: "image" as const,
      mimeType: "image/png",
      data: canvas.toBuffer("image/png").toString("base64"),
    };
  });

  const context = {
    messages: images.map((part, index) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text: `Exact source artifact-${index}; PDF page ${index + 1}.` },
        part,
      ],
      timestamp: index,
    })),
  };

  const original = JSON.stringify(context);

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, context, { telemetry }),
  );

  expect(answer.stopReason).toBe("stop");
  const body = session.requests[0]?.body ?? "";
  expect(body.split("data:image/png;base64,").length - 1).toBe(8);

  for (const image of images.slice(-8)) expect(body).toContain(image.data);

  for (const image of images.slice(0, 4)) expect(body).not.toContain(image.data);

  for (let index = 0; index < images.length; index++) expect(body).toContain(`artifact-${index}`);
  expect(body).toContain("Earlier image omitted");
  expect(JSON.stringify(context)).toBe(original);
});

test("a rate-limit refusal is resent after the provider delay within one admitted attempt", async () => {
  const session = fixture("meta", true, 1);

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("stop");
  expect(session.requests).toHaveLength(2);
  expect(session.requests[1]?.body).toBe(session.requests[0]?.body);
  expect(session.phases).toHaveLength(1);
  expect(session.receipts).toHaveLength(1);
  expect(session.endings).toEqual([false]);
});

/** Wall time when every test clock starts. */
const startedAt = Date.UTC(2026, 9, 31, 12, 0, 0);

/** Timers fire at once and move the clock to their due time, so backoff costs no test time. */
function instantClock(): PacerClock {
  let now = 0;

  return {
    now: () => now,
    wall: () => startedAt + now,
    schedule: (callback, ms) => {
      const timer = setTimeout(() => {
        now = Math.max(now, now + ms);
        callback();
      }, 0);

      return () => clearTimeout(timer);
    },
    random: () => 1,
  };
}

/** A clock that moves only when the test advances it. */
function heldClock() {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = [];

  const clock: PacerClock = {
    now: () => now,
    wall: () => startedAt + now,
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);

      return () => {
        timer.live = false;
      };
    },
    random: () => 1,
  };

  const advance = (ms: number) => {
    now += ms;

    for (const timer of timers.filter((entry) => entry.live && entry.at <= now)) {
      timer.live = false;
      timer.callback();
    }
  };

  return { clock, advance };
}

test("Baseten rate limits without Retry-After are waited out past six resends in one attempt", async () => {
  // Baseten's 429 carries no Retry-After; the old adapter gave up after six resends.
  const session = fixture("baseten", true, 9, {
    pacer: new RequestPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, instantClock()),
  });

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("stop");
  expect(session.requests).toHaveLength(10);
  expect(new Set(session.requests.map((request) => request.body)).size).toBe(1);
  expect(session.phases).toHaveLength(1);
  expect(session.receipts).toHaveLength(1);
  expect(session.endings).toEqual([false]);
});

test("a request waiting for rate-limit capacity has no durable attempt until it may be sent", async () => {
  const { clock, advance } = heldClock();
  // Two requests a minute hold one at a time and replenish one every 30 seconds.
  const pacer = new SignalledPacer({ requestsPerMinute: 2, tokensPerMinute: 10_000_000 }, clock);
  const session = fixture("baseten", true, 0, { pacer });

  const ask = (signal?: AbortSignal) =>
    session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(
        session.model,
        shortContext,
        signal === undefined ? { telemetry } : { telemetry, signal },
      ),
    );

  expect((await ask()).stopReason).toBe("stop");

  // A cancelled wait never reaches admission, so it leaves no unresolved attempt behind.
  const controller = new AbortController();
  const cancelled = ask(controller.signal);
  await pacer.acquired.reached(2);
  expect(session.phases).toHaveLength(1);
  controller.abort();
  expect((await cancelled).stopReason).toBe("error");
  expect(session.phases).toHaveLength(1);
  expect(session.endings).toEqual([false]);

  const waiting = ask();
  await pacer.acquired.reached(3);
  expect(session.phases).toHaveLength(1);
  advance(30_000);
  expect((await waiting).stopReason).toBe("stop");
  expect(session.phases).toHaveLength(2);
  expect(session.requests).toHaveLength(2);
  expect(session.endings).toEqual([false, false]);
});

test("a capacity refusal holds conversations already waiting for the pacer", async () => {
  const { clock, advance } = heldClock();

  // A 24,000-character request is estimated at 6,000 tokens, and 12,000 tokens a minute hold one
  // at a time, so the peer waits for tokens the refused request then returns.
  const pacer = new SignalledPacer(
    { requestsPerMinute: 1_000_000, tokensPerMinute: 12_000 },
    clock,
  );

  const session = fixture("baseten", true, 1, { status: 529, retryAfter: "10", pacer });

  const context = {
    messages: [{ role: "user" as const, content: "x".repeat(24_000), timestamp: 0 }],
  };

  const ask = () =>
    session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, { telemetry }),
    );

  const refused = ask();
  const peer = ask();
  // The first request was refused and its resend queued behind the waiting peer.
  await pacer.refusals.reached(1);
  await pacer.acquired.reached(3);

  // The refused request returned its tokens, but the cooldown began first.
  expect(session.requests).toHaveLength(1);
  advance(9_999);
  advance(1);
  await session.sent.reached(2);

  // The peer was waiting first, so it goes first. The fixture counts 6,020 tokens for it, so the
  // resend waits about 30 seconds for the bucket to refill.
  expect((await peer).stopReason).toBe("stop");
  expect(session.requests).toHaveLength(2);
  advance(31_000);

  expect((await refused).stopReason).toBe("stop");
  expect(pacer.released).toEqual([0, 10_000, 41_000]);
});

test("provider rate-limit headers set the pacer's limits", async () => {
  const pacer = new RequestPacer({ requestsPerMinute: 3000, tokensPerMinute: 4_000_000 });

  const session = fixture("meta", true, 0, {
    pacer,
    headers: { "x-ratelimit-limit-requests": "1200", "x-ratelimit-limit-tokens": "3000000" },
  });

  await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(pacer.limits).toEqual({ requestsPerMinute: 1200, tokensPerMinute: 3_000_000 });
});

test.each([true, false])(
  "Meta request images are uploaded once and referenced by file ID (upload succeeds: %p)",
  async (uploads) => {
    const sent: Array<{ readonly url: string; readonly body: string }> = [];
    let uploaded = 0;

    const canvas = createCanvas(32, 32);
    canvas.getContext("2d").fillText("7", 10, 20);
    const data = canvas.toBuffer("image/png").toString("base64");

    const admitted = createAdmittedModels(
      {
        provider: "meta",
        model: "muse-spark-1.3",
        apiKey: Redacted.make("packet-meta-fixture-key"),
        route: "recorded",
        imageFiles: true,
        transport: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);

          if (url.endsWith("/files")) {
            uploaded++;
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer packet-meta-fixture-key",
            );

            return uploads
              ? Response.json({ id: "file-fixture-7", purpose: "user_data" })
              : Response.json({ error: { message: "Unavailable" } }, { status: 503 });
          }

          sent.push({ url, body: Schema.decodeUnknownSync(Schema.String)(init?.body) });

          return response("meta");
        },
      },
      {
        packetReview: true,
        maxInputTokens: 1048576,
        maxOutputTokens: 256000,
        cacheKey: () => "moke-sheet-fixture",
        begin: async () => null,
        send: async () => undefined,
        complete: async () => undefined,
        end: async () => undefined,
      },
    );

    const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

    if (!model) throw new Error("Fixture model not available");

    const turn = (text: string) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text },
        { type: "image" as const, mimeType: "image/png", data },
      ],
      timestamp: 0,
    });

    // Two turns of one conversation carry the same delivered image.
    for (const messages of [[turn("First turn.")], [turn("First turn."), turn("Second turn.")]])
      await admitted.telemetry.startSpan(generation, (telemetry) =>
        admitted.models.completeSimple(model, { messages }, { telemetry }),
      );

    expect(sent).toHaveLength(2);
    expect(uploaded).toBe(1);

    const wire = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ prompt_cache_key: Schema.String, prompt_cache_retention: Schema.String }),
      ),
    )(sent[1]?.body);

    expect(wire.prompt_cache_key).toBe("moke-sheet-fixture");
    expect(wire.prompt_cache_retention).toBe("24h");

    for (const request of sent) {
      if (uploads) {
        expect(request.body).not.toContain(data);
        expect(request.body).toContain('"file_id":"file-fixture-7"');
      } else {
        // A failed upload leaves the image inline and is not retried on the next turn.
        expect(request.body).toContain(data);
        expect(request.body).not.toContain("file_id");
      }
    }
  },
);

test.each([
  ["model_not_found", 0, 2, "stop"],
  ["unknown_route", 0, 1, "error"],
  // An unbounded body is never buffered to decide; it fails like any other 404.
  ["model_not_found", 20_000, 1, "error"],
] as const)(
  "a Meta 404 %s refusal with %p padding bytes is resent only when nothing was generated",
  async (code, padding, requests, stopReason) => {
    let sent = 0;

    const admitted = createAdmittedModels(
      {
        provider: "meta",
        model: "muse-spark-1.3",
        apiKey: Redacted.make("packet-meta-fixture-key"),
        route: "recorded",
        transport: async () => {
          sent++;

          if (sent > 1) return response("meta");

          const body = JSON.stringify({
            error: { code, message: "The requested model was not found." },
            padding: "x".repeat(padding),
          });

          // A streamed body has no Content-Length, so only the bytes read can bound it. Chunks
          // arrive on demand, so an oversized body still has unread chunks when reading stops.
          const encoded = new TextEncoder().encode(body);
          let offset = 0;

          return new Response(
            new ReadableStream({
              pull(controller) {
                if (offset >= encoded.length) return controller.close();
                controller.enqueue(encoded.slice(offset, offset + 1024));
                offset += 1024;
              },
            }),
            { status: 404, headers: { "retry-after": "1", "content-type": "application/json" } },
          );
        },
      },
      {
        packetReview: true,
        maxInputTokens: 1048576,
        maxOutputTokens: 256000,
        begin: async () => null,
        send: async () => undefined,
        complete: async () => undefined,
        end: async () => undefined,
      },
    );

    const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

    if (!model) throw new Error("Fixture model not available");

    const answer = await admitted.telemetry.startSpan(generation, (telemetry) =>
      admitted.models.completeSimple(model, shortContext, { telemetry }),
    );

    expect(answer.stopReason).toBe(stopReason);
    expect(sent).toBe(requests);
  },
);

/** Distinct small PNGs, so each image's bytes identify it in a captured request. */
function pictures(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const canvas = createCanvas(32, 32);
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = `rgb(${index * 12}, ${255 - index * 12}, 100)`;
    drawing.fillRect(0, 0, 32, 32);

    return {
      type: "image" as const,
      mimeType: "image/png",
      data: canvas.toBuffer("image/png").toString("base64"),
    };
  });
}

/** A turn the model already answered, so the images before it have reached the model. */
const answered = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Inspected those sources." }],
  api: "openai-completions" as const,
  provider: "baseten",
  model: "meta-models/muse-spark-open-1026",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 0,
};

test.each([
  [9, 8],
  [10, 7],
  [11, 8],
  [13, 6],
  [17, 8],
])(
  "Spark Open delivers every fresh image on its first request with %p images, %p of them new",
  async (total, fresh) => {
    const session = fixture("baseten");
    const images = pictures(total);

    const turn = (index: number) => {
      const image = images[index];

      if (image === undefined) throw new Error("Missing fixture image");

      return {
        role: "user" as const,
        content: [{ type: "text" as const, text: `Exact source artifact-${index}.` }, image],
        timestamp: index,
      };
    };

    const context = {
      messages: [
        ...Array.from({ length: total - fresh }, (_, index) => turn(index)),
        answered,
        ...Array.from({ length: fresh }, (_, index) => turn(total - fresh + index)),
      ],
    };

    const original = JSON.stringify(context);

    const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, { telemetry }),
    );

    expect(answer.stopReason).toBe("stop");
    const body = session.requests[0]?.body ?? "";
    const delivered = body.split("data:image/png;base64,").length - 1;
    expect(delivered).toBeLessThanOrEqual(8);

    for (const image of images.slice(total - fresh)) expect(body).toContain(image.data);
    expect(body.split("Earlier image omitted").length - 1).toBe(total - delivered);

    for (let index = 0; index < total; index++) expect(body).toContain(`artifact-${index}`);
    expect(JSON.stringify(context)).toBe(original);
  },
);

test("forty refusals end the attempt as a definite refusal rather than an unresolved charge", async () => {
  const session = fixture("baseten", true, Number.POSITIVE_INFINITY, {
    retryAfter: "1",
    pacer: new RequestPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, instantClock()),
  });

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("error");
  expect(answer.usage.totalTokens).toBe(0);
  expect(session.requests).toHaveLength(40);
  expect(session.phases).toHaveLength(1);
  expect(session.receipts).toEqual([]);
  expect(session.refused).toEqual([
    expect.objectContaining({ category: "http", httpStatus: 429, detail: "rate_limit" }),
  ]);
  expect(session.endings).toEqual([false]);
});

test("a provider Retry-After of two minutes is waited out in full until the refusal budget ends", async () => {
  const { clock, advance } = heldClock();
  const pacer = new SignalledPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, clock);

  const session = fixture("baseten", true, Number.POSITIVE_INFINITY, {
    status: 529,
    retryAfter: "120",
    pacer,
  });

  const pending = session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  // Sends at 0, 2, 4, 6, 8 and 10 minutes; a seventh could go out only after the budget.
  for (let send = 1; send < 6; send++) {
    await pacer.acquired.reached(send + 1);
    advance(119_999);
    advance(1);
    await session.sent.reached(send + 1);
  }

  const answer = await pending;
  expect(answer.stopReason).toBe("error");

  expect(pacer.released).toEqual([0, 120_000, 240_000, 360_000, 480_000, 600_000]);

  expect(session.receipts).toEqual([]);
  expect(session.refused).toEqual([expect.objectContaining({ category: "http", httpStatus: 529 })]);
  expect(session.endings).toEqual([false]);
});

test("a provider wait beyond the refusal budget ends the attempt without an early resend", async () => {
  const { clock } = heldClock();

  const session = fixture("baseten", true, Number.POSITIVE_INFINITY, {
    retryAfter: "900",
    pacer: new RequestPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, clock),
  });

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("error");
  expect(session.requests).toHaveLength(1);
  expect(clock.now()).toBe(0);
  expect(session.refused).toEqual([expect.objectContaining({ httpStatus: 429 })]);
  expect(session.endings).toEqual([false]);
});

test.each([
  ["an HTTP-date", new Date(startedAt + 90_000).toUTCString(), 90_000],
  // Zero and malformed values ask for no wait, so the local backoff's first 2 seconds apply.
  ["zero", "0", 2000],
  ["a malformed value", "soon", 2000],
] as const)(
  "a refusal with %s as Retry-After is not resent before its wait",
  async (_, value, waitMs) => {
    const { clock, advance } = heldClock();
    const pacer = new SignalledPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, clock);
    const session = fixture("baseten", true, 1, { retryAfter: value, pacer });

    const pending = session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
    );

    await pacer.acquired.reached(2);
    advance(waitMs - 1);
    advance(1);

    expect((await pending).stopReason).toBe("stop");
    expect(pacer.released).toEqual([0, waitMs]);
    expect(session.endings).toEqual([false]);
  },
);

test("cancelling during a provider cooldown leaves the queue and records a definite refusal", async () => {
  const { advance, clock } = heldClock();
  const pacer = new SignalledPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, clock);
  const session = fixture("baseten", true, 1, { retryAfter: "120", pacer });
  const controller = new AbortController();

  const ask = (signal?: AbortSignal) =>
    session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(
        session.model,
        shortContext,
        signal === undefined ? { telemetry } : { telemetry, signal },
      ),
    );

  const cancelled = ask(controller.signal);
  await pacer.acquired.reached(2);
  controller.abort();
  expect((await cancelled).stopReason).toBe("error");
  expect(session.refused).toEqual([expect.objectContaining({ httpStatus: 429 })]);
  expect(session.endings).toEqual([false]);

  // The next conversation waits out the same cooldown, not a cancelled request ahead of it.
  const next = ask();
  await pacer.acquired.reached(3);
  advance(119_999);
  advance(1);
  expect((await next).stopReason).toBe("stop");
  expect(pacer.released).toEqual([0, 120_000]);
});

test("a connection lost after a refused send stays unresolved", async () => {
  const session = fixture("baseten", true, 1, {
    retryAfter: "1",
    networkFailure: true,
    pacer: new RequestPacer({ requestsPerMinute: 100, tokensPerMinute: 2_000_000 }, instantClock()),
  });

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, shortContext, { telemetry }),
  );

  expect(answer.stopReason).toBe("error");
  expect(session.requests).toHaveLength(2);
  expect(session.refused).toEqual([]);
  expect(session.endings).toEqual([true]);
});
