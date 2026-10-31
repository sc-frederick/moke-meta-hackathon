/** Runtime paths and commands for PDF import, rendering, and artifact storage. */
export interface DocumentsConfig {
  /** Application data root; artifacts live under `{dataDirectory}/artifacts`. */
  readonly dataDirectory: string;
  /** Compiled or scripted PDF worker entry invoked under an Effect scope. */
  readonly workerCommand: readonly [string, ...string[]];
  /** Packaged pdfjs-dist tree (`legacy/build`, `cmaps`, `standard_fonts`). */
  readonly assetsDirectory: string;
  /** Platform `@napi-rs/canvas` native library passed through `NAPI_RS_NATIVE_LIBRARY_PATH`. */
  readonly nativeLibraryPath: string;
}

/** Upper bounds enforced before PDF work is admitted. */
export const DocumentsLimits = {
  maxSourceBytes: 100 * 1024 * 1024,
  maxPages: 200,
  maxDpi: 300,
  minDpi: 24,
  maxOutputPixels: 16_000_000,
  maxReadChunkBytes: 256 * 1024,
  /** Verified artifact bytes held so chunked reads hash each file once. */
  verifiedReadBytes: 64 * 1024 * 1024,
} as const;
