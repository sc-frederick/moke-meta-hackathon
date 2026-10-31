import { afterEach, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Documents } from "../../backend/documents/documents.ts";
import { pdfRendererVersion, renderIdentity } from "../../backend/documents/render-identity.ts";
import { ExecutionFence } from "../../backend/review/execution-port.ts";
import type { createReviewOperations } from "../../backend/review/operations.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import {
  commandId,
  importProject,
  openReviewOperations,
  pdfDocuments,
  shiftRegion,
  startedJobs,
} from "../fixtures/review-operations.ts";
import {
  Artifact,
  ArtifactId,
  FindingId,
  OperationId,
  type ProjectId,
  Region,
  ReviewCommand,
  ReviewInputError,
} from "#lib/review/contracts.ts";

const operationId = () => Schema.decodeUnknownSync(OperationId)(crypto.randomUUID());
const directories: Array<string> = [];

const directory = async (prefix: string) => {
  const created = await mkdtemp(join(tmpdir(), prefix));
  directories.push(created);

  return created;
};

afterEach(async () => {
  delete process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("render identity covers the source, page geometry, exact region, effective DPI and renderer", async () => {
  const page = { pageIndex: 0, rotation: 0, userUnit: 1 } as const;
  const region = new Region({ x: 10, y: 20, width: 30, height: 40 });
  const base = renderIdentity("a".repeat(64), page, region, 200);

  expect(renderIdentity("a".repeat(64), page, shiftRegion(region, {}), 200)).toBe(base);

  for (const changed of [
    renderIdentity("b".repeat(64), page, region, 200),
    renderIdentity("a".repeat(64), { ...page, pageIndex: 1 }, region, 200),
    renderIdentity("a".repeat(64), { ...page, rotation: 90 }, region, 200),
    renderIdentity("a".repeat(64), { ...page, userUnit: 2 }, region, 200),
    renderIdentity("a".repeat(64), page, shiftRegion(region, { x: 0.000001 }), 200),
    renderIdentity("a".repeat(64), page, region, 199.99),
  ])
    expect(changed).not.toBe(base);

  // A dependency upgrade must also change the renderer identity, so old images are not reused.
  for (const name of ["pdfjs-dist", "@napi-rs/canvas"]) {
    const { version } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
    )(await readFile(join("node_modules", name, "package.json"), "utf8"));

    expect(pdfRendererVersion).toContain(`${name}@${version}`);
  }
});

test("equal crops under new tool operations share one worker render and keep a receipt each", async () => {
  const data = await directory("moke-render-reuse-");
  const started = await directory("moke-render-jobs-");
  const source = join(data, "plans.pdf");
  await writeFile(source, createHeroPdf("A"));
  process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY = started;

  const renders = () => Effect.promise(() => startedJobs(started, "Render"));

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const documents = yield* Documents;
        const launch = yield* openReviewOperations(data, documents);
        const { review } = launch;
        const projectId = yield* importProject(review, source);
        let state = yield* review.snapshot(projectId, 0);
        const plan = state.sheets.find((sheet) => sheet.pageIndex === 0);
        const schedule = state.sheets.find((sheet) => sheet.pageIndex === 1);
        const revision = state.revisions[0];

        if (plan === undefined || schedule === undefined || revision === undefined)
          return yield* Effect.die("Missing fixture sheets");
        const crop = new Region({ x: 60, y: 360, width: 230, height: 300 });

        const request = (id: typeof OperationId.Type) => ({
          projectId,
          sheetId: plan.id,
          operationId: id,
          region: crop,
          dpi: 200,
        });

        // Two tool tasks ask for the same crop at once, as parallel sheet reviewers do.
        const first = operationId();
        const second = operationId();

        const [a, b] = yield* Effect.all(
          [review.render(request(first)), review.render(request(second))],
          {
            concurrency: "unbounded",
          },
        );

        expect(b).toEqual(a);
        expect(yield* renders()).toBe(1);
        expect(a.operationId).toBe(first);

        // Each operation replays to its own receipt, and keeps its identity.
        expect(yield* review.render(request(second))).toEqual(a);
        expect(yield* review.render(request(first))).toEqual(a);

        const misused = yield* Effect.result(
          review.render({ ...request(second), region: shiftRegion(crop, { x: 1 }) }),
        );

        expect(Result.isFailure(misused) && Schema.is(ReviewInputError)(misused.failure)).toBe(
          true,
        );

        const receipts = yield* launch.database(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{
                readonly operation_id: string;
                readonly artifact_id: string;
              }>`SELECT operation_id,artifact_id FROM review_render_operations WHERE project_id=${projectId} ORDER BY operation_id`,
          ),
        );

        expect(receipts).toEqual(
          [first, second]
            .toSorted()
            .map((operation) => ({ operation_id: operation, artifact_id: a.id })),
        );

        // The image is valid evidence for each task: it reads back with its exact transforms.
        const image = yield* review.port.readImage(a);
        expect(image.artifactId).toBe(a.id);
        expect(image.sheetId).toBe(plan.id);

        // Concurrent identical renders below review operations also join one worker job.
        const detail = new Region({ x: 100, y: 400, width: 120, height: 90 });

        const [left, right] = yield* Effect.all(
          [
            documents.render(revision.sha256, plan, detail, 150),
            documents.render(revision.sha256, plan, detail, 150),
          ],
          { concurrency: "unbounded" },
        );

        expect(right).toEqual(left);
        expect(yield* renders()).toBe(2);

        // Another region, effective DPI, page or source renders again.
        const moved = yield* review.render({
          ...request(operationId()),
          region: shiftRegion(crop, { x: 1 }),
        });

        const finer = yield* review.render({ ...request(operationId()), dpi: 150 });

        const page = yield* review.render({
          ...request(operationId()),
          sheetId: schedule.id,
          region: shiftRegion(crop, { y: -60 }),
        });

        expect(new Set([a.id, moved.id, finer.id, page.id]).size).toBe(4);
        expect(finer.width).toBeLessThan(a.width);
        expect(yield* renders()).toBe(5);

        const revised = join(data, "plans-b.pdf");
        yield* Effect.promise(() => writeFile(revised, createHeroPdf("B", 90)));
        yield* review.importPdf({
          commandId: commandId(),
          projectId,
          expectedVersion: (yield* review.snapshot(projectId, 0)).project?.version ?? -1,
          source: revised,
          name: "Rotated revision",
        });
        state = yield* review.snapshot(projectId, 0);

        const rotated = state.sheets.find(
          (sheet) => sheet.revisionId !== plan.revisionId && sheet.pageIndex === 0,
        );

        if (rotated === undefined) return yield* Effect.die("Missing rotated sheet");
        expect(rotated.rotation).toBe(90);

        const revisedCrop = yield* review.render({
          ...request(operationId()),
          sheetId: rotated.id,
        });

        expect(revisedCrop.revisionId).toBe(rotated.revisionId);
        expect(revisedCrop.sha256).not.toBe(a.sha256);
        expect(yield* renders()).toBe(6);

        // Selected-count tool commands reuse the same image under their own command receipts.
        const finding = yield* review.command(
          ReviewCommand.cases.CreateFinding.make({
            commandId: commandId(),
            projectId,
            expectedVersion: state.project?.version ?? -1,
            title: "Fixture count",
            objectClass: "Fixtures",
            drawnSheetId: plan.id,
            scheduledSheetId: schedule.id,
            applicabilityConfirmed: true,
          }),
        );

        state = yield* review.snapshot(projectId, 0);

        const fence = Schema.decodeUnknownSync(ExecutionFence)({
          projectId,
          findingId: Schema.decodeUnknownSync(FindingId)(finding.entityId),
          commandId: commandId(),
          runId: crypto.randomUUID(),
          journalId: crypto.randomUUID(),
          ownerGeneration: launch.owner.generation,
          sourceVersion: state.project?.sourceVersion,
          factVersion: state.project?.factVersion,
        });

        yield* launch.database(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql`INSERT INTO review_execution_runs(run_id,project_id,finding_id,journal_id,engine,owner_generation,source_version,fact_version,state,version,route,provider,model,max_calls,max_input_tokens,max_output_tokens) VALUES (${fence.runId},${fence.projectId},${fence.findingId},${fence.journalId},'review-pi-1.4.0-v1',${fence.ownerGeneration},${fence.sourceVersion},${fence.factVersion},'running',0,'recorded','meta','muse-spark-1.3',3,64000,256)`,
          ),
        );

        const inspect = { sheetId: plan.id, region: detail, missingFact: "Fixture count" };
        const counted = yield* review.port.render(fence, inspect);

        const nextFence = Schema.decodeUnknownSync(ExecutionFence)({
          ...Schema.encodeSync(ExecutionFence)(fence),
          commandId: commandId(),
        });

        const recounted = yield* review.port.render(nextFence, inspect);
        expect(recounted).toEqual(counted);
        expect(yield* review.port.render(fence, inspect)).toEqual(counted);
        expect(yield* renders()).toBe(7);

        const commands = yield* launch.database(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{
                readonly n: number;
              }>`SELECT count(*) AS n FROM review_commands WHERE command_id IN (${fence.commandId},${nextFence.commandId}) AND json_extract(receipt,'$.entityId')=${counted.id}`,
          ),
        );

        expect(commands[0]?.n).toBe(2);
      }).pipe(Effect.provide(pdfDocuments(data))),
    ),
  );
}, 120000);

