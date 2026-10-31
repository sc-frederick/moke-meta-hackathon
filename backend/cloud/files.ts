import { Effect, Schema, Struct } from "effect";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CloudReviewError,
  cloudReviewLocksWorkspace,
  type CloudReviewRequest,
} from "#lib/review/cloud.ts";
import { CloudReviewRecord } from "./contracts.ts";
import { cloudWorkerProgressMaxBytes } from "./progress.ts";

/** Package writers require an existing, private parent directory outside application data. */
export const createCloudDirectory = (path: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true, mode: 0o700 }),
    catch: () =>
      new CloudReviewError({
        reason: "storage",
        message: "Cloud package staging could not be opened.",
      }),
  });

/** Atomic cloud metadata writes are flushed before callers may dispatch external work. */
export const writeCloudFile = (path: string, text: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;

      try {
        const file = await open(temporary, "wx", 0o600);

        try {
          await file.writeFile(text);
          await file.sync();
        } finally {
          await file.close();
        }

        await rename(temporary, path);

        if (process.platform !== "win32") {
          const directory = await open(dirname(path), "r");

          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
    catch: () =>
      new CloudReviewError({
        reason: "storage",
        message: "Cloud review state could not be saved. Local work remains fenced.",
      }),
  });

const CloudState = Schema.Struct({
  version: Schema.Literal(1),
  jobs: Schema.Array(CloudReviewRecord).check(Schema.isMaxLength(1000)),
});

/** Reads and writes share one budget, so every saved state reopens. */
export const cloudStateMaxBytes = 8 * 1024 * 1024;

/** Earlier builds saved full terminal receipts and could exceed the budget; those files are compacted. */
const cloudStateRecoveryMaxBytes = 64 * 1024 * 1024;

/** Room an admitted receipt keeps for its worker progress and messages while it owns the workspace. */
export const cloudReceiptReserveBytes = 2 * cloudWorkerProgressMaxBytes;

const digestPrefix = "sha256:";

const digest = (text: string) =>
  `${digestPrefix}${createHash("sha256").update(text).digest("hex")}`;

/** Retried commands compare this digest; receipts no longer repeat the request as a string. */
export const cloudRequestFingerprint = (request: typeof CloudReviewRequest.Type) =>
  digest(JSON.stringify(request));

/**
 * Receipts written before digests stored the request JSON itself, which never starts with the
 * prefix. Terminal receipts keep their identity, status and digest but drop the finding preview
 * and selected sheet list, which nothing reads after the workspace returns.
 */
export const compactCloudReceipt = (record: CloudReviewRecord): CloudReviewRecord => {
  const fingerprint = record.fingerprint.startsWith(digestPrefix)
    ? record.fingerprint
    : digest(record.fingerprint);

  const normalized = { ...record, fingerprint };

  if (cloudReviewLocksWorkspace(record.phase)) return normalized;

  const preview =
    normalized.packet === undefined
      ? normalized
      : { ...normalized, packet: Struct.omit(normalized.packet, ["findingPreview"]) };

  return "kind" in record.request && record.request.selection !== undefined
    ? {
        ...preview,
        request: { ...record.request, selection: { ...record.request.selection, sheetIds: [] } },
      }
    : preview;
};

/** Encoded size of the state file holding these receipts. */
export const cloudStateBytes = (jobs: ReadonlyArray<CloudReviewRecord>) =>
  Buffer.byteLength(JSON.stringify({ version: 1, jobs }));

/** Missing intent means local ownership; unreadable or malformed intent fails closed. */
export const readCloudState = Effect.fn("readCloudState")(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)
        ? new CloudReviewError({ reason: "unavailable", message: "missing" })
        : new CloudReviewError({
            reason: "storage",
            message:
              "Cloud ownership could not be read. Restore access before editing this workspace.",
          }),
  }).pipe(
    Effect.catch((error) =>
      error.reason === "unavailable" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

  if (text === null) return [];
  const bytes = Buffer.byteLength(text);

  const oversized = new CloudReviewError({
    reason: "limit",
    message: "Cloud ownership records exceed the supported limit.",
  });

  if (bytes > cloudStateRecoveryMaxBytes) return yield* oversized;

  const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudState))(text).pipe(
    Effect.mapError(
      () =>
        new CloudReviewError({
          reason: "storage",
          message:
            "Cloud ownership records are invalid. Local editing is blocked until they are recovered.",
        }),
    ),
  );

  const jobs = state.jobs.map(compactCloudReceipt);

  // Compaction keeps every receipt, its command digest and any active owner unchanged.
  if (bytes > cloudStateMaxBytes)
    yield* writeCloudState(path, jobs).pipe(Effect.mapError(() => oversized));

  return jobs;
});

/** Persist all receipts so retries of older cloud command identities never dispatch again. */
export const writeCloudState = (path: string, jobs: ReadonlyArray<CloudReviewRecord>) =>
  Effect.suspend(() => {
    const text = JSON.stringify({ version: 1, jobs });

    // Refuse before replacing the last state that the reader accepts.
    return Buffer.byteLength(text) > cloudStateMaxBytes
      ? Effect.fail(
          new CloudReviewError({
            reason: "limit",
            message:
              "Cloud review records are too large to save. The previous ownership record is unchanged.",
          }),
        )
      : writeCloudFile(path, text);
  });
