import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { sha256 } from "../backend/segmentation/fixtures.ts";
import {
  DeviceLabels,
  MetaReviewClient,
  MetaReviewConfig,
  MetaReviewError,
  ProposalDecision,
  type ReviewImage,
} from "../backend/segmentation/meta-review.ts";

const key = "local-contract-key-not-a-real-credential";

function sourceImage(id = "source", color = "black"): ReviewImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="white"/><circle cx="12" cy="12" r="6" fill="none" stroke="${color}"/></svg>`;

  return { id, width: 24, height: 24, bytes: new Resvg(svg).render().asPng() };
}

const unknownLabels = Schema.decodeUnknownSync(DeviceLabels)({
  room: { value: null, quote: "", box: null },
  panel: { value: null, quote: "", box: null },
  circuit: { value: null, quote: "", box: null },
  protection: { value: null, quote: "", box: null },
});

function completion(content: string, finishReason = "stop"): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

async function withAdapter(
  handler: (request: Request) => Response | Promise<Response>,
  work: (directory: string, layer: ReturnType<typeof MetaReviewClient.layer>) => Promise<void>,
  maximumRequests = 8,
) {
  const directory = await mkdtemp(join(tmpdir(), "moke-meta-review-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });

  const config = Schema.decodeUnknownSync(MetaReviewConfig)({
    apiKey: key,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: "muse-spark-1.3",
  });

  try {
    await work(directory, MetaReviewClient.layer(config, directory, maximumRequests));
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

const ReasoningRequest = Schema.Struct({
  model: Schema.Literal("muse-spark-1.3"),
  instructions: Schema.String,
  previous_response_id: Schema.optional(Schema.String),
  input: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("function_call_output"),
        call_id: Schema.String,
        output: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("message"),
        role: Schema.Literal("user"),
        content: Schema.Array(
          Schema.Union([
            Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
            Schema.Struct({ type: Schema.Literal("input_image"), image_url: Schema.String }),
          ]),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("message"),
        role: Schema.Literal("assistant"),
        phase: Schema.optional(Schema.String),
        content: Schema.Array(
          Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("function_call"),
        call_id: Schema.String,
        name: Schema.String,
        arguments: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("reasoning"),
        summary: Schema.Array(Schema.JsonObject),
        encrypted_content: Schema.String,
      }),
    ]),
  ),
  tools: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("function"),
      name: Schema.String,
      description: Schema.String,
      parameters: Schema.JsonObject,
    }),
  ),
  tool_choice: Schema.Literal("auto"),
  parallel_tool_calls: Schema.Literal(false),
  stream: Schema.Literal(false),
  store: Schema.Literal(false),
  include: Schema.Array(Schema.Literal("reasoning.encrypted_content")),
});

test("Responses continuation carries the originating call and new image evidence without leaking payloads", async () => {
  const requests: Array<typeof ReasoningRequest.Type> = [];
  const credentials: Array<string | null> = [];
  const image = sourceImage();
  const feedback = sourceImage("zoom-overlay", "blue");

  const tools = [
    {
      name: "inspect_region",
      description: "Read original source around an unresolved target.",
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
    },
  ];

  await withAdapter(
    async (request) => {
      requests.push(
        Schema.decodeUnknownSync(Schema.fromJsonString(ReasoningRequest))(await request.text()),
      );
      credentials.push(request.headers.get("authorization"));

      return requests.length === 1
        ? Response.json({
            id: "response-first",
            status: "completed",
            output: [
              { type: "reasoning", encrypted_content: "opaque-encrypted-reasoning" },
              {
                type: "function_call",
                call_id: "call-inspect",
                name: "inspect_region",
                arguments: '{"target":"blind-1"}',
              },
              {
                type: "message",
                phase: "commentary",
                content: [{ type: "output_text", text: "Inspect the unmatched proposal." }],
              },
            ],
          })
        : Response.json({
            id: "response-second",
            status: "completed",
            output: [
              { type: "message", content: [{ type: "output_text", text: "Evidence gathered." }] },
            ],
          });
    },
    async (directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          const common = {
            instructions: "Use drawing evidence.",
            prompt: "Inspect this room.",
            tools,
            image,
          };

          const first = yield* client.turn({ ...common, continuation: undefined, results: [] });

          const second = yield* client.turn({
            ...common,
            continuation: first.continuation,
            results: [
              {
                actionId: "call-inspect",
                data: { target: "blind-1", evidence: "visible arc" },
                images: [feedback],
              },
            ],
          });

          return { first, second };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.first).toMatchObject({
        continuation: "response-first",
        actions: [
          { id: "call-inspect", name: "inspect_region", arguments: '{"target":"blind-1"}' },
        ],
        message: "Inspect the unmatched proposal.",
      });
      expect(result.second).toEqual({
        continuation: "response-second",
        actions: [],
        message: "Evidence gathered.",
      });
      expect(credentials).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.previous_response_id).toBeUndefined();
      expect(requests[1]?.previous_response_id).toBeUndefined();
      expect(requests[1]?.include).toEqual(["reasoning.encrypted_content"]);
      expect(requests[1]?.input).toEqual([
        ...(requests[0]?.input ?? []),
        { type: "reasoning", summary: [], encrypted_content: "opaque-encrypted-reasoning" },
        {
          type: "function_call",
          call_id: "call-inspect",
          name: "inspect_region",
          arguments: '{"target":"blind-1"}',
        },
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Inspect the unmatched proposal." }],
        },
        {
          type: "function_call_output",
          call_id: "call-inspect",
          output: JSON.stringify({ target: "blind-1", evidence: "visible arc" }),
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Evidence image zoom-overlay: 24x24." },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${Buffer.from(feedback.bytes).toString("base64")}`,
            },
          ],
        },
      ]);
      expect(requests[1]?.tools).toEqual(requests[0]?.tools);

      const secondImages = requests[1]?.input
        .filter((item) => item.type === "message" && item.role === "user")
        .flatMap((item) => item.content)
        .filter((part) => part.type === "input_image");

      expect(secondImages).toEqual([
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
        },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(feedback.bytes).toString("base64")}`,
        },
      ]);

      const metadata = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            continuation: Schema.String,
            results: Schema.Array(
              Schema.Struct({
                images: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    sha256: Schema.String,
                    width: Schema.Int,
                    height: Schema.Int,
                  }),
                ),
              }),
            ),
          }),
        ),
      )(await Bun.file(join(directory, "002-request.json")).text());

      expect(metadata.continuation).toBe("response-first");
      expect(metadata.results[0]?.images).toEqual([
        { id: feedback.id, sha256: sha256(feedback.bytes), width: 24, height: 24 },
      ]);

      for (const filename of await readdir(directory)) {
        const text = await Bun.file(join(directory, filename)).text();

        expect(text).not.toContain(key);
        expect(text).not.toContain("Bearer ");
        expect(text).not.toContain("data:image/png;base64,");
        expect(text).not.toContain(Buffer.from(image.bytes).toString("base64"));
        expect(text).not.toContain(Buffer.from(feedback.bytes).toString("base64"));
      }
    },
  );
});

const VisionRequest = Schema.Struct({
  model: Schema.Literal("muse-spark-1.3"),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literal("user"),
      content: Schema.Array(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
          Schema.Struct({
            type: Schema.Literal("image_url"),
            image_url: Schema.Struct({ url: Schema.String }),
          }),
        ]),
      ),
    }),
  ),
  response_format: Schema.Struct({
    type: Schema.Literal("json_schema"),
    json_schema: Schema.Struct({ strict: Schema.Literal(true), schema: Schema.JsonObject }),
  }),
});

const proposals = [
  { id: "sam-0", box: { left: 100, top: 100, right: 400, bottom: 400 } },
  { id: "sam-1", box: { left: 600, top: 600, right: 900, bottom: 900 } },
];

test("classification preserves supplied IDs and sends original and marked images under structured output", async () => {
  const requests: Array<typeof VisionRequest.Type> = [];

  const decisions = Schema.decodeUnknownSync(Schema.Array(ProposalDecision))([
    {
      id: "sam-0",
      kind: "receptacle",
      labels: unknownLabels,
      rationale: "Two visible parallel strokes.",
    },
    { id: "sam-1", kind: "other", labels: unknownLabels, rationale: "A furniture pivot." },
  ]);

  await withAdapter(
    async (request) => {
      requests.push(
        Schema.decodeUnknownSync(Schema.fromJsonString(VisionRequest))(await request.text()),
      );

      return completion(JSON.stringify({ decisions }));
    },
    async (directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          return yield* client.classify(sourceImage(), proposals);
        }).pipe(Effect.provide(layer)),
      );

      expect(result.decisions).toEqual(decisions);

      const images = requests[0]?.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "image_url");

      expect(images).toHaveLength(2);
      expect(images?.[0]?.image_url.url).not.toBe(images?.[1]?.image_url.url);
      const requestArtifact = await Bun.file(join(directory, "001-request.json")).text();

      expect(requestArtifact).not.toContain("data:image/png;base64,");
      expect(requestArtifact).not.toContain(key);
    },
  );
});

test.each([
  { label: "missing", ids: ["sam-0"] },
  { label: "duplicate", ids: ["sam-0", "sam-0"] },
  { label: "unknown", ids: ["sam-0", "invented-99"] },
])(
  "classification rejects $label output IDs rather than inventing accepted objects",
  async ({ ids }) => {
    await withAdapter(
      () =>
        completion(
          JSON.stringify({
            decisions: ids.map((id) => ({
              id,
              kind: "receptacle",
              labels: unknownLabels,
              rationale: "candidate",
            })),
          }),
        ),
      async (_directory, layer) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* MetaReviewClient;

            return yield* Effect.result(client.classify(sourceImage(), proposals));
          }).pipe(Effect.provide(layer)),
        );

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(MetaReviewError);
          expect(result.failure.message).toBe(
            "Classification must cover each supplied ID exactly once.",
          );
        }
      },
    );
  },
);

test.each([
  { label: "invalid outer JSON", response: "{not-json" },
  { label: "missing choices", response: "{}" },
  { label: "empty choices", response: JSON.stringify({ choices: [] }) },
  {
    label: "null content",
    response: JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "stop" }] }),
  },
  {
    label: "invalid observation JSON",
    response: JSON.stringify({
      choices: [{ message: { content: "not-json" }, finish_reason: "stop" }],
    }),
  },
  {
    label: "length exhaustion despite JSON content",
    response: JSON.stringify({
      choices: [{ message: { content: '{"objects":[]}' }, finish_reason: "length" }],
    }),
  },
])("vision rejects $label without accepting an empty inventory", async ({ response }) => {
  await withAdapter(
    () => new Response(response, { headers: { "Content-Type": "application/json" } }),
    async (_directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          return yield* Effect.result(client.inventory(sourceImage(), false));
        }).pipe(Effect.provide(layer)),
      );

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(MetaReviewError);
    },
  );
});

test("a non-completed Responses envelope cannot dispatch apparently valid tool actions", async () => {
  await withAdapter(
    () =>
      Response.json({
        id: "incomplete-response",
        status: "incomplete",
        output: [
          {
            type: "function_call",
            call_id: "call-unsafe",
            name: "inspect_region",
            arguments: "{}",
          },
        ],
      }),
    async (_directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          return yield* Effect.result(
            client.turn({
              instructions: "inspect",
              prompt: "room",
              tools: [],
              image: sourceImage(),
              continuation: undefined,
              results: [],
            }),
          );
        }).pipe(Effect.provide(layer)),
      );

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result))
        expect(result.failure.message).toBe("Invalid or incomplete Meta reasoning response.");
    },
  );
});

test.each([
  { label: "missing", reasoning: { type: "reasoning" } },
  { label: "empty", reasoning: { type: "reasoning", encrypted_content: "" } },
])(
  "reasoning with $label encrypted replay state cannot dispatch tool actions",
  async ({ reasoning }) => {
    await withAdapter(
      () =>
        Response.json({
          id: "invalid-replay-state",
          status: "completed",
          output: [
            reasoning,
            {
              type: "function_call",
              call_id: "call-inspect",
              name: "inspect_region",
              arguments: "{}",
            },
          ],
        }),
      async (_directory, layer) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* MetaReviewClient;

            return yield* Effect.result(
              client.turn({
                instructions: "inspect",
                prompt: "room",
                tools: [],
                image: sourceImage(),
                continuation: undefined,
                results: [],
              }),
            );
          }).pipe(Effect.provide(layer)),
        );

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result))
          expect(result.failure.message).toBe("Invalid or incomplete Meta reasoning response.");
      },
    );
  },
);

test("a continuation from another session is rejected before HTTP and leaves local replay usable", async () => {
  let requests = 0;

  await withAdapter(
    () => {
      requests += 1;

      return Response.json({ id: `response-${requests}`, status: "completed", output: [] });
    },
    async (directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          const common = {
            instructions: "inspect",
            prompt: "room",
            tools: [],
            image: sourceImage(),
            results: [],
          };

          const rejected = yield* Effect.result(
            client.turn({ ...common, continuation: "another-session" }),
          );

          const filesAfterRejection = yield* Effect.promise(() => readdir(directory));
          const first = yield* client.turn({ ...common, continuation: undefined });
          const second = yield* client.turn({ ...common, continuation: first.continuation });

          return { rejected, filesAfterRejection, second };
        }).pipe(Effect.provide(layer)),
      );

      expect(Result.isFailure(result.rejected)).toBe(true);

      if (Result.isFailure(result.rejected))
        expect(result.rejected.failure.message).toBe(
          "Review continuation does not match this session.",
        );

      expect(result.filesAfterRejection).toEqual([]);
      expect(requests).toBe(2);
      expect(result.second.continuation).toBe("response-2");
    },
    2,
  );
});

test("one session's request budget covers vision and reasoning before another HTTP or artifact", async () => {
  const paths: Array<string> = [];

  await withAdapter(
    (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);

      return path.endsWith("responses")
        ? Response.json({ id: "response", status: "completed", output: [] })
        : completion('{"objects":[]}');
    },
    async (directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;
          yield* client.inventory(sourceImage(), false);
          yield* client.turn({
            instructions: "inspect",
            prompt: "room",
            tools: [],
            image: sourceImage(),
            continuation: undefined,
            results: [],
          });

          return yield* Effect.result(client.inventory(sourceImage(), true));
        }).pipe(Effect.provide(layer)),
      );

      expect(paths).toEqual(["/v1/chat/completions", "/v1/responses"]);
      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result))
        expect(result.failure.message).toBe("Meta request budget exhausted.");

      expect((await readdir(directory)).sort()).toEqual([
        "001-request.json",
        "001-response.json",
        "002-request.json",
        "002-response.json",
      ]);
    },
    2,
  );
});

test("concurrent observations share the same hard request ceiling", async () => {
  let requests = 0;

  await withAdapter(
    () => {
      requests += 1;

      return completion('{"objects":[]}');
    },
    async (_directory, layer) => {
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;

          return yield* Effect.all(
            [
              Effect.result(client.inventory(sourceImage("first"), false)),
              Effect.result(client.inventory(sourceImage("second"), true)),
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.provide(layer)),
      );

      expect(requests).toBe(1);
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
    },
    1,
  );
});

test("HTTP failures are saved, consume budget and do not trigger automatic retries", async () => {
  let requests = 0;
  const body = JSON.stringify({ error: { message: "quota unavailable" } });

  await withAdapter(
    () => {
      requests += 1;

      return new Response(body, { status: 429 });
    },
    async (directory, layer) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* MetaReviewClient;
          const first = yield* Effect.result(client.inventory(sourceImage(), false));
          const second = yield* Effect.result(client.inventory(sourceImage(), false));

          return { first, second };
        }).pipe(Effect.provide(layer)),
      );

      expect(requests).toBe(1);
      expect(Result.isFailure(result.first)).toBe(true);
      expect(Result.isFailure(result.second)).toBe(true);

      if (Result.isFailure(result.first)) expect(result.first.failure.status).toBe(429);

      if (Result.isFailure(result.second))
        expect(result.second.failure.message).toBe("Meta request budget exhausted.");

      expect(await Bun.file(join(directory, "001-response.json")).text()).toBe(body);
    },
    1,
  );
});
