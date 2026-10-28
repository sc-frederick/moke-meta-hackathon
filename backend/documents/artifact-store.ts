import { Effect } from "effect";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, renameSync, writeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DocumentError, ReviewStorageError } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";

const sha256Pattern = /^[a-f0-9]{64}$/;

/** Derive a content-addressed artifact path from a validated hash and media type. */
export function artifactPath(
  dataDirectory: string,
  sha256: string,
  mediaType: "application/pdf" | "image/png",
) {
  const extension = mediaType === "application/pdf" ? "pdf" : "png";

  return join(dataDirectory, "artifacts", `${sha256}.${extension}`);
}

/** Hash file bytes with SHA-256. */
export function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash on-disk bytes with SHA-256. */
export function hashFile(path: string) {
  return hashBytes(readFileSync(path));
}

/** Publish bytes to a content-addressed artifact using stage, fsync, verify, and rename. */
export const storeBytes = Effect.fnUntraced(function* (
  dataDirectory: string,
  bytes: Uint8Array,
  mediaType: "application/pdf" | "image/png",
) {
  const sha256 = hashBytes(bytes);
  const destination = artifactPath(dataDirectory, sha256, mediaType);
  const artifactsRoot = join(dataDirectory, "artifacts");
  const stagingRoot = join(artifactsRoot, ".staging");

  yield* Effect.tryPromise({
    try: () => mkdir(stagingRoot, { recursive: true }),
    catch: () => new ReviewStorageError({ message: "Artifact storage could not be prepared." }),
  });

  if (existsSync(destination) && hashFile(destination) === sha256) {
    return { sha256, byteLength: bytes.byteLength, path: destination } as const;
  }

  const staged = join(stagingRoot, `${sha256}.${crypto.randomUUID()}.part`);

  const handle = yield* Effect.try({
    try: () => openSync(staged, "w"),
    catch: () => new ReviewStorageError({ message: "The artifact could not be staged." }),
  });

  yield* Effect.try({
    try: () => {
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(handle,bytes,offset,bytes.byteLength-offset);
      fsyncSync(handle);
      closeSync(handle);

      if (hashFile(staged) !== sha256) {
        throw new Error("staged hash mismatch");
      }

      renameSync(staged, destination);
    },
    catch: () => new ReviewStorageError({ message: "The artifact could not be stored safely." }),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        try {
          closeSync(handle);
        } catch {
          /* already closed */
        }
      }),
    ),
  );

  return { sha256, byteLength: bytes.byteLength, path: destination } as const;
});

/** Read a bounded base64 chunk from a stored artifact. */
export const readArtifactChunk = Effect.fnUntraced(function* (
  dataDirectory: string,
  sha256: string,
  mediaType: "application/pdf" | "image/png",
  offset: number,
  limit: number,
) {
  if (!sha256Pattern.test(sha256)) {
    return yield* new DocumentError({ reason: "invalid", message: "The artifact hash is not valid." });
  }

  if (limit < 1 || limit > DocumentsLimits.maxReadChunkBytes) {
    return yield* new DocumentError({ reason: "limit", message: "The read chunk exceeds the allowed size." });
  }

  if (offset < 0) {
    return yield* new DocumentError({ reason: "invalid", message: "The read offset is negative." });
  }

  const path = artifactPath(dataDirectory, sha256, mediaType);

  const bytes = yield* Effect.try({
    try: () => {
      const size = statSync(path).size;
      if (size > DocumentsLimits.maxSourceBytes) throw new Error("Artifact exceeds limit");
      const content = readFileSync(path);
      if (hashBytes(content) !== sha256) throw new Error("Artifact hash mismatch");
      return content;
    },
    catch: () => new DocumentError({ reason: "unavailable",message: "The requested evidence artifact is missing or its hash does not match." }),
  });
  const totalBytes = bytes.byteLength;
  if (offset > totalBytes || !Number.isInteger(offset) || !Number.isInteger(limit)) return yield* new DocumentError({ reason: "invalid",message: "The artifact read range is invalid." });
  return { base64: bytes.subarray(offset,Math.min(totalBytes,offset+limit)).toString("base64"),totalBytes };

});

/** Remove a staged part file after a failed store attempt. */
export const discardStagingFile = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: () => undefined,
  }).pipe(Effect.ignore);

/** Copy an on-disk source file into content-addressed storage. */
export const storeFile = Effect.fnUntraced(function* (
  dataDirectory: string,
  sourcePath: string,
  mediaType: "application/pdf" | "image/png",
) {
  const bytes = yield* Effect.try({
    try: () => readFileSync(sourcePath),
    catch: () => new DocumentError({ reason: "unavailable", message: "The source file could not be read." }),
  });

  return yield* storeBytes(dataDirectory, bytes, mediaType);
});
