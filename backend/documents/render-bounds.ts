import { Effect } from "effect";
import { containsRegion } from "#lib/review/geometry.ts";
import { DocumentError, Region, Sheet } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

/** Reject crops that exceed pixel budgets or fall outside the sheet page box. */
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

  const scale = (dpi / 72) * sheet.userUnit;
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

  return { width, height, scale } as const;
});
