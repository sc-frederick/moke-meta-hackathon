import { Schema } from "effect";
import { Affine, Region } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

const RequestId = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const WorkerInspectRequest = Schema.TaggedStruct("Inspect", {
  id: RequestId,
  pdfPath: Schema.NonEmptyString,
});

export const WorkerRenderRequest = Schema.TaggedStruct("Render", {
  id: RequestId,
  pdfPath: Schema.NonEmptyString,
  pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
  region: Region,
  rotation: Schema.Literals([0, 90, 180, 270]),
  userUnit: Schema.Finite.check(Schema.isGreaterThan(0)),
  dpi: Schema.Int.check(
    Schema.isBetween({ minimum: DocumentsLimits.minDpi, maximum: DocumentsLimits.maxDpi }),
  ),
});

export const WorkerRequest = Schema.Union([WorkerInspectRequest, WorkerRenderRequest]).pipe(
  Schema.toTaggedUnion("_tag"),
);

export const WorkerPageInfo = Schema.Struct({
  pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  box: Region,
  rotation: Schema.Literals([0, 90, 180, 270]),
  userUnit: Schema.Finite.check(Schema.isGreaterThan(0)),
});

export const WorkerInspectResult = Schema.Struct({
  pages: Schema.Array(WorkerPageInfo),
});

export const WorkerRenderResult = Schema.Struct({
  pngBase64: Schema.NonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
});

export const WorkerSuccess = Schema.Struct({
  id: RequestId,
  ok: Schema.Literal(true),
  result: Schema.Union([WorkerInspectResult, WorkerRenderResult]),
});

export const WorkerFailure = Schema.Struct({
  id: RequestId,
  ok: Schema.Literal(false),
  reason: Schema.Literals(["invalid", "encrypted", "limit", "cancelled", "unavailable"]),
  message: Schema.String,
});

export const WorkerResponse = Schema.Union([WorkerSuccess, WorkerFailure]);
