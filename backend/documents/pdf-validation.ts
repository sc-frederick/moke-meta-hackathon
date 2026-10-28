import { Effect } from "effect";
import { readFileSync, statSync } from "node:fs";
import { DocumentError } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

const pdfHeader = "%PDF-";

/** Reject oversize, missing, or obviously non-PDF sources before worker inspection. */
export const validatePdfSource = Effect.fnUntraced(function* (sourcePath: string) {
  const stats = yield* Effect.try({
    try: () => statSync(sourcePath),
    catch: () =>
      new DocumentError({
        reason: "unavailable",
        message: "The source file could not be accessed.",
      }),
  });

  if (!stats.isFile()) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The import source is not a regular file.",
    });
  }

  if (stats.size < pdfHeader.length) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The source is too small to be a PDF.",
    });
  }

  if (stats.size > DocumentsLimits.maxSourceBytes) {
    return yield* new DocumentError({
      reason: "limit",
      message: "The PDF exceeds the maximum allowed size.",
    });
  }

  const prefix = yield* Effect.try({
    try: () => readFileSync(sourcePath).subarray(0, 5),
    catch: () =>
      new DocumentError({ reason: "unavailable", message: "The source file could not be read." }),
  });

  const header = new TextDecoder().decode(prefix);

  if (!header.startsWith(pdfHeader)) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The source does not begin with a PDF header.",
    });
  }

  return stats.size;
});
