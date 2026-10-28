import { Effect, Result, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DrawingInputError, readCrops, renderCrop } from "./fixtures.ts";
import { reportHtml, overlaySvg, type CaseResult } from "./report.ts";
import { casePrompt, readSegmentation, SamClient, SegmentationCase } from "./sam.ts";

/** An artifact write failure that stops the experiment before more paid requests. */
export class ExperimentOutputError extends Schema.TaggedError<ExperimentOutputError>()(
  "ExperimentOutputError",
  {
    message: Schema.String,
  },
) {}

const save = Effect.fn("saveExperimentArtifact")(function* (path: string, contents: string) {
  yield* Effect.tryPromise({
    try: () => Bun.write(path, contents),
    catch: () =>
      new ExperimentOutputError({ message: `Cannot save experiment artifact: ${path}.` }),
  });
});

/** Local experiment options. A run directory must be new to preserve prior evidence. */
export type ExperimentOptions = {
  readonly fixtures: string;
  readonly casesFile: string;
  readonly manifestFile?: string;
  readonly output: string;
  readonly caseIds: ReadonlyArray<string>;
  readonly live: boolean;
};

/** Prepare original-PDF crops, then execute selected SAM requests sequentially. */
export const runExperiment = Effect.fn("runExperiment")(function* (options: ExperimentOptions) {
  const crops = yield* readCrops(options.fixtures, options.manifestFile);

  const casesText = yield* Effect.tryPromise({
    try: () => Bun.file(options.casesFile).text(),
    catch: () => new DrawingInputError({ message: "Cannot read the experiment cases file." }),
  });

  const allCases = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.NonEmptyArray(SegmentationCase)),
  )(casesText).pipe(
    Effect.mapError(() => new DrawingInputError({ message: "Invalid experiment cases file." })),
  );

  if (
    new Set(allCases.map((test) => test.id)).size !== allCases.length ||
    options.caseIds.some((id) => !allCases.some((test) => test.id === id))
  ) {
    return yield* new DrawingInputError({ message: "Duplicate or unknown experiment case ID." });
  }

  const cases =
    options.caseIds.length === 0
      ? allCases
      : allCases.filter((test) => options.caseIds.includes(test.id));

  const prepared = [];

  // Check every selected case before creating output or sending the first request.
  for (const test of cases) {
    const crop = crops.find((item) => item.id === test.crop);

    if (!crop) return yield* new DrawingInputError({ message: `Unknown crop in case ${test.id}.` });

    prepared.push({ test, crop, prompt: yield* casePrompt(test, crop) });
  }

  yield* Effect.tryPromise({
    try: () => mkdir(options.output, { recursive: false }),
    catch: () =>
      new ExperimentOutputError({
        message:
          "Cannot create run directory. Its parent must exist and the run directory must be new.",
      }),
  });
  yield* Effect.tryPromise({
    try: () => mkdir(resolve(options.output, "inputs")),
    catch: () =>
      new ExperimentOutputError({ message: "Cannot create experiment inputs directory." }),
  });

  const inputs = new Map<string, Effect.Success<ReturnType<typeof renderCrop>>>();

  for (const { crop } of prepared) {
    if (inputs.has(crop.id)) continue;

    const input = yield* renderCrop(
      options.fixtures,
      crop,
      resolve(options.output, "inputs", `${crop.id}.png`),
    );

    inputs.set(crop.id, input);
  }

  const results: Array<CaseResult> = [];
  const client = yield* SamClient;

  for (const { test, crop, prompt } of prepared) {
    const input = inputs.get(crop.id);

    if (!input)
      return yield* new DrawingInputError({ message: `Missing rendered input: ${crop.id}.` });

    const directory = resolve(options.output, test.id);
    yield* Effect.tryPromise({
      try: () => mkdir(directory),
      catch: () =>
        new ExperimentOutputError({ message: `Cannot create case directory: ${test.id}.` }),
    });

    const metadata = {
      test,
      crop,
      prompt,
      inputSha256: input.sha256,
      pdfSha256: input.pdfSha256,
      review: "pending" as const,
    };

    yield* save(
      resolve(directory, "request.json"),
      JSON.stringify(
        {
          ...metadata,
          model: "sam-3.1",
          stream: false,
          metadata: { include_confidence: "true", mask_encoding: "one_bit" },
          image: `../inputs/${crop.id}.png`,
        },
        null,
        2,
      ),
    );
    const start = performance.now();

    const outcome = options.live
      ? yield* Effect.gen(function* () {
          const response = yield* client.segment(prompt, input.bytes);
          yield* save(resolve(directory, "response.json"), response.body);
          const segmentation = yield* readSegmentation(response, crop);
          yield* save(
            resolve(directory, "overlay.svg"),
            overlaySvg(segmentation, crop, input.bytes),
          );

          return segmentation;
        }).pipe(Effect.result)
      : null;

    let result: CaseResult;

    if (outcome === null) {
      result = { ...metadata, elapsedMs: 0, status: "prepared" };
    } else if (Result.isSuccess(outcome)) {
      result = {
        ...metadata,
        elapsedMs: performance.now() - start,
        status: "succeeded",
        segmentation: outcome.success,
      };
    } else {
      // Losing the evidence writer must stop the run; do not send further paid work.
      if (outcome.failure instanceof ExperimentOutputError) return yield* outcome.failure;

      result = {
        ...metadata,
        elapsedMs: performance.now() - start,
        status: "failed",
        message: outcome.failure.message,
      };
    }

    results.push(result);
    yield* save(resolve(directory, "result.json"), JSON.stringify(result, null, 2));
    yield* save(
      resolve(options.output, "summary.json"),
      JSON.stringify(
        {
          model: "sam-3.1",
          live: options.live,
          cost: null,
          review: "pending",
          plannedCases: cases.map((test) => test.id),
          results,
        },
        null,
        2,
      ),
    );
    yield* save(
      resolve(options.output, "report.html"),
      reportHtml(results, "sam-3.1", cases.length),
    );
    yield* Effect.logInfo(
      `${test.id}: ${result.status}${result.status === "succeeded" ? `, ${result.segmentation.objects.length} proposed objects` : ""}`,
    );

    // Access and quota failures affect the whole run. Save the failed case and stop.
    if (
      outcome !== null &&
      Result.isFailure(outcome) &&
      !(outcome.failure instanceof ExperimentOutputError) &&
      outcome.failure.status !== undefined &&
      [401, 402, 403, 404, 429].includes(outcome.failure.status)
    )
      break;
  }

  return results;
});
