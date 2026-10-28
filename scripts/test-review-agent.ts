import { Effect, Layer, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AdaptiveCase,
  AdaptiveReviewError,
  runAdaptiveReview,
} from "../backend/segmentation/adaptive-review.ts";
import { readCrops } from "../backend/segmentation/fixtures.ts";
import {
  MetaReviewClient,
  MetaReviewConfig,
  MetaReviewError,
} from "../backend/segmentation/meta-review.ts";
import { SamClient, SamConfig, SegmentationError } from "../backend/segmentation/sam.ts";

const Budgets = Schema.Struct({
  turns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  meta: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  sam: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
});

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      parseArgs({
        args: Bun.argv.slice(2),
        options: {
          live: { type: "boolean", default: false },
          help: { type: "boolean", default: false },
          fixtures: { type: "string", default: "Moke-Hackathon-Drawings" },
          manifest: { type: "string", default: "experiments/sam/symbols/crops.json" },
          cases: { type: "string", default: "experiments/sam/adaptive-cases.json" },
          case: { type: "string", default: "exam-development" },
          output: { type: "string", default: ".local/sam/adaptive" },
          "max-turns": { type: "string", default: "12" },
          "max-meta": { type: "string", default: "18" },
          "max-sam": { type: "string", default: "6" },
        },
      }),
    catch: () =>
      new AdaptiveReviewError({
        message: "Invalid arguments. Run bun run test:review-agent --help.",
      }),
  });

  if (args.values.help) {
    console.log(
      "bun run test:review-agent [--live] [--case ID] [--cases JSON] [--manifest JSON] [--fixtures DIR] [--output DIR] [--max-turns N] [--max-meta N] [--max-sam N]\nDefault: render and save a prepared report with no provider calls. --live runs a bounded Muse Spark1.3 Responses tool loop with independent vision and SAM3.1. Each request is saved; no automatic retries.",
    );

    return;
  }

  const limits = yield* Schema.decodeUnknownEffect(Budgets)({
    turns: Number(args.values["max-turns"]),
    meta: Number(args.values["max-meta"]),
    sam: Number(args.values["max-sam"]),
  }).pipe(Effect.mapError(() => new AdaptiveReviewError({ message: "Invalid request budgets." })));

  const text = yield* Effect.tryPromise({
    try: () => Bun.file(args.values.cases).text(),
    catch: () => new AdaptiveReviewError({ message: "Cannot read adaptive cases." }),
  });

  const cases = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.NonEmptyArray(AdaptiveCase)),
  )(text).pipe(
    Effect.mapError(() => new AdaptiveReviewError({ message: "Invalid adaptive case file." })),
  );

  const matching = cases.filter((c) => c.id === args.values.case);
  const [scenario] = matching;

  if (!scenario || matching.length !== 1)
    return yield* new AdaptiveReviewError({ message: "Choose one unique adaptive case ID." });
  const fixtures = resolve(args.values.fixtures);
  const crops = yield* readCrops(fixtures, resolve(args.values.manifest));
  const crop = crops.find((c) => c.id === scenario.crop);

  if (!crop)
    return yield* new AdaptiveReviewError({ message: "Adaptive case references an unknown crop." });
  const parent = resolve(args.values.output);
  yield* Effect.tryPromise({
    try: () => mkdir(parent, { recursive: true }),
    catch: () => new AdaptiveReviewError({ message: "Cannot create adaptive output parent." }),
  });

  const output = resolve(
    parent,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
  );

  const disabled = Effect.fail(new MetaReviewError({ message: "Live inference is disabled." }));

  let modelLayer = Layer.succeed(
    MetaReviewClient,
    MetaReviewClient.of({
      inventory: () => disabled,
      classify: () => disabled,
      turn: () => disabled,
    }),
  );

  let samLayer = Layer.succeed(
    SamClient,
    SamClient.of({
      segment: () => Effect.fail(new SegmentationError({ message: "Live inference is disabled." })),
    }),
  );

  if (args.values.live) {
    const common = {
      apiKey: Bun.env.MODEL_API_KEY,
      baseUrl: Bun.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
    };

    const meta = yield* Schema.decodeUnknownEffect(MetaReviewConfig)({
      ...common,
      model: Bun.env.META_TEXT_MODEL ?? "muse-spark-1.3",
    }).pipe(
      Effect.mapError(
        () =>
          new AdaptiveReviewError({
            message: "Check Meta key, base URL and muse-spark-1.3 configuration.",
          }),
      ),
    );

    const sam = yield* Schema.decodeUnknownEffect(SamConfig)({
      ...common,
      model: Bun.env.META_SEGMENTATION_MODEL ?? "sam-3.1",
    }).pipe(
      Effect.mapError(
        () => new AdaptiveReviewError({ message: "Check Meta SAM3.1 configuration." }),
      ),
    );

    modelLayer = MetaReviewClient.layer(meta, resolve(output, "model"), limits.meta);
    samLayer = SamClient.layer(sam);
  }

  console.log(
    args.values.live
      ? `Live Meta evidence review: at most ${limits.meta} Muse requests, ${limits.sam} SAM requests, ${limits.turns} reasoning turns.`
      : "Preparing original PDF evidence. No provider calls.",
  );

  const result = yield* runAdaptiveReview({
    fixtures,
    crop,
    scenario,
    output,
    live: args.values.live,
    maximumTurns: limits.turns,
    maximumSamCalls: limits.sam,
  }).pipe(Effect.provide(Layer.merge(modelLayer, samLayer)));

  console.log(`Saved report: ${output}/report.html`);
  console.log(`Status: ${result.status}. ${result.summary}`);
  process.exitCode = ["prepared", "finished"].includes(result.status) ? 0 : 1;
});

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
).catch(() => {
  console.error("Adaptive review stopped unexpectedly.");
  process.exitCode = 1;
});
