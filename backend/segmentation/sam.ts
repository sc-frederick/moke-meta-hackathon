import { buildObjectPrompt, decodeMaskToSVGPath, formats, recordsOfKind } from "@meta-sam/parser";
import { Context, Effect, Layer, Match, Redacted, Schema } from "effect";
import type { DrawingCrop } from "./fixtures.ts";

const Pixel = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Box = Schema.Struct({ left: Pixel, top: Pixel, right: Pixel, bottom: Pixel });

const Point = Schema.Struct({
  x: Pixel,
  y: Pixel,
  label: Schema.Literals(["positive", "negative"]),
});

const LocationPrompt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("box"), box: Box }),
  Schema.Struct({ kind: Schema.Literal("points"), points: Schema.NonEmptyArray(Point) }),
  Schema.Struct({ kind: Schema.Literal("guided"), box: Box, points: Schema.NonEmptyArray(Point) }),
]);

function locationSelection(prompt: typeof LocationPrompt.Type) {
  return Match.value(prompt).pipe(
    Match.when({ kind: "box" }, (value) => ({ box: value.box })),
    Match.when({ kind: "points" }, (value) => ({ points: value.points })),
    Match.when({ kind: "guided" }, (value) => ({ box: value.box, points: value.points })),
    Match.exhaustive,
  );
}

/** One reproducible text or location prompt, always on the crop's actual pixels. */
export const SegmentationCase = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
  crop: Schema.NonEmptyString,
  prompt: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("concept"), text: Schema.NonEmptyString }),
    LocationPrompt,
    Schema.Struct({
      kind: Schema.Literal("objects"),
      objects: Schema.NonEmptyArray(Schema.Struct({ id: Pixel, prompt: LocationPrompt })).check(
        Schema.isMaxLength(16),
      ),
    }),
  ]),
  purpose: Schema.NonEmptyString,
});

/** Parsed experiment case. */
export type SegmentationCase = typeof SegmentationCase.Type;

/** A safe failure at the SAM request or geometry boundary. */
export class SegmentationError extends Schema.TaggedError<SegmentationError>()(
  "SegmentationError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Int),
  },
) {}

/** Configuration is parsed once by the CLI; loopback HTTP supports local contract tests. */
export const SamConfig = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.NonEmptyString.check(Schema.isTrimmed())),
  baseUrl: Schema.URLFromString.check(
    Schema.makeFilter(
      (url) =>
        (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "",
    ),
  ),
  model: Schema.Literal("sam-3.1"),
});

const ResponseBody = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("completed"),
    output: Schema.NonEmptyArray(
      Schema.Struct({
        type: Schema.Literal("message"),
        content: Schema.NonEmptyArray(
          Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
        ),
      }),
    ),
  }),
);

/** The transport result retains the exact body for local evidence and replay. */
type SamResponse = { readonly body: string; readonly status: number };

/** Hosted inference port; the renderer and Electron never receive its credentials. */
export class SamClient extends Context.Service<
  SamClient,
  {
    readonly segment: (
      prompt: string,
      image: Uint8Array,
    ) => Effect.Effect<SamResponse, SegmentationError>;
  }
