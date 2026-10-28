import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { sha256 } from "./fixtures.ts";
import { SamConfig } from "./sam.ts";

const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

/** A vision model's normalized box on the image it was actually shown. */
export const VisionBox = Schema.Struct({
  left: Coordinate,
  top: Coordinate,
  right: Coordinate,
  bottom: Coordinate,
});

/** A source assertion; unknown is explicit and must not become a protection finding. */
export const VisualAssertion = Schema.Struct({
  value: Schema.NullOr(Schema.NonEmptyString),
  quote: Schema.String,
  box: Schema.NullOr(VisionBox),
});

/** Independently attributable room, panel, circuit and visible protection notation. */
export const DeviceLabels = Schema.Struct({
  room: VisualAssertion,
  panel: VisualAssertion,
  circuit: VisualAssertion,
  protection: VisualAssertion,
});

const Guidance = Schema.Struct({
  positive: Schema.Struct({ x: Coordinate, y: Coordinate }),
  negative: Schema.NullOr(Schema.Struct({ x: Coordinate, y: Coordinate })),
});

/** One model-proposed device, with geometry and assertions kept separate. */
export const VisualDevice = Schema.Struct({
  box: VisionBox,
  labels: DeviceLabels,
  rationale: Schema.String,
  guidance: Schema.NullOr(Guidance),
});

/** Parsed independent inventory or zoom inspection. */
export const VisualInventory = Schema.Struct({ objects: Schema.Array(VisualDevice) });

/** One semantic decision about an existing SAM proposal. It cannot invent an instance. */
export const ProposalDecision = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["receptacle", "other", "unclear"]),
  labels: DeviceLabels,
  rationale: Schema.String,
});

const Decisions = Schema.Struct({ decisions: Schema.Array(ProposalDecision) });

/** Image evidence supplied to Meta; the ID is local and contains no credential. */
export type ReviewImage = {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
};

/** Application-defined tool catalog. Parameters are standard JSON Schema. */
export type ReviewTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
};

/** A parsed model request for a local evidence operation. Arguments remain boundary input. */
export type ReviewAction = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

/** One reasoning turn, carrying an opaque continuation and requested local actions. */
export type ReviewTurn = {
  readonly continuation: string;
  readonly actions: ReadonlyArray<ReviewAction>;
  readonly message: string;
};

/** A tool result and any new source/overlay images needed for the next reasoning turn. */
export type ReviewToolResult = {
  readonly actionId: string;
  readonly data: Schema.JsonObject;
  readonly images: ReadonlyArray<ReviewImage>;
};

/** A visible transport, schema, budget or artifact failure in a Meta review session. */
export class MetaReviewError extends Schema.TaggedError<MetaReviewError>()("MetaReviewError", {
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}

/** Hosted Spark configuration; the existing URL policy also supports local contract tests. */
export const MetaReviewConfig = Schema.Struct({
  apiKey: SamConfig.fields.apiKey,
  baseUrl: SamConfig.fields.baseUrl,
  model: Schema.Literal("muse-spark-1.3"),
});

const Completion = Schema.fromJsonString(
  Schema.Struct({
    choices: Schema.NonEmptyArray(
      Schema.Struct({
        finish_reason: Schema.Literal("stop"),
        message: Schema.Struct({ content: Schema.String }),
      }),
    ),
  }),
);

const FunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Schema.NonEmptyString,
  arguments: Schema.String,
});

const Response = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("completed"),
    output: Schema.Array(
      Schema.Union([
        FunctionCall,
        Schema.Struct({
          type: Schema.Literal("message"),
          phase: Schema.optional(Schema.String),
          content: Schema.Array(
            Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
          ),
        }),
        Schema.Struct({
          type: Schema.Literal("reasoning"),
          encrypted_content: Schema.NonEmptyString,
        }),
      ]),
    ),
  }),
);

const visionInstructions = `Review actual duplex receptacle symbols in this electrical drawing. The legend uses an outlined circle crossed by two parallel short strokes at a wall. Include partly occluded symbols when their visible strokes support identity. Exclude triangles, furniture pivots, sink drains, circled S in a diamond, text digits and @ characters. Do not infer a desired quantity. Return tight boxes around actual symbols, not labels or nearby blank floor. All coordinates use a NORMALIZED0–1000 grid on this exact image, origin top left, x right, y down.
For room, panel, circuit and protection, record only visible source text and its normalized source box. Use value:null, quote:"", box:null when unsupported or ambiguous. Trace the circuit leader to the symbol; do not assign the nearest number. Protection means visible notation such as G.F.I., not verified GFCI compliance. A room boundary may put devices in an adjacent room. Do not infer code compliance.`;

