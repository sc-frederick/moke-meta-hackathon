import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../../backend/database-files.ts";
import { Documents } from "../../backend/documents/documents.ts";
import { acquireDataDirectoryOwnership } from "../../backend/ownership.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import {
  CommandId,
  type ProjectId,
  Region,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";

/** A fresh command ID for fixture commands. */
export const commandId = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

const nativeFile = join(
  dirname(fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`))),
  canvasNativeFileName(),
);

/** The real PDF worker over a data directory, as the backend launches it. */
export function pdfDocuments(dataDirectory: string) {
  return Documents.layer({
    dataDirectory,
    workerCommand: [
      process.execPath,
      "--no-orphans",
      resolve("backend/documents/pdf-worker-main.ts"),
    ],
    assetsDirectory: dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))),
    nativeLibraryPath: nativeFile,
  });
}

/**
 * Hold the data directory, migrate its database and compose review operations over scoped SQL,
 * like one application launch. Closing the enclosing scope ends the launch.
 */
export const openReviewOperations = Effect.fn("test.openReviewOperations")(function* (
  directory: string,
  documents: Documents["Service"] | undefined,
) {
  const owner = yield* acquireDataDirectoryOwnership(directory);
  const filename = join(directory, "app.sqlite");
  yield* Effect.scoped(
    migrateDatabase(filename, resolve("migrations"), join(directory, "backups")),
  );
  const queries = yield* Semaphore.make(1);
  const connection = SqliteClient.layer({ filename });

  const query = <A>(operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys=ON`;

        return yield* operation.pipe(Effect.provide(ReviewStore.layer));
      }).pipe(Effect.provide(connection)),
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(ReviewError)(cause)
          ? cause
          : new ReviewStorageError({ message: "Fixture review storage unavailable." }),
      ),
      Semaphore.withPermit(queries),
    );

  /** Raw SQL for seeding and inspecting rows the public operations do not expose. */
  const database = <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.scoped(operation.pipe(Effect.provide(connection))).pipe(Semaphore.withPermit(queries));

  return {
    owner,
    query,
    database,
    review: createReviewOperations({ query, owner, documents }),
    /** Artifact records stored for a project, whether or not a snapshot could still load them. */
    artifactRecords: (projectId: typeof ProjectId.Type) =>
      database(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{
              readonly n: number;
            }>`SELECT count(*) AS n FROM review_records WHERE project_id=${projectId} AND kind='artifact'`,
        ),
      ).pipe(Effect.map((rows) => rows[0]?.n ?? 0)),
  };
});

/** Create a project and import one PDF through the public operations. */
export const importProject = Effect.fn("test.importProject")(function* (
  review: ReturnType<typeof createReviewOperations>,
  source: string,
) {
  const project = yield* review.command(
    ReviewCommand.cases.CreateProject.make({ commandId: commandId(), name: "Render fixture" }),
  );

  yield* review.importPdf({
    commandId: commandId(),
    projectId: project.projectId,
    expectedVersion: project.version,
    source,
    name: "Source",
  });

  return project.projectId;
});

/** Worker jobs of one kind that started while `MOKE_PDF_WORKER_STARTED_DIRECTORY` named a directory. */
export async function startedJobs(directory: string, kind: "Inspect" | "Render" | "Text") {
  return (await readdir(directory)).filter((name) => name.startsWith(`${kind}.`)).length;
}

/** The same region moved or resized by the given amounts. */
export function shiftRegion(
  region: Region,
  change: { readonly x?: number; readonly y?: number; readonly width?: number },
) {
  return new Region({
    x: region.x + (change.x ?? 0),
    y: region.y + (change.y ?? 0),
    width: region.width + (change.width ?? 0),
    height: region.height,
  });
}
