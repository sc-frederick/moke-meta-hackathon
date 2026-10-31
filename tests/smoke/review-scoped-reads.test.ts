import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Documents } from "../../backend/documents/documents.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import {
  importProject,
  openReviewOperations,
  pdfDocuments,
  shiftRegion,
} from "../fixtures/review-operations.ts";
import {
  ArtifactId,
  OperationId,
  Region,
  ReviewInputError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";

const operationId = () => Schema.decodeUnknownSync(OperationId)(crypto.randomUUID());

test("crop and segment lookups read only their own records, not the workbench snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-scoped-reads-"));
  const source = join(directory, "plans.pdf");
  await writeFile(source, createHeroPdf("A"));

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { review, database } = yield* openReviewOperations(directory, yield* Documents);
          const projectId = yield* importProject(review, source);
          const other = yield* importProject(review, source);
          const sheet = (yield* review.snapshot(projectId, 0)).sheets[0];
          const foreign = (yield* review.snapshot(other, 0)).sheets[0];

          if (sheet === undefined || foreign === undefined)
            return yield* Effect.die("Missing fixture sheet");

          // Unrelated history that a full snapshot must decode, but a crop never needs.
          yield* database(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              Effect.forEach(
                [
                  ["message", crypto.randomUUID()],
                  ["artifact", crypto.randomUUID()],
                ] as const,
                ([kind, id]) =>
                  sql`INSERT INTO review_records (project_id,id,kind,payload) VALUES (${projectId},${id},${kind},${JSON.stringify({ id, projectId, unrelated: true })})`,
                { discard: true },
              ),
            ),
          );

          const snapshot = yield* Effect.result(review.snapshot(projectId, 0));
          expect(
            Result.isFailure(snapshot) && Schema.is(ReviewStorageError)(snapshot.failure),
          ).toBe(true);

          const request = {
            projectId,
            sheetId: sheet.id,
            operationId: operationId(),
            region: new Region({ x: 60, y: 360, width: 230, height: 300 }),
            dpi: 96,
          };

          const crop = yield* review.render(request);
          expect(crop.sheetId).toBe(sheet.id);
          expect(yield* review.render(request)).toEqual(crop);
          expect(yield* review.render({ ...request, operationId: operationId() })).toEqual(crop);

          // Render-input and operation checks are unchanged by the narrow reads.
          const changed = yield* Effect.result(
            review.render({ ...request, region: shiftRegion(request.region, { x: 1 }) }),
          );

          expect(Result.isFailure(changed) && Schema.is(ReviewInputError)(changed.failure)).toBe(
            true,
          );

          const outside = yield* Effect.result(
            review.render({ ...request, sheetId: foreign.id, operationId: operationId() }),
          );

          expect(
            Result.isFailure(outside) &&
              Schema.is(ReviewInputError)(outside.failure) &&
              outside.failure.message === "The source sheet is outside this project.",
          ).toBe(true);

          // Segmentation finds its source artifact by ID, within the owning project only.
          expect(yield* review.artifact(projectId, crop.id)).toEqual(crop);
          expect(Result.isFailure(yield* Effect.result(review.artifact(other, crop.id)))).toBe(
            true,
          );

          expect(
            Result.isFailure(
              yield* Effect.result(
                review.artifact(
                  projectId,
                  Schema.decodeUnknownSync(ArtifactId)(crypto.randomUUID()),
                ),
              ),
            ),
          ).toBe(true);

          const image = yield* review.port.readImage(yield* review.artifact(projectId, crop.id));
          expect(image.artifactId).toBe(crop.id);
        }).pipe(Effect.provide(pdfDocuments(directory))),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
