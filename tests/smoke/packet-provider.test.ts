import { expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import { createCanvas } from "@napi-rs/canvas";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { createAdmittedModels } from "../../backend/inference/provider.ts";
import type { RequestPhase } from "../../backend/inference/telemetry.ts";

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

function fixture(provider: "meta" | "baseten" = "meta", packetReview = true, refusals = 0) {
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
  const receipts: string[] = [];
  const phases: RequestPhase[] = [];
  const endings: boolean[] = [];
  const maxOutputTokens = provider === "meta" ? 256000 : 1048576;

  const admitted = createAdmittedModels(
    {
      provider,
      model: provider === "meta" ? "muse-spark-1.3" : "meta-models/muse-spark-open-1026",
      apiKey: Redacted.make(`packet-${provider}-fixture-key`),
      route: "recorded",
      transport: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
        });

        if (requests.length <= refusals)
          return Response.json(
            { error: { message: "Rate limit reached" } },
            { status: 429, headers: { "retry-after": "1" } },
          );

        return response(provider);
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
      end: async (uncertain) => {
        endings.push(uncertain);
      },
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!model) throw new Error("Fixture model not available");

  return { admitted, model, requests, receipts, phases, endings };
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