/** Meta vision and tool reasoning port, scoped to one local experimental run. */
export class MetaReviewClient extends Context.Service<
  MetaReviewClient,
  {
    readonly inventory: (
      image: ReviewImage,
      inspect: boolean,
    ) => Effect.Effect<typeof VisualInventory.Type, MetaReviewError>;
    readonly classify: (
      image: ReviewImage,
      proposals: ReadonlyArray<{ readonly id: string; readonly box: typeof VisionBox.Type }>,
    ) => Effect.Effect<typeof Decisions.Type, MetaReviewError>;
    readonly turn: (input: {
      readonly instructions: string;
      readonly prompt: string;
      readonly tools: ReadonlyArray<ReviewTool>;
      readonly image: ReviewImage;
      readonly continuation: string | undefined;
      readonly results: ReadonlyArray<ReviewToolResult>;
    }) => Effect.Effect<ReviewTurn, MetaReviewError>;
  }
>()("moke/MetaReviewClient") {
  /** Build a no-retry adapter with durable local request/response evidence and a call ceiling. */
  static layer(config: typeof MetaReviewConfig.Type, directory: string, maximumRequests: number) {
    return Layer.effect(
      MetaReviewClient,
      Effect.sync(() => {
        let calls = 0;
        let history: Array<Schema.JsonObject> = [];
        let lastResponse: string | undefined;

        const save = Effect.fn("saveMetaReviewArtifact")(function* (name: string, body: string) {
          yield* Effect.tryPromise({
            try: () => Bun.write(resolve(directory, name), body),
            catch: () => new MetaReviewError({ message: `Cannot save Meta evidence: ${name}.` }),
          });
        });

        const post = Effect.fn("callMetaReview")(function* (
          endpoint: string,
          payload: string,
          metadata: string,
        ) {
          if (calls >= maximumRequests) {
            return yield* new MetaReviewError({ message: "Meta request budget exhausted." });
          }

          const id = String(++calls).padStart(3, "0");
          yield* Effect.tryPromise({
            try: () => mkdir(directory, { recursive: true }),
            catch: () => new MetaReviewError({ message: "Cannot create Meta evidence directory." }),
          });
          yield* save(`${id}-request.json`, metadata);

          const response = yield* Effect.tryPromise({
            try: async (signal) => {
              const result = await fetch(`${config.baseUrl.href.replace(/\/+$/, "")}/${endpoint}`, {
                method: "POST",
                redirect: "error",
                headers: {
                  Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
                  "Content-Type": "application/json",
                },
                body: payload,
                signal,
              });

              return { status: result.status, body: await result.text() };
            },
            catch: () => new MetaReviewError({ message: "Meta review request failed." }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "120 seconds",
              orElse: () =>
                Effect.fail(new MetaReviewError({ message: "Meta review request timed out." })),
            }),
          );

          yield* save(`${id}-response.json`, response.body);

          if (response.status < 200 || response.status >= 300) {
            return yield* new MetaReviewError({
              message: `Meta review returned HTTP ${response.status}.`,
              status: response.status,
            });
          }

          return response.body;
        });

        const describeImage = (image: ReviewImage) => ({
          id: image.id,
          sha256: sha256(image.bytes),
          width: image.width,
          height: image.height,
        });

        const url = (image: ReviewImage) =>
          `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`;

        const observe = Effect.fn("observeMetaDrawing")(function* (
          prompt: string,
          images: ReadonlyArray<ReviewImage>,
          schema: Schema.Constraint,
        ) {
          const parameters = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });

          const body = yield* post(
            "chat/completions",
            JSON.stringify({
              model: config.model,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    ...images.map((image) => ({
                      type: "image_url",
                      image_url: { url: url(image) },
                    })),
                  ],
                },
              ],
              max_completion_tokens: 16000,
              reasoning_effort: "medium",
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "drawing_observation",
                  strict: true,
                  schema: parameters.schema,
                },
              },
            }),
            JSON.stringify({
              model: config.model,
              prompt,
              images: images.map(describeImage),
              schema: parameters,
            }),
          );

          const parsed = yield* Schema.decodeUnknownEffect(Completion)(body).pipe(
            Effect.mapError(
              () => new MetaReviewError({ message: "Invalid Meta vision envelope." }),
            ),
          );

          return parsed.choices[0].message.content;
        });

        return MetaReviewClient.of({
          inventory: (image, inspect) =>
            Effect.gen(function* () {
              const prompt = `${visionInstructions}\n${inspect ? "This is a targeted source zoom, not an inventory hint. For each actual symbol, supply a positive point on its visible outline/body and a negative point on nearby blank floor or a distractor to exclude. Do not place positive points on erased/hidden strokes. Fresh points must not retain stale boxes." : "This is an independent inventory. You have no earlier proposals, counts or overlays. Set guidance:null for every object."}`;
              const text = yield* observe(prompt, [image], VisualInventory);

              return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VisualInventory))(
                text,
              ).pipe(
                Effect.mapError(
                  () => new MetaReviewError({ message: "Invalid visual inventory." }),
                ),
              );
            }),
          classify: (image, proposals) =>
            Effect.gen(function* () {
              const prompt = `${visionInstructions}\nClassify each existing SAM shape proposal exactly once as receptacle, other or unclear. Do not add missing objects or adjust to an expected total. Supplied IDs identify boxes on the original image. Added blue boxes are annotations, not drawing content. Return assertion coordinates on the ORIGINAL image, not a contact sheet. Proposals: ${JSON.stringify(proposals)}`;

              const marked = yield* Effect.try({
                try: () => {
                  const marks = proposals
                    .map((proposal) => {
                      const b = proposal.box;
                      const x = (b.left * image.width) / 1000;
                      const y = (b.top * image.height) / 1000;

                      return `<rect x="${x}" y="${y}" width="${((b.right - b.left) * image.width) / 1000}" height="${((b.bottom - b.top) * image.height) / 1000}" fill="none" stroke="#0072b2" stroke-width="2"/>`;
                    })
                    .join("");

                  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><image href="${url(image)}" width="${image.width}" height="${image.height}"/>${marks}</svg>`;

                  return new Resvg(svg).render().asPng();
                },
                catch: () => new MetaReviewError({ message: "Cannot render candidate evidence." }),
              });

              const text = yield* observe(
                prompt,
                [image, { ...image, id: `${image.id}-proposals`, bytes: marked }],
                Decisions,
              );

              const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Decisions))(
                text,
              ).pipe(
                Effect.mapError(
                  () => new MetaReviewError({ message: "Invalid candidate classification." }),
                ),
              );

              if (
                parsed.decisions.length !== proposals.length ||
                new Set(parsed.decisions.map((d) => d.id)).size !== proposals.length ||
                parsed.decisions.some((d) => !proposals.some((p) => p.id === d.id))
              )
                return yield* new MetaReviewError({
                  message: "Classification must cover each supplied ID exactly once.",
                });

              return parsed;
            }),
          turn: (input) =>
            Effect.gen(function* () {
              if (input.continuation !== lastResponse) {
                return yield* new MetaReviewError({
                  message: "Review continuation does not match this session.",
                });
              }

              const content = input.continuation
                ? input.results.flatMap((result) => [
                    {
                      type: "function_call_output",
                      call_id: result.actionId,
                      output: JSON.stringify(result.data),
                    },
                    ...result.images.map((image) => ({
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: `Evidence image ${image.id}: ${image.width}x${image.height}.`,
                        },
                        { type: "input_image", image_url: url(image) },
                      ],
                    })),
                  ])
                : [
                    {
                      type: "message",
                      role: "user",
                      content: [
                        { type: "input_text", text: input.prompt },
                        { type: "input_image", image_url: url(input.image) },
                      ],
                    },
                  ];

              const tools = input.tools.map((tool) => ({ type: "function", ...tool }));
              const conversation = [...history, ...content];

              const body = yield* post(
                "responses",
                JSON.stringify({
                  model: config.model,
                  instructions: input.instructions,
                  input: conversation,
                  tools,
                  tool_choice: "auto",
                  parallel_tool_calls: false,
                  max_output_tokens: 5000,
                  reasoning: { effort: "high" },
                  stream: false,
                  store: false,
                  include: ["reasoning.encrypted_content"],
                }),
                JSON.stringify({
                  model: config.model,
                  instructions: input.instructions,
                  prompt: input.prompt,
                  continuation: input.continuation ?? null,
                  results: input.results.map((r) => ({
                    ...r,
                    images: r.images.map(describeImage),
                  })),
                  source: describeImage(input.image),
                  tools,
                }),
              );

              const parsed = yield* Schema.decodeUnknownEffect(Response)(body).pipe(
                Effect.mapError(
                  () =>
                    new MetaReviewError({
                      message: "Invalid or incomplete Meta reasoning response.",
                    }),
                ),
              );

              const replay = parsed.output.map((item): Schema.JsonObject => {
                if (item.type === "reasoning") {
                  return {
                    type: item.type,
                    summary: [],
                    encrypted_content: item.encrypted_content,
                  };
                }

                if (item.type === "message") {
                  const message = {
                    type: item.type,
                    role: "assistant",
                    content: item.content,
                  };

                  if (item.phase !== undefined) return { ...message, phase: item.phase };

                  return message;
                }

                return item;
              });

              history = [...conversation, ...replay];
              lastResponse = parsed.id;

              return {
                continuation: parsed.id,
                actions: parsed.output
                  .filter((item) => item.type === "function_call")
                  .map((item) => ({
                    id: item.call_id,
                    name: item.name,
                    arguments: item.arguments,
                  })),
                message: parsed.output
                  .filter((item) => item.type === "message")
                  .flatMap((item) => item.content.map((c) => c.text))
                  .join("\n"),
              };
            }),
        });
      }),
    );
  }
}
