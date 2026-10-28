import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { ExecutionImage } from "../../backend/review/execution-port.ts";
import {
  decodePacketSamResponse,
  preparePacketSamRequest,
} from "../../backend/packet-review/sam.ts";
import { SamInspectionRequest } from "#lib/review/segmentation.ts";

const image = Schema.decodeUnknownSync(ExecutionImage)({
  artifactId: randomUUID(),
  projectId: randomUUID(),
  sheetId: randomUUID(),
  mimeType: "image/png",
  data: "aW1hZ2U=",
  width: 320,
  height: 334,
  pdfToPixels: [0, -1 / 3, 1 / 2, 0, 20, 1100 / 3],
  pixelsToPdf: [0, 2, -3, 0, 1100, -40],
});

const request = (prompt: SamInspectionRequest["prompt"]) =>
  Schema.decodeUnknownSync(SamInspectionRequest)({ artifactId: image.artifactId, prompt });

const mask = "<|mask;x=0;y=0;c=0.8;data=1,1,!!!!!&O.lVP|>";

const response = (text: string, status = "completed") =>
  JSON.stringify({
    id: "packet-sam-response",
    status,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });

test("prepares exact concept-guided SAM bytes and stable replay identity without dispatch", async () => {
  const prepared = await Effect.runPromise(
    preparePacketSamRequest(image, request({ kind: "concept", text: "service sink" })),
  );

  expect(JSON.parse(prepared.body)).toEqual({
    model: "sam-3.1",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "service sink" },
          { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
        ],
      },
    ],
    stream: false,
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
  });
  expect(prepared.route).toBe("https://api.meta.ai/v1/responses");
  expect(prepared.fingerprint).toMatch(/^[0-9a-f]{64}$/);

  const repeated = await Effect.runPromise(
    preparePacketSamRequest(image, request({ kind: "concept", text: "service sink" })),
  );

  expect(repeated).toEqual(prepared);

  const changed = await Effect.runPromise(
    preparePacketSamRequest(image, request({ kind: "concept", text: "mop sink" })),
  );

  expect(changed.fingerprint).not.toBe(prepared.fingerprint);
});

test("uses official builder for guided boxes and rejects geometry outside the actual image", async () => {
  const prepared = await Effect.runPromise(
    preparePacketSamRequest(
      image,
      request({ kind: "box", box: { left: 10, top: 20, right: 30, bottom: 40 } }),
    ),
  );

  expect(prepared.body).toContain("<|box;");

  const invalid = await Effect.runPromise(
    Effect.result(
      preparePacketSamRequest(
        image,
        request({ kind: "points", points: [{ x: 500, y: 200, label: "positive" }] }),
      ),
    ),
  );

  expect(Result.isFailure(invalid)).toBe(true);

  if (Result.isFailure(invalid)) expect(invalid.failure.reason).toBe("input");
});

test("rejects a request targeting another artifact", async () => {
  const wrong = Schema.decodeUnknownSync(SamInspectionRequest)({
    artifactId: randomUUID(),
    prompt: { kind: "concept", text: "sink" },
  });

  const result = await Effect.runPromise(Effect.result(preparePacketSamRequest(image, wrong)));
  expect(Result.isFailure(result)).toBe(true);
});

test("keeps native rotated geometry and inclusive edge pixels while omitting huge mask payloads", async () => {
  const result = await Effect.runPromise(
    decodePacketSamResponse(
      response(`<0f>1<|box;x1=319;y1=333;x2=319;y2=333;w=320;h=334;c=0.9|>${mask}`),
      image,
    ),
  );

  expect(result.responseId).toBe("packet-sam-response");
  expect(result.parserVersion).toBe("@meta-sam/parser@0.1.0");
  expect(result.instances).toHaveLength(1);
  expect(result.instances[0]).toMatchObject({
    sourcePixelsInclusive: { left: 319, top: 333, right: 319, bottom: 333 },
    pixels: { left: 319, top: 333, right: 320, bottom: 334 },
    pdfCorners: [
      { x: 101, y: 598 },
      { x: 101, y: 600 },
      { x: 98, y: 600 },
      { x: 98, y: 598 },
    ],
    pdfBounds: { left: 98, top: 598, right: 101, bottom: 600 },
    mask: { encoding: "one_bit", width: 1, height: 1, confidence: 0.8 },
  });
  expect(result.instances[0]?.mask).not.toHaveProperty("payload");
  expect(result.instances[0]?.mask).not.toHaveProperty("path");
});

test("zero matches remain zero proposals rather than an accepted count", async () => {
  const result = await Effect.runPromise(decodePacketSamResponse(response(""), image));
  expect(result.instances).toEqual([]);
  expect(result).not.toHaveProperty("accepted");
});

test.each([response("", "incomplete"), response("malformed geometry"), "invalid JSON"])(
  "unusable SAM receipts stay uncertain",
  async (raw) => {
    const result = await Effect.runPromise(Effect.result(decodePacketSamResponse(raw, image)));
    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) expect(result.failure.reason).toBe("uncertain");
  },
);
