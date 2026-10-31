import { Cache, Context, Effect, Equal, Hash, Layer, Semaphore } from "effect";
import { availableParallelism } from "node:os";
import { DocumentError, Region, ReviewStorageError, Sheet } from "#lib/review/contracts.ts";
import {
  artifactPath,
  verifiedArtifactReader,
  readVerifiedArtifact,
  storeBytes,
  storeFile,
} from "./artifact-store.ts";
import { type DocumentsConfig, DocumentsLimits } from "./config.ts";
import { validatePdfSource } from "./pdf-validation.ts";
import { validateRenderRequest } from "./render-bounds.ts";
import { renderIdentity } from "./render-identity.ts";
import { ImportedPdf, RenderedPdf } from "./types.ts";
import {
  openPdfWorker,
  type PdfWorkerSession,
  workerInspect,
  workerRender,
  workerText,
} from "./worker-client.ts";
import type { WorkerTextResult } from "./worker-messages.ts";

/**
 * Each PDF job runs in its own worker process, so jobs can overlap. Parallel sheet reviewers
 * request renders at the same time; one core stays free for the backend and SQL.
 */
export const pdfJobConcurrency = Math.max(1, Math.min(4, availableParallelism() - 1));

/** Concurrent requests for the same render identity join one worker render. */
class RenderJob implements Equal.Equal {
  constructor(
    readonly identity: string,
    readonly originalSha256: string,
    readonly sheet: Sheet,
    readonly region: Region,
    readonly dpi: number,
  ) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof RenderJob && that.identity === this.identity;
  }

  [Hash.symbol](): number {
    return Hash.string(this.identity);
  }
}

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
    /** Read and verify a whole stored artifact once, for backend processing within a size bound. */
    readonly readVerified: (
      sha256: string,
      mediaType: "application/pdf" | "image/png",
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, DocumentError | ReviewStorageError>;
    /** Store a retrieved PDF by content hash and extract its embedded text from a one-based page. */
    readonly extractText: (
      bytes: Uint8Array,
      firstPage: number,
      maxCharacters: number,
    ) => Effect.Effect<
      typeof WorkerTextResult.Type & { readonly sha256: string },
      DocumentError | ReviewStorageError
    >;
  }
>()("documents/Documents") {
  /** Acquire a scoped worker per job, bound concurrent PDF jobs, and keep SQL out of this layer. */
  static layer(config: DocumentsConfig) {
    return Layer.effect(
      Documents,
      Effect.gen(function* () {
        const pdfJobs = yield* Semaphore.make(pdfJobConcurrency);

        const reads = verifiedArtifactReader(
          config.dataDirectory,
          DocumentsLimits.verifiedReadBytes,
        );

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

        const renderJob = (job: RenderJob) =>
          withPdfJob((worker) =>
            Effect.gen(function* () {
              if (!/^[a-f0-9]{64}$/.test(job.originalSha256)) {
                return yield* new DocumentError({
                  reason: "invalid",
                  message: "The original hash is not valid.",
                });
              }

              const pdfPath = artifactPath(
                config.dataDirectory,
                job.originalSha256,
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

              if (job.sheet.pageIndex < 0 || job.sheet.pageIndex > 199) {
                return yield* new DocumentError({
                  reason: "invalid",
                  message: "The sheet page index is invalid.",
                });
              }

              const fitted = yield* validateRenderRequest(job.sheet, job.region, job.dpi);

              // The worker verifies the original's hash on the exact bytes it renders.
              const rendered = yield* workerRender(worker, {
                pdfPath,
                sha256: job.originalSha256,
                pageIndex: job.sheet.pageIndex,
                region: job.region,
                rotation: job.sheet.rotation,
                userUnit: job.sheet.userUnit,
                dpi: fitted.dpi,
              });

              const pngBytes = Buffer.from(rendered.pngBase64, "base64");
              const stored = yield* storeBytes(config.dataDirectory, pngBytes, "image/png");
              reads.forget(stored.sha256, "image/png");

              return new RenderedPdf({
                sha256: stored.sha256,
                byteLength: stored.byteLength,
                width: rendered.width,
                height: rendered.height,
                region: job.region,
                dpi: fitted.dpi,
                pdfToPixels: rendered.pdfToPixels,
                pixelsToPdf: rendered.pixelsToPdf,
              });
            }),
          );

        // Entries live only while a render is in flight; finished renders are reused from SQL.
        const renders = yield* Cache.make({ lookup: renderJob, capacity: 256, timeToLive: 0 });

        return Documents.of({
          importPdf: (source) =>
            withPdfJob((worker) =>
              Effect.gen(function* () {
                yield* validatePdfSource(source);
                const stored = yield* storeFile(config.dataDirectory, source, "application/pdf");
                reads.forget(stored.sha256, "application/pdf");

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
                const verified = yield* readVerifiedArtifact(
                  config.dataDirectory,
                  sha256,
                  "application/pdf",
                );

                const pdfPath = artifactPath(config.dataDirectory, sha256, "application/pdf");
                yield* validatePdfSource(pdfPath);
                const inspected = yield* workerInspect(worker, pdfPath);

                return new ImportedPdf({
                  sha256,
                  byteLength: verified.bytes.byteLength,
                  pages: inspected.pages,
                });
              }),
            ),

          render: (originalSha256, sheet, region, dpi) =>
            validateRenderRequest(sheet, region, dpi).pipe(
              Effect.flatMap((fitted) =>
                Cache.get(
                  renders,
                  new RenderJob(
                    renderIdentity(originalSha256, sheet, region, fitted.dpi),
                    originalSha256,
                    sheet,
                    region,
                    dpi,
                  ),
                ),
              ),
            ),

          read: reads.chunk,

          readVerified: (sha256, mediaType, maxBytes) =>
            readVerifiedArtifact(config.dataDirectory, sha256, mediaType, maxBytes).pipe(
              Effect.map((verified) => verified.bytes),
            ),

          extractText: (bytes, firstPage, maxCharacters) =>
            withPdfJob((worker) =>
              Effect.gen(function* () {
                if (bytes.byteLength > DocumentsLimits.maxSourceBytes)
                  return yield* new DocumentError({
                    reason: "limit",
                    message: "The PDF exceeds the maximum allowed size.",
                  });

                // Check the header before storing, so a mislabeled response leaves no artifact.
                if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
                  return yield* new DocumentError({
                    reason: "invalid",
                    message: "The source is not a PDF.",
                  });

                const stored = yield* storeBytes(config.dataDirectory, bytes, "application/pdf");
                reads.forget(stored.sha256, "application/pdf");

                const pdfPath = artifactPath(
                  config.dataDirectory,
                  stored.sha256,
                  "application/pdf",
                );

                const extracted = yield* workerText(worker, { pdfPath, firstPage, maxCharacters });

                return { ...extracted, sha256: stored.sha256 };
              }),
            ),
        });
      }),
    );
  }
}
