import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { ExecutionError } from "#lib/review/execution.ts";
import { SamInspectionRequest } from "#lib/review/segmentation.ts";
import { ExecutionImage } from "../review/execution-port.ts";
import { parseInstances, promptFor, ResponseBody } from "../inference/segmentation.ts";

const route = "https://api.meta.ai/v1/responses";
const model = "sam-3.1";
const parserVersion = "@meta-sam/parser@0.1.0";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const imageInput = (input: ExecutionImage) =>
  Schema.decodeUnknownEffect(ExecutionImage)(input).pipe(
    Effect.mapError(
      () => new ExecutionError({ reason: "input", message: "The SAM source image is invalid." }),
    ),
  );

/** Prepare exact SAM request bytes and replay identity; dispatch and durable admission belong to the caller. */
export const preparePacketSamRequest = Effect.fn("PacketReview.prepareSam")(function* (
  input: ExecutionImage,
  guidance: SamInspectionRequest,
) {
  const image = yield* imageInput(input);

  const request = yield* Schema.decodeUnknownEffect(SamInspectionRequest, {
    onExcessProperty: "error",
  })(guidance).pipe(
    Effect.mapError(
      () => new ExecutionError({ reason: "input", message: "The SAM guidance is invalid." }),
    ),
  );

  if (request.artifactId !== image.artifactId)
    return yield* new ExecutionError({
      reason: "input",
      message: "SAM guidance belongs to a different source artifact.",
    });
  const prompt = yield* promptFor(request, image);
  const submittedSha256 = hash(Buffer.from(image.data, "base64"));
  const promptSha256 = hash(prompt);

  const body = JSON.stringify({
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
        ],
      },
    ],
    stream: false,
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
  });

  const fingerprint = hash(
    JSON.stringify({
      artifactId: image.artifactId,
      projectId: image.projectId,
      sheetId: image.sheetId,
      width: image.width,
      height: image.height,
      pdfToPixels: image.pdfToPixels,
      pixelsToPdf: image.pixelsToPdf,
      submittedSha256,
      body,
    }),
  );

  return { body, fingerprint, submittedSha256, promptSha256, route, model };
});

/** Decode a completed SAM receipt into geometry proposals; masks are retained in the caller's raw receipt, not repeated in model context. */
export const decodePacketSamResponse = Effect.fn("PacketReview.decodeSam")(function* (
  raw: string,
  input: ExecutionImage,
) {
  const image = yield* imageInput(input);

  if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
    return yield* new ExecutionError({
      reason: "uncertain",
      message: "The SAM response exceeded its receipt size bound.",
    });

  const response = yield* Schema.decodeUnknownEffect(ResponseBody)(raw).pipe(
    Effect.mapError(
      () =>
        new ExecutionError({
          reason: "uncertain",
          message: "SAM did not return a complete image response.",
        }),
    ),
  );

  const parsed = yield* parseInstances(response.output[0].content[0].text, image);

  const instances = parsed.map(({ mask, ...instance }) => ({
    ...instance,
    mask: {
      encoding: mask.encoding,
      width: mask.width,
      height: mask.height,
      bounds: mask.bounds,
      confidence: mask.confidence,
    },
  }));

  return { responseId: response.id, parserVersion, instances };
});
