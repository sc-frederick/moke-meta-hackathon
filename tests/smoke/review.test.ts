import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BackendApi } from "../../desktop/backend.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import { CommandId, FindingId, OperationId, Region, ReviewCommand } from "#lib/review/contracts.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

const commandId = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

test("real backend reviews, corrects, revisions, chunks evidence, and reopens without losing history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-review-"));
  const packageParent = await mkdtemp(join(tmpdir(), "moke-full-package-"));
  const revA = join(directory, "Revision A.pdf");
  const revB = join(directory, "Revision B.pdf");
  await writeFile(revA, createHeroPdf("A"));
  await writeFile(revB, createHeroPdf("B"));

  const native = dirname(
    fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`)),
  );

  const launch = BackendApi.layer({
    command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
    dataDirectory: directory,
    migrationDirectory: resolve("migrations"),
    processing: {
      workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
      assetsDirectory: resolve("node_modules/pdfjs-dist"),
      nativeLibraryPath: join(native, canvasNativeFileName()),
    },
  });

  try {
    const evidence = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;

          const create = yield* api.ReviewCommand({
            command: ReviewCommand.cases.CreateProject.make({
              commandId: commandId(),
              name: "Original lighting coordination",
            }),
          });

          const projectId = create.projectId;
          let state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });
          const version = () => state.project?.version ?? -1;
          const refresh = api.ReviewSnapshot({ projectId, afterSequence: 0 });
          yield* api.ImportReviewPdf({
            projectId,
            expectedVersion: version(),
            commandId: commandId(),
            source: revA,
            name: "Rev A",
          });
          state = yield* refresh;
          const plan = state.sheets.find((sheet) => sheet.pageIndex === 0);
          const schedule = state.sheets.find((sheet) => sheet.pageIndex === 1);

          if (plan === undefined || schedule === undefined)
            return yield* Effect.die("Fixture sheets were not imported.");

          for (const [sheet, label] of [
            [plan, "L-101"],
            [schedule, "L-601"],
          ] as const) {
            yield* api.ReviewCommand({
              command: ReviewCommand.cases.ConfirmSheet.make({
                commandId: commandId(),
                projectId,
                expectedVersion: version(),
                sheetId: sheet.id,
                label,
                coverage: "reviewer_complete",
              }),
            });
            state = yield* refresh;
          }

          const createFinding = Effect.fn("test.createFinding")(function* (
            title: string,
            control = false,
          ) {
            const result = yield* api.ReviewCommand({
              command: ReviewCommand.cases.CreateFinding.make({
                commandId: commandId(),
                projectId,
                expectedVersion: version(),
                title,
                objectClass: title,
                drawnSheetId: control ? schedule.id : plan.id,
                scheduledSheetId: schedule.id,
                applicabilityConfirmed: true,
              }),
            });

            state = yield* refresh;

            return Schema.decodeUnknownSync(FindingId)(result.entityId);
          });

          const accept = Effect.fn("test.accept")(function* (
            findingId: typeof FindingId.Type,
            side: "drawn" | "scheduled",
            value: number,
            sheet = side === "drawn" ? plan : schedule,
            rationale = "Reviewed the original schematic and confirmed the selected scope.",
          ) {
            const request = ReviewCommand.cases.AcceptCount.make({
              commandId: commandId(),
              projectId,
              expectedVersion: version(),
              findingId,
              side,
              value,
              unit: "count",
              coverageConfirmed: true,
              evidence: {
                sheetId: sheet.id,
                region: sheet.box,
                statement: `${value} source-reviewed ${side} fixtures in the explicitly selected scope.`,
              },
              rationale,
            });

            const receipt = yield* api.ReviewCommand({ command: request });
            state = yield* refresh;

            return { request, receipt };
          });

          const evaluate = Effect.fn("test.evaluate")(function* (findingId: typeof FindingId.Type) {
            const result = yield* api.ReviewCommand({
              command: ReviewCommand.cases.EvaluateFinding.make({
                commandId: commandId(),
                projectId,
                expectedVersion: version(),
                findingId,
              }),
            });

            state = yield* refresh;
            const check = state.checks.find((item) => item.id === result.entityId);

            if (check === undefined)
              return yield* Effect.die("The committed calculation was missing.");

            return check;
          });

          const supported = yield* createFinding("Room 101 type A");
          const blankNote = yield* accept(supported, "drawn", 2, plan, "");
          expect(
            state.facts.find((fact) => fact.id === blankNote.receipt.entityId)?.rationale,
          ).toBe("");
          yield* accept(supported, "scheduled", 3);
          const issue = yield* evaluate(supported);
          expect(issue.outcome).toBe("supported_issue");
          expect(issue.difference).toBe(-1);
          const corrected = yield* createFinding("Room 102 type B");
          yield* accept(corrected, "drawn", 1);
          yield* accept(corrected, "scheduled", 2);
          const falseAlarm = yield* evaluate(corrected);
          expect(falseAlarm.outcome).toBe("supported_issue");
          const control = yield* createFinding("Independent type C control", true);
          yield* accept(control, "drawn", 2, schedule);
          yield* accept(control, "scheduled", 2, schedule);
          const controlRun = yield* evaluate(control);
          const correction = yield* accept(corrected, "drawn", 2);
          expect(state.findings.find((finding) => finding.id === corrected)?.outcome).toBe("stale");
          expect(state.findings.find((finding) => finding.id === control)?.latestCheckId).toBe(
            controlRun.id,
          );
          const cleared = yield* evaluate(corrected);
          expect(cleared.outcome).toBe("checked_no_issue");
          expect(state.checks.some((check) => check.id === falseAlarm.id)).toBe(true);
          const replay = yield* api.ReviewCommand({ command: correction.request });
          expect(replay).toEqual(correction.receipt);

          const conflict = yield* Effect.exit(
            api.ReviewCommand({ command: { ...correction.request, value: 100 } }),
          );

          expect(Exit.isFailure(conflict)).toBe(true);

          const stale = yield* Effect.exit(
            api.ReviewCommand({ command: { ...correction.request, commandId: commandId() } }),
          );

          expect(Exit.isFailure(stale)).toBe(true);

          const rendered = yield* api.RenderSource({
            projectId,
            sheetId: plan.id,
            operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
            region: new Region({ x: 0, y: 0, width: 612, height: 792 }),
            dpi: 300,
          });

          expect(rendered.width).toBe(2550);
          expect(Math.abs(rendered.height - 3300)).toBeLessThanOrEqual(1);
          expect(rendered.byteLength).toBeGreaterThan(65536);
          const buffers: Array<Buffer> = [];

          for (let offset = 0; offset < rendered.byteLength; offset += 32768) {
            const chunk = yield* api.ReadArtifactChunk({
              projectId,
              artifactId: rendered.id,
              offset,
              limit: 32768,
            });

            buffers.push(Buffer.from(chunk.base64, "base64"));
            expect(chunk.totalBytes).toBe(rendered.byteLength);
          }

          expect(new Bun.CryptoHasher("sha256").update(Buffer.concat(buffers)).digest("hex")).toBe(
            rendered.sha256,
          );

          const other = yield* api.ReviewCommand({
            command: ReviewCommand.cases.CreateProject.make({
              commandId: commandId(),
              name: "Other project",
            }),
          });

          expect(
            Exit.isFailure(
              yield* Effect.exit(
                api.ReadArtifactChunk({
                  projectId: other.projectId,
                  artifactId: rendered.id,
                  offset: 0,
                  limit: 1024,
                }),
              ),
            ),
          ).toBe(true);

          state = yield* refresh;
          yield* api.ImportReviewPdf({
            projectId,
            expectedVersion: version(),
            commandId: commandId(),
            source: revB,
            name: "Rev B",
          });
          state = yield* refresh;
          const newRevision = state.revisions.findLast((revision) => revision.name === "Rev B");

          const newPlan = state.sheets.find(
            (sheet) => sheet.revisionId === newRevision?.id && sheet.pageIndex === 0,
          );

          const newSchedule = state.sheets.find(
            (sheet) => sheet.revisionId === newRevision?.id && sheet.pageIndex === 1,
          );

          if (newRevision === undefined || newPlan === undefined || newSchedule === undefined)
            return yield* Effect.die("Revision B was not imported.");
          // A legal finding may already point at the confirmed destination before association.
          yield* api.ReviewCommand({
            command: ReviewCommand.cases.ConfirmSheet.make({
              commandId: commandId(),
              projectId,
              expectedVersion: version(),
              sheetId: newPlan.id,
              label: "L-101 B",
              coverage: "reviewer_complete",
            }),
          });
          state = yield* refresh;
          yield* api.ReviewCommand({
            command: ReviewCommand.cases.CreateFinding.make({
              commandId: commandId(),
              projectId,
              expectedVersion: version(),
              title: "Already on revision B",
              objectClass: "Type A",
              drawnSheetId: newPlan.id,
              scheduledSheetId: schedule.id,
              applicabilityConfirmed: true,
            }),
          });
          state = yield* refresh;
          yield* api.ReviewCommand({
            command: ReviewCommand.cases.AssociateRevision.make({
              commandId: commandId(),
              projectId,
              expectedVersion: version(),
              revisionId: newRevision.id,
              correspondence: [
                {
                  oldSheetId: plan.id,
                  newSheetId: newPlan.id,
                  confirmed: true,
                  content: "changed",
                },
                {
                  oldSheetId: schedule.id,
                  newSheetId: newSchedule.id,
                  confirmed: true,
                  content: "unchanged",
                },
              ],
            }),
          });
          state = yield* refresh;
          expect(state.findings.find((finding) => finding.id === supported)?.outcome).toBe("stale");
          expect(state.findings.find((finding) => finding.id === control)?.latestCheckId).toBe(
            controlRun.id,
          );
          expect(state.findings.find((finding) => finding.id === control)?.outcome).toBe(
            "checked_no_issue",
          );
          expect(state.sheets.find((sheet) => sheet.id === newPlan.id)?.confirmed).toBe(true);
          const rejected = yield* evaluate(supported);
          expect(rejected.outcome).toBe("needs_evidence");
          expect(rejected.drawnFactId).toBeNull();
          expect(rejected.drawnCount).toBeNull();
          expect(rejected.scheduledFactId).not.toBeNull();
          expect(rejected.explanation).toContain("changed or unconfirmed");
          const dependencies = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });
          expect(
            dependencies
              .prepare("SELECT input_id FROM review_dependencies WHERE dependent_id=?")
              .all(rejected.id),
          ).toEqual([{ input_id: rejected.scheduledFactId }]);
          dependencies.close();

          const rewritten = yield* Effect.exit(
            api.ReviewCommand({
              command: ReviewCommand.cases.AssociateRevision.make({
                commandId: commandId(),
                projectId,
                expectedVersion: version(),
                revisionId: newRevision.id,
                correspondence: [
                  {
                    oldSheetId: plan.id,
                    newSheetId: newPlan.id,
                    confirmed: true,
                    content: "unchanged",
                  },
                ],
              }),
            }),
          );

          expect(Exit.isFailure(rewritten)).toBe(true);

          const ambiguous = yield* Effect.exit(
            api.ReviewCommand({
              command: ReviewCommand.cases.AssociateRevision.make({
                commandId: commandId(),
                projectId,
                expectedVersion: version(),
                revisionId: newRevision.id,
                correspondence: [
                  {
                    oldSheetId: plan.id,
                    newSheetId: newSchedule.id,
                    confirmed: true,
                    content: "unchanged",
                  },
                ],
              }),
            }),
          );

          expect(Exit.isFailure(ambiguous)).toBe(true);
          yield* accept(supported, "drawn", 3, newPlan);
          const revised = yield* evaluate(supported);
          expect(revised.outcome).toBe("checked_no_issue");
          expect(revised.drawnFactId).not.toBe(issue.drawnFactId);
          const partial = join(directory, "partial.sqlite");
          yield* api.ExportDatabase({ destination: partial });
          expect(Exit.isFailure(yield* Effect.exit(api.RestoreDatabase({ source: partial })))).toBe(
            true,
          );
          state = yield* refresh;

          const exported = yield* api.ExportReviewPackage({
            destination: join(packageParent, "complete"),
          });

          expect(exported).toBeDefined();
          const original = state.revisions[0];

          if (original === undefined) return yield* Effect.die("No source original");
          const sourceFile = join(directory, "artifacts", `${original.sha256}.pdf`);
          yield* Effect.promise(() => rename(sourceFile, `${sourceFile}.held`));
          const unavailable = yield* Effect.exit(evaluate(control));
          expect(Exit.isFailure(unavailable)).toBe(true);
          yield* Effect.promise(() => rename(`${sourceFile}.held`, sourceFile));
          yield* api.RestoreReviewPackage({ source: join(packageParent, "complete") });
          state = yield* refresh;

          return {
            projectId,
            blankNoteFactId: blankNote.receipt.entityId,
            hashes: state.revisions.map((revision) => revision.sha256),
            checkIds: state.checks.map((check) => check.id),
          };
        }).pipe(Effect.provide(launch)),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;

          const state = yield* api.ReviewSnapshot({
            projectId: evidence.projectId,
            afterSequence: 0,
          });

          expect(state.revisions.map((revision) => revision.sha256)).toEqual(evidence.hashes);
          expect(state.checks.map((check) => check.id)).toEqual(evidence.checkIds);
          expect(state.facts.find((fact) => fact.id === evidence.blankNoteFactId)?.rationale).toBe(
            "",
          );
          expect(
            state.events.every(
              (event, index, events) =>
                index === 0 || event.sequence > (events[index - 1]?.sequence ?? 0),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(launch)),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(packageParent, { recursive: true, force: true });
  }
}, 60000);
