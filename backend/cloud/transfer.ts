import { Effect, Schema } from "effect";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { PackageManifest, type PackageFile } from "#lib/review/packages.ts";

/** Cloud uploads are deliberately smaller than offline package exports. */
export const cloudPackageLimits = { maxFiles: 5000, maxBytes: 256 * 1024 * 1024 } as const;

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
      message: "Cloud packages must have unique paths, at most 5,000 files, and at most 256 MiB.",
    });

  return { manifest, files };
});
