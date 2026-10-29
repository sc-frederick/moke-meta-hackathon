import { Effect } from "effect";
import { containsRegion } from "#lib/review/geometry.ts";
import { DocumentError, Region, Sheet } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

/** Fit valid source regions into the pixel budget without changing their PDF coordinates. */
export const validateRenderRequest = Effect.fnUntraced(function* (
  sheet: Sheet,
  region: Region,
  dpi: number,
) {
  if (dpi < DocumentsLimits.minDpi || dpi > DocumentsLimits.maxDpi) {
    return yield* new DocumentError({
      reason: "limit",
      message: "The render DPI is outside the allowed range.",
    });
  }

  if (!containsRegion(sheet.box, region)) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The requested region falls outside the sheet page box.",
    });
  }

  // Leave rounding headroom; the worker independently enforces the hard pixel ceiling.
  const maxScale = Math.sqrt(
    (DocumentsLimits.maxOutputPixels - 16000) / (region.width * region.height),
  );

  const scale = Math.min((dpi / 72) * sheet.userUnit, maxScale);
  const width = Math.ceil(region.width * scale);
  const height = Math.ceil(region.height * scale);

  if (width <= 0 || height <= 0) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The requested region has no renderable area.",
    });
  }

  if (width * height > DocumentsLimits.maxOutputPixels) {
    return yield* new DocumentError({
      reason: "limit",
      message: "The requested render would exceed the maximum output pixel count.",
    });
  }

  return { width, height, scale, dpi: (scale * 72) / sheet.userUnit } as const;
});
