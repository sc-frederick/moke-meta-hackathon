import { Schema } from "effect";
import { Affine, ArtifactId, CommandId, FindingId, ProjectId } from "./contracts.ts";
import { RunId } from "./execution.ts";

const Pixel = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2048 }));
const Box = Schema.Struct({ left: Pixel, top: Pixel, right: Pixel, bottom: Pixel });

const Point = Schema.Struct({
  x: Pixel,
  y: Pixel,
  label: Schema.Literals(["positive", "negative"]),
});

const Points = Schema.NonEmptyArray(Point).check(Schema.isMaxLength(32));

/** Model-selected guidance on the exact delivered image. Boxes use half-open edges. */
export const SamInspectionRequest = Schema.Struct({
  artifactId: ArtifactId,
  prompt: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("concept"),
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed()),
    }),
    Schema.Struct({ kind: Schema.Literal("box"), box: Box }),
    Schema.Struct({ kind: Schema.Literal("points"), points: Points }),
    Schema.Struct({ kind: Schema.Literal("guided"), box: Box, points: Points }),
  ]),
});

/** Parsed model guidance; no filesystem path or remote image URL is accepted. */
export type SamInspectionRequest = typeof SamInspectionRequest.Type;

const Coordinates = Schema.Struct({
  left: Schema.Finite,
  top: Schema.Finite,
  right: Schema.Finite,
  bottom: Schema.Finite,
});

const PdfPoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Confidence = Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

/** A SAM instance is a geometry proposal, never an accepted fact or a coverage assertion. */
export const SamInstance = Schema.Struct({
  id: Schema.String,
  confidence: Confidence,
  sourcePixelsInclusive: Coordinates,
  pixels: Coordinates,
  pdfCorners: Schema.Tuple([PdfPoint, PdfPoint, PdfPoint, PdfPoint]),
  pdfBounds: Coordinates,
  mask: Schema.Struct({
    encoding: Schema.Literals(["one_bit", "lossless"]),
    payload: Schema.String,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    bounds: Coordinates,
    confidence: Confidence,
    path: Schema.String,
  }),
});

/** Public receipt excludes private request bytes, provider body, headers, and credentials. */
export class SamObservation extends Schema.Class<SamObservation>("SamObservation")({
  operationId: CommandId,
  runId: RunId,
  projectId: ProjectId,
  findingId: FindingId,
  sourceArtifactId: ArtifactId,
  sourceVersion: Schema.Int,
  factVersion: Schema.Int,
  sourceSha256: Hash,
  submittedSha256: Hash,
  width: Schema.Int,
  height: Schema.Int,
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
  responseId: Schema.NonEmptyString,
  route: Schema.Literal("https://api.meta.ai/v1/responses"),
  model: Schema.Literal("sam-3.1"),
  parserVersion: Schema.Literal("@meta-sam/parser@0.1.0"),
  prompt: SamInspectionRequest.fields.prompt,
  promptSha256: Hash,
  fingerprint: Hash,
  recordedAs: Schema.Literals(["proposal", "historical"]),
  instances: Schema.Array(SamInstance),
  costUsd: Schema.Null,
  imageInputTokens: Schema.Null,
  inputTokens: Schema.Null,
  outputTokens: Schema.Null,
}) {}
