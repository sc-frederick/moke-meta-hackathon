import { expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Result, Schema, Semaphore, Struct } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Documents } from "../../backend/documents/documents.ts";
import { ImportedPdf } from "../../backend/documents/types.ts";
import { migrateDatabase } from "../../backend/database-files.ts";
import { acquireDataDirectoryOwnership } from "../../backend/ownership.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { suggestedSheetLabel } from "../../backend/documents/sheet-label.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import {
  CommandId,
  DocumentError,
  FindingId,
  Region,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
  SuggestedSheetLabel,
} from "#lib/review/contracts.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

test("PDF import proposes printed sheet identities and retains original page references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-labels-"));
  const source = join(directory, "lighting.pdf");
  await writeFile(source, createHeroPdf("A"));

  const native = dirname(
    fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`)),
  );

  try {
    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        const imported = yield* documents.importPdf(source);
        yield* Effect.promise(() => rm(source));
        const inspected = yield* documents.inspectStored(imported.sha256);
        expect(inspected).toEqual(imported);
        yield* Effect.promise(() =>
          writeFile(
            join(directory, "artifacts", `${imported.sha256}.pdf`),
            "%PDF-1.7\nchanged bytes",
          ),
        );
        const corrupted = yield* Effect.result(documents.inspectStored(imported.sha256));
        expect(Result.isFailure(corrupted)).toBe(true);

        if (Result.isFailure(corrupted)) {
          expect(Schema.is(DocumentError)(corrupted.failure)).toBe(true);
          expect(corrupted.failure.message).toContain("hash does not match");
        }

        return inspected;
      }).pipe(
        Effect.provide(
          Documents.layer({
            dataDirectory: directory,
            workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
            assetsDirectory: resolve("node_modules/pdfjs-dist"),
            nativeLibraryPath: join(native, canvasNativeFileName()),
          }),
        ),
      ),
    );

    expect(imported.pages[0]?.label).toBe("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
    expect(imported.pages[1]?.label).toBe("L-601 · FIXTURE SCHEDULE AND CONTROL DETAIL · Page 2");
    expect(imported.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing generic sheet names are suggested without mutation and applied without changing verification or count evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-existing-labels-"));
  const source = join(directory, "lighting.pdf");
  await writeFile(source, createHeroPdf("A"));

  const native = dirname(
    fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`)),
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* acquireDataDirectoryOwnership(directory);
          const filename = join(directory, "app.sqlite");
          yield* Effect.scoped(
            migrateDatabase(filename, resolve("migrations"), join(directory, "backups")),
          );
          const queries = yield* Semaphore.make(1);
          const connection = SqliteClient.layer({ filename });

          const query = <A>(operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>) =>
            Effect.scoped(
              operation.pipe(Effect.provide(ReviewStore.layer.pipe(Layer.provide(connection)))),
            ).pipe(
              Effect.mapError((cause) =>
                Schema.is(ReviewError)(cause)
                  ? cause
                  : new ReviewStorageError({ message: "Fixture database unavailable." }),
              ),
              Semaphore.withPermit(queries),
            );

          const documents = yield* Documents;
          const review = createReviewOperations({ query, owner, documents });

          const project = yield* review.command(
            ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Existing inventory" }),
          );

          const imported = yield* documents.importPdf(source);

          // Simulate an inventory persisted by the former importer, using the same immutable PDF.
          const legacy = new ImportedPdf({
            sha256: imported.sha256,
            byteLength: imported.byteLength,
            pages: imported.pages.map((page) => ({ ...page, label: `Page ${page.pageIndex + 1}` })),
          });

          const receipt = yield* query(
            Effect.flatMap(ReviewStore, (store) =>
              store.importPdf(
                {
                  commandId: id(),
                  projectId: project.projectId,
                  expectedVersion: project.version,
                  name: "Legacy revision",
                },
                legacy,
              ),
            ),
          );

          let state = yield* review.snapshot(project.projectId, 0);
          const first = state.sheets[0];
          const second = state.sheets[1];
          const revision = state.revisions[0];

          if (!first || !second || !revision) return yield* Effect.die("Missing fixture source");
          yield* review.command(
            ReviewCommand.cases.ConfirmSheet.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: receipt.version,
              sheetId: first.id,
              label: first.label,
              coverage: "reviewer_complete",
            }),
          );
          state = yield* review.snapshot(project.projectId, 0);

          const finding = yield* review.command(
            ReviewCommand.cases.CreateFinding.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: state.project?.version ?? -1,
              title: "Existing count evidence",
              objectClass: "Type A fixtures",
              drawnSheetId: first.id,
              scheduledSheetId: first.id,
              applicabilityConfirmed: true,
            }),
          );

          yield* review.command(
            ReviewCommand.cases.AcceptCount.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: finding.version,
              findingId: Schema.decodeUnknownSync(FindingId)(finding.entityId),
              side: "drawn",
              value: 2,
              unit: "count",
              coverageConfirmed: true,
              rationale: "Existing reviewer input must survive a label-only edit.",
              evidence: {
                sheetId: first.id,
                region: first.box,
                statement: "Two fixtures in the existing source",
              },
            }),
          );
          const before = yield* review.snapshot(project.projectId, 0);
          yield* Effect.promise(() => rm(source));

          const suggestions = yield* review.suggestSheetLabels({
            projectId: project.projectId,
            revisionId: revision.id,
          });

          expect(suggestions.proposals.map((proposal) => proposal.status)).toEqual([
            "suggested",
            "suggested",
          ]);
          expect(suggestions.proposals.map((proposal) => proposal.currentLabel)).toEqual([
            "Page 1",
            "Page 2",
          ]);
          expect(yield* review.snapshot(project.projectId, 0)).toEqual(before);

          const labels = suggestions.proposals.flatMap((proposal) =>
            proposal.proposedLabel
              ? [{ sheetId: proposal.sheetId, label: proposal.proposedLabel }]
              : [],
          );

          const command = ReviewCommand.cases.ApplySheetLabels.make({
            commandId: id(),
            projectId: project.projectId,
            expectedVersion: before.project?.version ?? -1,
            revisionId: revision.id,
            labels: Schema.decodeUnknownSync(Schema.NonEmptyArray(SuggestedSheetLabel))(labels),
          });

          const applied = yield* review.command(command);
          expect(yield* review.command(command)).toEqual(applied);
          const after = yield* review.snapshot(project.projectId, 0);
          expect(after.sheets.map((sheet) => Struct.assign(sheet, { label: "" }))).toEqual(
            before.sheets.map((sheet) => Struct.assign(sheet, { label: "" })),
          );
          expect(after.sheets[0]?.label).toBe("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
          expect(after.sheets[1]?.label).toBe(
            "L-601 · FIXTURE SCHEDULE AND CONTROL DETAIL · Page 2",
          );
          expect(after.sheets[0]?.confirmed).toBe(true);
          expect(after.sheets[1]?.confirmed).toBe(false);
          expect(after.project?.sourceVersion).toBe(before.project?.sourceVersion);
          expect(after.project?.factVersion).toBe(before.project?.factVersion);
          expect(after.revisions).toEqual(before.revisions);
          expect(after.artifacts).toEqual(before.artifacts);
          expect(after.findings).toEqual(before.findings);
          expect(after.facts).toEqual(before.facts);
          expect(after.checks).toEqual(before.checks);

          const overwrite = yield* Effect.result(
            review.command(
              ReviewCommand.cases.ApplySheetLabels.make({
                ...command,
                commandId: id(),
                expectedVersion: applied.version,
              }),
            ),
          );

          expect(Result.isFailure(overwrite)).toBe(true);
          expect(
            (yield* review.suggestSheetLabels({
              projectId: project.projectId,
              revisionId: revision.id,
            })).proposals.map((proposal) => proposal.status),
          ).toEqual(["preserved", "preserved"]);
          expect(yield* review.snapshot(project.projectId, 0)).toEqual(after);

          const customImport = yield* query(
            Effect.flatMap(ReviewStore, (store) =>
              store.importPdf(
                {
                  commandId: id(),
                  projectId: project.projectId,
                  expectedVersion: applied.version,
                  name: "Mixed labels",
                },
                new ImportedPdf({
                  sha256: imported.sha256,
                  byteLength: imported.byteLength,
                  pages: imported.pages.map((page) => ({
                    ...page,
                    label: page.pageIndex === 0 ? "Page 1" : "Reviewer-defined schedule",
                  })),
                }),
              ),
            ),
          );

          const customState = yield* review.snapshot(project.projectId, 0);
          const customRevision = customState.revisions.at(-1);

          if (!customRevision) return yield* Effect.die("Missing custom-label fixture");

          const mixed = yield* review.suggestSheetLabels({
            projectId: project.projectId,
            revisionId: customRevision.id,
          });

          expect(mixed.proposals.map((proposal) => proposal.status)).toEqual([
            "suggested",
            "preserved",
          ]);
          const custom = mixed.proposals.find((proposal) => proposal.status === "preserved");
          const suggested = mixed.proposals.find((proposal) => proposal.status === "suggested");

          if (!custom || !suggested?.proposedLabel)
            return yield* Effect.die("Missing mixed-label proposals");
          expect(custom.currentLabel).toBe("Reviewer-defined schedule");
          expect(custom.proposedLabel).toBeNull();

          const blockedBatch = yield* Effect.result(
            review.command(
              ReviewCommand.cases.ApplySheetLabels.make({
                commandId: id(),
                projectId: project.projectId,
                expectedVersion: customImport.version,
                revisionId: customRevision.id,
                labels: [
                  { sheetId: suggested.sheetId, label: suggested.proposedLabel },
                  { sheetId: custom.sheetId, label: "Cannot overwrite this reviewer label" },
                ],
              }),
            ),
          );

          expect(Result.isFailure(blockedBatch)).toBe(true);
          expect(yield* review.snapshot(project.projectId, 0)).toEqual(customState);

          const foreignProject = yield* review.command(
            ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Other project" }),
          );

          const foreignRead = yield* Effect.result(
            review.suggestSheetLabels({
              projectId: foreignProject.projectId,
              revisionId: customRevision.id,
            }),
          );

          expect(Result.isFailure(foreignRead)).toBe(true);
        }).pipe(
          Effect.provide(
            Documents.layer({
              dataDirectory: directory,
              workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
              assetsDirectory: resolve("node_modules/pdfjs-dist"),
              nativeLibraryPath: join(native, canvasNativeFileName()),
            }),
          ),
        ),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous title-block text stays a generic page label", () => {
  const box = new Region({ x: 0, y: 0, width: 100, height: 100 });
  expect(
    suggestedSheetLabel(
      2,
      null,
      [
        { text: "S-2", x: 90, y: 10 },
        { text: "A-1", x: 90, y: 20 },
      ],
      box,
    ),
  ).toBe("Page 3");
  expect(suggestedSheetLabel(2, "FA-2", [], box)).toBe("FA-2 · Page 3");
});
