import { Effect, Schema } from "effect";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { CloudReviewRecord } from "./contracts.ts";

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

  if (Buffer.byteLength(text) > 8 * 1024 * 1024)
    return yield* new CloudReviewError({
      reason: "limit",
      message: "Cloud ownership records exceed the supported limit.",
    });

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

  return [...state.jobs];
});

/** Persist all receipts so retries of older cloud command identities never dispatch again. */
export const writeCloudState = (path: string, jobs: ReadonlyArray<CloudReviewRecord>) =>
  writeCloudFile(path, JSON.stringify({ version: 1, jobs }));
