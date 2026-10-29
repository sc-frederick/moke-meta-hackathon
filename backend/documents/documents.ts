import { Context, Effect, Layer, Semaphore } from "effect";
import { DocumentError, Region, ReviewStorageError, Sheet } from "#lib/review/contracts.ts";
import { artifactPath, readArtifactChunk, storeBytes, storeFile } from "./artifact-store.ts";
import type { DocumentsConfig } from "./config.ts";
import { validatePdfSource } from "./pdf-validation.ts";
import { validateRenderRequest } from "./render-bounds.ts";
import { ImportedPdf, RenderedPdf } from "./types.ts";
import {
  openPdfWorker,
  type PdfWorkerSession,
  workerInspect,
  workerRender,
} from "./worker-client.ts";

/** PDF import, bounded rendering, and artifact chunk reads for review evidence. */
export class Documents extends Context.Service<
  Documents,
  {
    readonly importPdf: (
      source: string,
    ) => Effect.Effect<ImportedPdf, DocumentError | ReviewStorageError>;
    /** Reinspect verified immutable bytes without adding a revision or replacing its inventory. */
    readonly inspectStored: (
      sha256: string,
    ) => Effect.Effect<ImportedPdf, DocumentError | ReviewStorageError>;
    readonly render: (
      originalSha256: string,
      sheet: Sheet,
      region: Region,
      dpi: number,
    ) => Effect.Effect<RenderedPdf, DocumentError | ReviewStorageError>;
    readonly read: (
      sha256: string,
      mediaType: "application/pdf" | "image/png",
      offset: number,
      limit: number,
    ) => Effect.Effect<{ base64: string; totalBytes: number }, DocumentError | ReviewStorageError>;
  }
>()("documents/Documents") {
  /** Acquire a scoped worker, serialize PDF jobs, and keep SQL out of this layer. */
  static layer(config: DocumentsConfig) {
    return Layer.effect(
      Documents,
      Effect.gen(function* () {
        const pdfJobs = yield* Semaphore.make(1);

        const withPdfJob = <A, E>(operation: (worker: PdfWorkerSession) => Effect.Effect<A, E>) =>
          Effect.scoped(
            openPdfWorker(config).pipe(Effect.flatMap(operation), Effect.timeout("20 seconds")),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof DocumentError || cause instanceof ReviewStorageError
                ? cause
                : new DocumentError({
                    reason: "limit",
                    message: "PDF work exceeded its processing limit.",
                  }),
            ),
            Semaphore.withPermit(pdfJobs),
            Effect.interruptible,
          );

        return Documents.of({
          importPdf: (source) =>
            withPdfJob((worker) =>
              Effect.gen(function* () {
                yield* validatePdfSource(source);
                const stored = yield* storeFile(config.dataDirectory, source, "application/pdf");

                const pdfPath = artifactPath(
                  config.dataDirectory,
                  stored.sha256,
                  "application/pdf",
                );

                const inspected = yield* workerInspect(worker, pdfPath);

                return new ImportedPdf({
                  sha256: stored.sha256,
                  byteLength: stored.byteLength,
                  pages: inspected.pages,
                });
              }),
            ),

          inspectStored: (sha256) =>
            withPdfJob((worker) =>
              Effect.gen(function* () {
                const verified = yield* readArtifactChunk(
                  config.dataDirectory,
                  sha256,
                  "application/pdf",
                  0,
                  1,
                );

                const pdfPath = artifactPath(config.dataDirectory, sha256, "application/pdf");
                yield* validatePdfSource(pdfPath);
                const inspected = yield* workerInspect(worker, pdfPath);

                return new ImportedPdf({
                  sha256,
                  byteLength: verified.totalBytes,
                  pages: inspected.pages,
                });
              }),
            ),

          render: (originalSha256, sheet, region, dpi) =>
            withPdfJob((worker) =>
              Effect.gen(function* () {
                if (!/^[a-f0-9]{64}$/.test(originalSha256)) {
                  return yield* new DocumentError({
                    reason: "invalid",
                    message: "The original hash is not valid.",
                  });
                }

                const pdfPath = artifactPath(
                  config.dataDirectory,
                  originalSha256,
                  "application/pdf",
                );

                yield* Effect.try({
                  try: () => Bun.file(pdfPath).size,
                  catch: () =>
                    new DocumentError({
                      reason: "unavailable",
                      message: "The original PDF is missing.",
                    }),
                });

                if (sheet.pageIndex < 0 || sheet.pageIndex > 199) {
                  return yield* new DocumentError({
                    reason: "invalid",
                    message: "The sheet page index is invalid.",
                  });
                }

                const fitted = yield* validateRenderRequest(sheet, region, dpi);

                const rendered = yield* workerRender(worker, {
                  pdfPath,
                  pageIndex: sheet.pageIndex,
                  region,
                  rotation: sheet.rotation,
                  userUnit: sheet.userUnit,
                  dpi: fitted.dpi,
                });

                const pngBytes = Buffer.from(rendered.pngBase64, "base64");
                const stored = yield* storeBytes(config.dataDirectory, pngBytes, "image/png");

                return new RenderedPdf({
                  sha256: stored.sha256,
                  byteLength: stored.byteLength,
                  width: rendered.width,
                  height: rendered.height,
                  region,
                  dpi: fitted.dpi,
                  pdfToPixels: rendered.pdfToPixels,
                  pixelsToPdf: rendered.pixelsToPdf,
                });
              }),
            ),

          read: (sha256, mediaType, offset, limit) =>
            readArtifactChunk(config.dataDirectory, sha256, mediaType, offset, limit),
        });
      }),
    );
  }
}