>()("moke/SamClient") {
  /** Build the fetch adapter without automatic retries of paid requests. */
  static layer(config: typeof SamConfig.Type) {
    return Layer.succeed(
      SamClient,
      SamClient.of({
        segment: (prompt, image) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${config.baseUrl.href.replace(/\/+$/, "")}/responses`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: config.model,
                  input: [
                    {
                      type: "message",
                      role: "user",
                      content: [
                        { type: "input_text", text: prompt },
                        {
                          type: "input_image",
                          image_url: `data:image/png;base64,${Buffer.from(image).toString("base64")}`,
                        },
                      ],
                    },
                  ],
                  stream: false,
                  metadata: { include_confidence: "true", mask_encoding: "one_bit" },
                }),
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
              });

              return { body: await response.text(), status: response.status };
            },
            catch: () =>
              new SegmentationError({
                message: "SAM request failed or exceeded 120 seconds. No automatic retry was sent.",
              }),
          }),
      }),
    );
  }
}

/** Build a location prompt with Meta's half-open box conversion and input checks. */
export const casePrompt = Effect.fn("casePrompt")(function* (
  test: SegmentationCase,
  crop: DrawingCrop,
) {
  if (test.prompt.kind === "concept") return test.prompt.text;

  const prompt = test.prompt;

  const objects =
    prompt.kind === "objects"
      ? prompt.objects.map((object) => ({
          id: object.id,
          prompts: [locationSelection(object.prompt)],
        }))
      : [{ id: 1, prompts: [locationSelection(prompt)] }];

  return yield* Effect.try({
    try: () =>
      buildObjectPrompt({
        size: { width: crop.width_px, height: crop.height_px },
        objects,
      }),
    catch: () => new SegmentationError({ message: `Invalid location prompt: ${test.id}.` }),
  });
});

/** Parse complete image responses and map half-open pixel boxes back to PDF points. */
export const readSegmentation = Effect.fn("readSegmentation")(function* (
  response: SamResponse,
  crop: DrawingCrop,
) {
  if (response.status < 200 || response.status >= 300) {
    return yield* new SegmentationError({
      message: `SAM returned HTTP ${response.status}.`,
      status: response.status,
    });
  }

  const parsed = yield* Schema.decodeUnknownEffect(ResponseBody)(response.body).pipe(
    Effect.mapError(
      () => new SegmentationError({ message: "SAM did not return a completed image response." }),
    ),
  );

  const text = parsed.output.flatMap((item) => item.content.map((part) => part.text)).join("");

  const result = yield* Effect.try({
    try: () => {
      const parser = formats.segmentation.image().createParser();
      parser.push(text);

      return parser.finish({ status: "completed" }).result;
    },
    catch: () => new SegmentationError({ message: "SAM output could not be parsed." }),
  });

  if (
    result.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    result.records.some((record) => record.kind === "text")
  ) {
    return yield* new SegmentationError({
      message: "SAM output contains invalid segmentation records; inspect response.json.",
    });
  }

  // The parser normalizes box coordinates but does not expose wire w/h. Check them
  // before applying the crop transform so silently resized model input cannot drift.
  for (const [token] of text.matchAll(/<\|box;[^|]*\|>/g)) {
    const dimensions = new Map(
      Array.from(
        token.matchAll(/;(w|h)=(\d+)(?=;|\|>)/g),
        (match) => [match[1], Number(match[2])] as const,
      ),
    );

    if (dimensions.get("w") !== crop.width_px || dimensions.get("h") !== crop.height_px) {
      return yield* new SegmentationError({
        message: "SAM source dimensions differ from the submitted crop.",
      });
    }
  }

  const boxes = recordsOfKind(result.records, "box");
  const masks = recordsOfKind(result.records, "mask");

  if (boxes.length !== masks.length || (text.trim() !== "" && boxes.length === 0)) {
    return yield* new SegmentationError({
      message: "SAM output has unpaired or missing boxes and masks.",
    });
  }

  const objects = [];

  for (const box of boxes) {
    const mask = masks.find(
      (record) =>
        record.objectId === box.objectId && record.frame?.frameIndex === box.frame?.frameIndex,
    );

    if (
      !mask ||
      box.left < 0 ||
      box.top < 0 ||
      box.right > crop.width_px ||
      box.bottom > crop.height_px
    ) {
      return yield* new SegmentationError({
        message: "SAM geometry is outside the submitted image or has no matching mask.",
      });
    }

    const path = yield* Effect.try({
      try: () => decodeMaskToSVGPath(mask.mask),
      catch: () => new SegmentationError({ message: "SAM returned an undecodable mask." }),
    });

    const [x, y] = crop.pixel_to_pdf.offset_points;
    const scale = crop.pixel_to_pdf.scale;

    objects.push({
      id: box.objectId,
      confidence: box.confidence ?? null,
      pixels: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      pdfPoints: {
        left: x + box.left * scale,
        top: y + box.top * scale,
        right: x + box.right * scale,
        bottom: y + box.bottom * scale,
      },
      mask: { width: mask.mask.width, height: mask.mask.height, path },
    });
  }

  return { responseId: parsed.id, rawOutput: text, diagnostics: result.diagnostics, objects };
});

/** Validated geometry used by experiment artifacts and the evidence report. */
export type Segmentation = Effect.Success<ReturnType<typeof readSegmentation>>;