test("reopening previews keeps one artifact record per view across launches and near the record limit", async () => {
  const data = await directory("moke-preview-reuse-");
  const started = await directory("moke-preview-jobs-");
  const source = join(data, "plans.pdf");
  await writeFile(source, createHeroPdf("A"));
  process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY = started;

  const renders = () => Effect.promise(() => startedJobs(started, "Render"));

  // Each pane mount asks for its thumbnails and source view with a fresh operation ID.
  const views = (
    review: ReturnType<typeof createReviewOperations>,
    projectId: typeof ProjectId.Type,
  ) =>
    Effect.gen(function* () {
      const state = yield* review.snapshot(projectId, 0);
      const ids: Array<string> = [];

      for (const sheet of state.sheets) {
        const thumbnail = yield* review.render({
          projectId,
          sheetId: sheet.id,
          operationId: operationId(),
          region: sheet.box,
          dpi: 24,
        });

        ids.push(thumbnail.id);
      }

      const first = state.sheets.find((sheet) => sheet.pageIndex === 0);

      if (first === undefined) return yield* Effect.die("Missing fixture sheet");

      const view = yield* review.render({
        projectId,
        sheetId: first.id,
        operationId: operationId(),
        region: first.box,
        dpi: 96,
      });

      ids.push(view.id);

      return ids;
    });

  const projectId = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { review, artifactRecords, database } = yield* openReviewOperations(
          data,
          yield* Documents,
        );

        const projectId = yield* importProject(review, source);
        const warm = yield* views(review, projectId);
        expect(yield* renders()).toBe(3);
        const records = yield* artifactRecords(projectId);

        for (let mount = 0; mount < 5; mount++)
          expect(yield* views(review, projectId)).toEqual(warm);
        expect(yield* artifactRecords(projectId)).toBe(records);
        expect(yield* renders()).toBe(3);

        // Fill the project to its workbench record ceiling with earlier evidence.
        const template = (yield* review.snapshot(projectId, 0)).artifacts.find(
          (artifact) => artifact.id === warm[0],
        );

        if (template === undefined) return yield* Effect.die("Missing template artifact");
        yield* database(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.withTransaction(
              Effect.forEach(
                Array.from({ length: 2000 - records }, () => crypto.randomUUID()),
                (id) =>
                  sql`INSERT INTO review_records (project_id,id,kind,payload) VALUES (${projectId},${id},'artifact',${JSON.stringify({ ...Schema.encodeSync(Artifact)(template), id, operationId: id })})`,
                { discard: true },
              ),
            ),
          ),
        );

        expect(yield* artifactRecords(projectId)).toBe(2000);

        for (let mount = 0; mount < 5; mount++)
          expect(yield* views(review, projectId)).toEqual(warm);
        expect(yield* artifactRecords(projectId)).toBe(2000);
        expect((yield* review.snapshot(projectId, 0)).artifacts.length).toBe(2000);

        return projectId;
      }).pipe(Effect.provide(pdfDocuments(data))),
    ),
  );

  // A new launch reuses the stored images rather than rendering or recording them again.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { review, artifactRecords } = yield* openReviewOperations(data, yield* Documents);
        const warm = yield* views(review, projectId);
        expect(yield* views(review, projectId)).toEqual(warm);
        expect(yield* artifactRecords(projectId)).toBe(2000);
        expect(yield* renders()).toBe(3);
        expect((yield* review.snapshot(projectId, 0)).artifacts.length).toBe(2000);
      }).pipe(Effect.provide(pdfDocuments(data))),
    ),
  );
}, 120000);

