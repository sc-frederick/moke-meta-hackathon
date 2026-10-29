import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { PackageManifest, type PackageFile } from "#lib/review/packages.ts";

/** Cloud uploads are deliberately smaller than offline package exports. */
export const cloudPackageLimits = { maxFiles: 5000, maxBytes: 1024 * 1024 * 1024 } as const;

/** Resume only bytes that already match the selected immutable result manifest. */
export const downloadedCloudFileMatches = (path: string, expected: PackageFile) =>
  Effect.promise(async () => {
    try {
      const info = await lstat(path);

      if (!info.isFile() || info.size !== expected.bytes) return false;
      const hash = createHash("sha256");
      let bytes = 0;

      for await (const chunk of Bun.file(path).stream()) {
        bytes += chunk.byteLength;

        if (bytes > expected.bytes) return false;
        hash.update(chunk);
      }

      return bytes === expected.bytes && hash.digest("hex") === expected.sha256;
    } catch {
      return false;
    }
  });

/** Modal 0.11 leaves its atomic-copy scratch file when the desktop process exits mid-copy. */
export const clearInterruptedCloudDownloads = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      for (const relative of ["", "artifacts", "journals"]) {
        const folder = join(directory, relative);

        try {
          if (!(await lstat(folder)).isDirectory()) continue;
        } catch (cause) {
          if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)) continue;
          throw cause;
        }

        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (entry.isFile() && /^\.modal-sandbox-fs-tmp-[a-f0-9]{16}$/.test(entry.name))
            await rm(join(folder, entry.name));
        }
      }
    },
    catch: () =>
      new CloudReviewError({
        reason: "unavailable",
        message: "Interrupted download files could not be cleared. Retry sync to continue.",
      }),
  });

/** Decode and authorize every transfer path before touching the local or remote filesystem. */
export const parseCloudManifest = Effect.fn("parseCloudManifest")(function* (text: string) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    return yield* new CloudReviewError({
      reason: "limit",
      message: "The cloud package manifest is too large.",
    });

  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(
    text,
  ).pipe(
    Effect.mapError(
      () =>
        new CloudReviewError({
          reason: "incompatible",
          message: "The cloud package manifest is incompatible.",
        }),
    ),
  );

  if (
    manifest.scope !== "application" ||
    manifest.scopeLabel !== "whole-application" ||
    manifest.database.path !== "app.sqlite"
  )
    return yield* new CloudReviewError({
      reason: "incompatible",
      message: "A complete workspace package is required.",
    });
  const files: Array<PackageFile> = [manifest.database];

  for (const artifact of manifest.artifacts) {
    if (
      artifact.path !== `artifacts/${artifact.sha256}.pdf` &&
      artifact.path !== `artifacts/${artifact.sha256}.png`
    )
      return yield* new CloudReviewError({
        reason: "incompatible",
        message: "A cloud artifact path is outside the package.",
      });
    files.push(artifact);
  }

  for (const journal of manifest.journals) {
    if (journal.path !== `journals/${journal.journalId}.sqlite`)
      return yield* new CloudReviewError({
        reason: "incompatible",
        message: "A cloud journal path is outside the package.",
      });
    files.push(journal);
  }

  const total = files.reduce((bytes, file) => bytes + file.bytes, Buffer.byteLength(text));

  if (
    files.length + 1 > cloudPackageLimits.maxFiles ||
    total > cloudPackageLimits.maxBytes ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    return yield* new CloudReviewError({
      reason: "limit",
      message: `This workspace is ${(total / 1024 / 1024).toFixed(1)} MiB across ${files.length + 1} files. Cloud transfers support up to 1,024 MiB and 5,000 unique files. Export a complete backup and use a separate workspace for a smaller review. The transfer was refused; your local workspace is unchanged.`,
    });

  return { manifest, files };
});
