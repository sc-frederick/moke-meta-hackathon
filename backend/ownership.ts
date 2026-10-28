import { Context, Effect, Layer, Schema } from "effect";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** Startup cannot proceed while another process owns the canonical data directory. */
export class OwnershipError extends Schema.TaggedError<OwnershipError>()("OwnershipError", {
  reason: Schema.Literals(["occupied", "unavailable", "released"]),
  message: Schema.String,
}) {}

/** A dedicated, non-restored SQLite connection holds the process-lifetime writer lock. */
export class DataDirectoryOwnership extends Context.Service<
  DataDirectoryOwnership,
  {
    readonly canonicalDirectory: string;
    readonly generation: string;
    readonly assertHeld: Effect.Effect<void, OwnershipError>;
    /** Keep the lock until process exit when an uncooperative operation outlives shutdown. */
    readonly retainUntilExit: () => void;
  }
>()("app/DataDirectoryOwnership") {
  /** Acquire before migrations, domain connections, recovery, or journal open. */
  static layer(directory: string) {
    return Layer.effect(DataDirectoryOwnership, acquireDataDirectoryOwnership(directory));
  }
}

/** Scoped ownership acquisition; SQL locking handles stale owners and process death. */
export const acquireDataDirectoryOwnership = Effect.fn("acquireDataDirectoryOwnership")(function* (
  directory: string,
) {
  const canonicalDirectory = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true });

      return realpath(directory);
    },
    catch: () =>
      new OwnershipError({
        reason: "unavailable",
        message: "The data directory could not be opened.",
      }),
  });

  let retained = false;
  let held = true;

  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const db = new DatabaseSync(join(canonicalDirectory, ".execution-owner.sqlite"));

        try {
          db.exec(
            "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner_lock (id INTEGER PRIMARY KEY CHECK(id=1)); BEGIN IMMEDIATE;",
          );

          return db;
        } catch (cause) {
          db.close();
          throw cause;
        }
      },
      catch: () =>
        new OwnershipError({
          reason: "occupied",
          message: "This data directory is already owned or cannot be locked.",
        }),
    }),
    (db) =>
      Effect.sync(() => {
        if (!retained) {
          held = false;
          db.close();
        }
      }),
  );

  return DataDirectoryOwnership.of({
    canonicalDirectory,
    generation: randomUUID(),
    assertHeld: Effect.suspend(() =>
      held && database.isOpen
        ? Effect.void
        : Effect.fail(
            new OwnershipError({
              reason: "released",
              message: "Data directory ownership was released.",
            }),
          ),
    ),
    retainUntilExit: () => {
      if (retained) return;
      retained = true;
      // The exit listener retains the native handle even after its Layer is disposed.
      process.once("exit", () => {
        if (database.isOpen) database.close();
      });
    },
  });
});
