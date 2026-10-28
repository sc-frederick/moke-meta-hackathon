import { Schema } from "effect";
import { Affine, Region } from "#lib/review/contracts.ts";

/** Immutable original bytes and per-page metadata returned after a successful import. */
export class ImportedPdf extends Schema.Class<ImportedPdf>("ImportedPdf")({
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 * 1024 * 1024 })),
  pages: Schema.Array(
    Schema.Struct({
      pageIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 199 })),
      label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
      box: Region,
      rotation: Schema.Literals([0, 90, 180, 270]),
      userUnit: Schema.Finite.check(Schema.isGreaterThan(0)),
    }),
  ),
}) {}

/** Content-addressed PNG render with the exact PDF-to-pixel coordinate maps. */
export class RenderedPdf extends Schema.Class<RenderedPdf>("RenderedPdf")({
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 * 1024 * 1024 })),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  region: Region,
  dpi: Schema.Int.check(Schema.isBetween({ minimum: 24, maximum: 300 })),
  pdfToPixels: Affine,
  pixelsToPdf: Affine,
}) {}
