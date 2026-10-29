import { Schema } from "effect";
import { Affine, Region } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

const RequestId = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** Inspect a parent-selected PDF without accepting paths from the renderer. */
export const WorkerInspectRequest = Schema.TaggedStruct("Inspect", {
  id: RequestId,
  pdfPath: Schema.NonEmptyString,
});

/** Render one bounded PDF region using the imported page metadata. */
export const WorkerRenderRequest = Schema.TaggedStruct("Render", {
  id: RequestId,
  pdfPath: Schema.NonEmptyString,
  pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
  region: Region,
  rotation: Schema.Literals([0, 90, 180, 270]),
  userUnit: Schema.Finite.check(Schema.isGreaterThan(0)),
  dpi: Schema.Finite.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(DocumentsLimits.maxDpi),
  ),
});

/** Requests accepted on the private worker's NDJSON input. */
export const WorkerRequest = Schema.Union([WorkerInspectRequest, WorkerRenderRequest]).pipe(
  Schema.toTaggedUnion("_tag"),
);

const WorkerPageInfo = Schema.Struct({
  pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  box: Region,
  rotation: Schema.Literals([0, 90, 180, 270]),
  userUnit: Schema.Finite.check(Schema.isGreaterThan(0)),
});

/** Page metadata validated before the application records an import. */
export const WorkerInspectResult = Schema.Struct({
  pages: Schema.Array(WorkerPageInfo),
});

/** PNG bytes and inverse coordinate maps for the requested source region. */
export const WorkerRenderResult = Schema.Struct({
  pngBase64: Schema.NonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
});

/** Successful worker output correlated with its request identity. */
export const WorkerSuccess = Schema.Struct({
  id: RequestId,
  ok: Schema.Literal(true),
  result: Schema.Union([WorkerInspectResult, WorkerRenderResult]),
});

/** Worker failures omit private paths and PDF parser diagnostics. */
export const WorkerFailure = Schema.Struct({
  id: RequestId,
  ok: Schema.Literal(false),
  reason: Schema.Literals(["invalid", "encrypted", "limit", "cancelled", "unavailable"]),
  message: Schema.String,
});

/** Response envelope decoded by the parent before inspecting its result. */
export const WorkerResponse = Schema.Union([WorkerSuccess, WorkerFailure]);
