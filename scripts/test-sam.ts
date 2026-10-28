import { Effect, Layer, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runExperiment } from "../backend/segmentation/experiment.ts";
import { SamClient, SamConfig, SegmentationError } from "../backend/segmentation/sam.ts";

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      parseArgs({
        args: Bun.argv.slice(2),
        options: {
          live: { type: "boolean", default: false },
          help: { type: "boolean", default: false },
          fixtures: { type: "string", default: "Moke-Hackathon-Drawings" },
          cases: { type: "string", default: "experiments/sam/cases.json" },
          manifest: { type: "string" },
          output: { type: "string", default: ".local/sam" },
          case: { type: "string", multiple: true, default: [] },
        },
      }),
    catch: () =>
      new SegmentationError({ message: "Invalid arguments. Run bun run test:sam --help." }),
  });

  if (args.values.help) {
    console.log(
      "bun run test:sam [--live] [--case ID ...] [--fixtures DIR] [--cases JSON] [--manifest JSON] [--output DIR]\nDefault: render crops and prepare requests, without inference. --live sends one paid request per selected case. Results use a new subdirectory under --output. Requires Poppler's pdftoppm.",
    );

    return;
  }

  const client = args.values.live
    ? SamClient.layer(
        yield* Schema.decodeUnknownEffect(SamConfig)({
          apiKey: Bun.env.MODEL_API_KEY,
          baseUrl: Bun.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
          model: Bun.env.META_SEGMENTATION_MODEL ?? "sam-3.1",
        }).pipe(
          Effect.mapError(
            () =>
              new SegmentationError({
                message:
                  "Check MODEL_API_KEY, META_API_BASE_URL, and META_SEGMENTATION_MODEL in .env. SAM 3.1 is required. URLs must use HTTPS or loopback HTTP, without credentials, query, or fragment.",
              }),
          ),
        ),
      )
    : Layer.succeed(
        SamClient,
        SamClient.of({
          segment: () =>
            Effect.fail(new SegmentationError({ message: "Live inference is disabled." })),
        }),
      );

  const parent = resolve(args.values.output);
  yield* Effect.tryPromise({
    try: () => mkdir(parent, { recursive: true }),
    catch: () => new SegmentationError({ message: "Cannot create the output directory." }),
  });

  const directory = resolve(
    parent,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
  );

  console.log(
    args.values.live
      ? "Live SAM 3.1 experiment. One request per case; no automatic retries."
      : "Preparing crops and requests. No model calls.",
  );

  const results = yield* runExperiment({
    fixtures: resolve(args.values.fixtures),
    casesFile: resolve(args.values.cases),
    output: directory,
    caseIds: args.values.case,
    live: args.values.live,
    manifestFile: args.values.manifest
      ? resolve(args.values.manifest)
      : resolve(args.values.fixtures, "drawing-manifest.json"),
  }).pipe(Effect.provide(client));

  console.log(`Saved report: ${directory}/report.html`);
  process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
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
  console.error("SAM experiment stopped unexpectedly.");
  process.exitCode = 1;
});
