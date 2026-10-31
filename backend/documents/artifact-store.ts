import { Effect, Metric } from "effect";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  renameSync,
  type Stats,
  writeSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
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

function hashFile(path: string) {
  return Bun.SHA256.hash(readFileSync(path), "hex");
}

/** Publish bytes to a content-addressed artifact using stage, fsync, verify, and rename. */
export const storeBytes = Effect.fnUntraced(function* (
  dataDirectory: string,
  bytes: Uint8Array,
  mediaType: "application/pdf" | "image/png",
) {
  const sha256 = Bun.SHA256.hash(bytes, "hex");
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

      while (offset < bytes.byteLength)
        offset += writeSync(handle, bytes, offset, bytes.byteLength - offset);
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

/** Stored artifact bytes read and hashed to verify them against their content hash. */
export const artifactBytesVerified = Metric.counter("moke_artifact_bytes_verified", {
  description: "Stored artifact bytes read and hashed to verify their content hash.",
  incremental: true,
});

const missingOrChanged = () =>
  new DocumentError({
    reason: "unavailable",
    message: "The requested evidence artifact is missing or its hash does not match.",
  });

// Replacement by rename changes the inode; an in-place write changes size, mtime or ctime.
const fileIdentity = (stats: Stats) =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;

/** Read a whole stored artifact once and verify its content hash, within a size bound. */
export const readVerifiedArtifact = Effect.fnUntraced(function* (
  dataDirectory: string,
  sha256: string,
  mediaType: "application/pdf" | "image/png",
  maxBytes: number = DocumentsLimits.maxSourceBytes,
) {
  if (!sha256Pattern.test(sha256)) {
    return yield* new DocumentError({
      reason: "invalid",
      message: "The artifact hash is not valid.",
    });
  }

  const read = yield* Effect.try({
    try: () => {
      const handle = openSync(artifactPath(dataDirectory, sha256, mediaType), "r");

      try {
        const stats = fstatSync(handle);

        if (stats.size > maxBytes) return undefined;

        return { identity: fileIdentity(stats), bytes: readFileSync(handle) };
      } finally {
        closeSync(handle);
      }
    },
    catch: missingOrChanged,
  });

  if (read === undefined)
    return yield* new DocumentError({
      reason: "limit",
      message: "The stored artifact exceeds the allowed read size.",
    });
  yield* Metric.update(artifactBytesVerified, read.bytes.byteLength);

  if (Bun.SHA256.hash(read.bytes, "hex") !== sha256) return yield* missingOrChanged();

  return read;
});

/**
 * Serve bounded chunks from verified bytes while the file keeps the identity it was verified at,
 * so reading an artifact in chunks hashes it once. Files larger than the budget are verified on
 * every chunk. The least recently read files leave first.
 */
export function verifiedArtifactReader(dataDirectory: string, budgetBytes: number) {
  const verified = new Map<string, { readonly identity: string; readonly bytes: Buffer }>();
  let heldBytes = 0;

  const forget = (path: string) => {
    const entry = verified.get(path);

    if (entry === undefined) return;
    verified.delete(path);
    heldBytes -= entry.bytes.byteLength;
  };

  const currentIdentity = (path: string) => {
    try {
      return fileIdentity(statSync(path));
    } catch {
      return undefined;
    }
  };

  const chunk = Effect.fnUntraced(function* (
    sha256: string,
    mediaType: "application/pdf" | "image/png",
    offset: number,
    limit: number,
  ) {
    if (!sha256Pattern.test(sha256)) {
      return yield* new DocumentError({
        reason: "invalid",
        message: "The artifact hash is not valid.",
      });
    }

    if (limit < 1 || limit > DocumentsLimits.maxReadChunkBytes) {
      return yield* new DocumentError({
        reason: "limit",
        message: "The read chunk exceeds the allowed size.",
      });
    }

    if (offset < 0) {
      return yield* new DocumentError({
        reason: "invalid",
        message: "The read offset is negative.",
      });
    }

    const path = artifactPath(dataDirectory, sha256, mediaType);
    const cached = verified.get(path);
    let bytes: Buffer;

    if (cached !== undefined && cached.identity === currentIdentity(path)) {
      verified.delete(path);
      verified.set(path, cached);
      bytes = cached.bytes;
    } else {
      forget(path);
      const read = yield* readVerifiedArtifact(dataDirectory, sha256, mediaType);
      bytes = read.bytes;

      if (bytes.byteLength <= budgetBytes) {
        verified.set(path, read);
        heldBytes += bytes.byteLength;

        for (const oldest of verified.keys()) {
          if (heldBytes <= budgetBytes) break;
          forget(oldest);
        }
      }
    }

    const totalBytes = bytes.byteLength;

    if (offset > totalBytes || !Number.isInteger(offset) || !Number.isInteger(limit))
      return yield* new DocumentError({
        reason: "invalid",
        message: "The artifact read range is invalid.",
      });

    return {
      base64: bytes.subarray(offset, Math.min(totalBytes, offset + limit)).toString("base64"),
      totalBytes,
    };
  });

  return {
    chunk,
    /** Drop verified bytes for a content address whose file was just written or replaced. */
    forget: (sha256: string, mediaType: "application/pdf" | "image/png") =>
      forget(artifactPath(dataDirectory, sha256, mediaType)),
  };
}

/** Copy an on-disk source file into content-addressed storage. */
export const storeFile = Effect.fnUntraced(function* (
  dataDirectory: string,
  sourcePath: string,
  mediaType: "application/pdf" | "image/png",
) {
  const bytes = yield* Effect.try({
    try: () => readFileSync(sourcePath),
    catch: () =>
      new DocumentError({ reason: "unavailable", message: "The source file could not be read." }),
  });

  return yield* storeBytes(dataDirectory, bytes, mediaType);
});