test("renders recorded before migration 0013 still replay by operation and are not reused", async () => {
  const data = await directory("moke-legacy-renders-");
  const started = await directory("moke-legacy-jobs-");
  const earlier = await directory("moke-legacy-migrations-");
  const source = join(data, "plans.pdf");
  await writeFile(source, createHeroPdf("A"));

  for (const name of await readdir("migrations"))
    if (name < "0013") await copyFile(join("migrations", name), join(earlier, name));

  const legacy = Schema.decodeUnknownSync(ArtifactId)(crypto.randomUUID());
  const legacyOperation = operationId();
  const region = new Region({ x: 60, y: 360, width: 230, height: 300 });

  // An earlier build imported the PDF and stored a render without any render receipt.
  const { projectId, sheetId } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { review, database } = yield* openReviewOperations(data, yield* Documents, earlier);
        const projectId = yield* importProject(review, source);
        const state = yield* review.snapshot(projectId, 0);
        const sheet = state.sheets[0];

        if (sheet === undefined) return yield* Effect.die("Missing fixture sheet");

        const artifact = new Artifact({
          id: legacy,
          projectId,
          revisionId: sheet.revisionId,
          sheetId: sheet.id,
          sha256: "c".repeat(64),
          mediaType: "image/png",
          byteLength: 100,
          width: 307,
          height: 400,
          region,
          dpi: 96,
          pdfToPixels: [1, 0, 0, 1, 0, 0],
          pixelsToPdf: [1, 0, 0, 1, 0, 0],
          operationId: legacyOperation,
        });

        yield* database(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql`INSERT INTO review_records (project_id,id,kind,payload) VALUES (${projectId},${legacy},'artifact',${JSON.stringify(artifact)})`,
          ),
        );

        return { projectId, sheetId: sheet.id };
      }).pipe(Effect.provide(pdfDocuments(data))),
    ),
  );

  process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY = started;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { review } = yield* openReviewOperations(data, yield* Documents);
        const request = { projectId, sheetId, operationId: legacyOperation, region, dpi: 96 };

        expect((yield* review.render(request)).id).toBe(legacy);
        expect(yield* Effect.promise(() => startedJobs(started, "Render"))).toBe(0);

        // Its renderer is unknown, so a new operation renders again and that image is reused.
        const fresh = yield* review.render({ ...request, operationId: operationId() });
        expect(fresh.id).not.toBe(legacy);
        expect(yield* review.render({ ...request, operationId: operationId() })).toEqual(fresh);
        expect(yield* Effect.promise(() => startedJobs(started, "Render"))).toBe(1);
      }).pipe(Effect.provide(pdfDocuments(data))),
    ),
  );
}, 60000);
