import { expect, test } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Fiber, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireDataDirectoryOwnership } from "../../backend/ownership.ts";
import { migrateDatabase } from "../../backend/database-files.ts";
import { ImportedPdf } from "../../backend/documents/types.ts";
import { createReviewOperations } from "../../backend/review/operations.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import { ExecutionFence } from "../../backend/review/execution-port.ts";
import {
  CommandId,
  FindingId,
  ReviewCommand,
  ReviewError,
  ReviewStorageError,
} from "#lib/review/contracts.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

test("parent port commits correction while an admitted response waits, rejects stale promotion, and replays its earlier receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-parent-fence-"));

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
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql`PRAGMA foreign_keys=ON`;
                yield* sql`PRAGMA synchronous=FULL`;

                return yield* operation.pipe(Effect.provide(ReviewStore.layer));
              }).pipe(Effect.provide(connection)),
            ).pipe(
              Effect.mapError((cause) =>
                Schema.is(ReviewError)(cause)
                  ? cause
                  : new ReviewStorageError({ message: "Test SQL failed." }),
              ),
              Semaphore.withPermit(queries),
            );

          const operations = createReviewOperations({ query, owner, documents: undefined });

          const project = yield* operations.command(
            ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Fence case" }),
          );

          yield* query(
            Effect.flatMap(ReviewStore, (store) =>
              store.importPdf(
                {
                  commandId: id(),
                  projectId: project.projectId,
                  expectedVersion: project.version,
                  name: "Source",
                },
                new ImportedPdf({
                  sha256: "a".repeat(64),
                  byteLength: 100,
                  pages: [
                    {
                      pageIndex: 0,
                      label: "Scope",
                      box: { x: 0, y: 0, width: 100, height: 100 },
                      rotation: 0,
                      userUnit: 1,
                    },
                  ],
                }),
              ),
            ),
          );
          let state = yield* operations.snapshot(project.projectId, 0);
          const sheet = state.sheets[0];

          if (sheet === undefined) return yield* Effect.die("Missing test sheet");
          yield* operations.command(
            ReviewCommand.cases.ConfirmSheet.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: state.project?.version ?? -1,
              sheetId: sheet.id,
              label: "Scope",
              coverage: "reviewer_complete",
            }),
          );
          state = yield* operations.snapshot(project.projectId, 0);

          const finding = yield* operations.command(
            ReviewCommand.cases.CreateFinding.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: state.project?.version ?? -1,
              title: "Count",
              objectClass: "Fixtures",
              drawnSheetId: sheet.id,
              scheduledSheetId: sheet.id,
              applicabilityConfirmed: true,
            }),
          );

          state = yield* operations.snapshot(project.projectId, 0);

          const fence = Schema.decodeUnknownSync(ExecutionFence)({
            projectId: project.projectId,
            findingId: finding.entityId,
            commandId: id(),
            runId: crypto.randomUUID(),
            journalId: crypto.randomUUID(),
            ownerGeneration: owner.generation,
            sourceVersion: state.project?.sourceVersion,
            factVersion: state.project?.factVersion,
          });

          yield* Effect.scoped(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`INSERT INTO review_execution_runs(run_id,project_id,finding_id,journal_id,engine,owner_generation,source_version,fact_version,state,version,route,provider,model,max_calls,max_input_tokens,max_output_tokens) VALUES (${fence.runId},${fence.projectId},${fence.findingId},${fence.journalId},'review-pi-1.4.0-v1',${owner.generation},${fence.sourceVersion},${fence.factVersion},'pausing',0,'recorded','meta','muse-spark-1.3',3,64000,256)`,
            ).pipe(Effect.provide(connection)),
          );

          yield* Effect.scoped(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`INSERT INTO review_execution_attempts(journal_id,task_id,attempt,run_id,owner_generation,fingerprint,status,sent,response_json) VALUES (${fence.journalId},1,1,${fence.runId},${owner.generation},'recorded-test','completed',1,'{"responseId":"recorded-parent-fence"}')`,
            ).pipe(Effect.provide(connection)),
          );

          const proposal = {
            side: "drawn" as const,
            value: 1,
            evidence: { sheetId: sheet.id, region: sheet.box, statement: "One proposed fixture" },
            rationale: "Source interpretation only",
          };

          const receipt = yield* operations.port.propose(fence, proposal);
          const release = Promise.withResolvers<void>();

          const late = yield* Effect.forkChild(
            Effect.promise(() => release.promise).pipe(
              Effect.andThen(
                operations.port.propose(
                  Schema.decodeUnknownSync(ExecutionFence)({
                    ...Schema.encodeSync(ExecutionFence)(fence),
                    commandId: id(),
                  }),
                  proposal,
                ),
              ),
              Effect.result,
            ),
          );

          state = yield* operations.snapshot(project.projectId, 0);
          yield* operations.command(
            ReviewCommand.cases.AcceptCount.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: state.project?.version ?? -1,
              findingId: Schema.decodeUnknownSync(FindingId)(finding.entityId),
              side: "drawn",
              value: 2,
              unit: "count",
              coverageConfirmed: true,
              evidence: proposal.evidence,
              rationale: "Reviewer corrected the proposed interpretation",
            }),
          );

          const reopenedFence = Schema.decodeUnknownSync(ExecutionFence)({
            ...Schema.encodeSync(ExecutionFence)(fence),
            ownerGeneration: crypto.randomUUID(),
          });

          expect(yield* operations.port.propose(reopenedFence, proposal)).toEqual(receipt);

          const changedReplay = yield* Effect.result(
            operations.port.propose(reopenedFence, { ...proposal, value: 9 }),
          );

          expect(Result.isFailure(changedReplay)).toBe(true);
          release.resolve();
          const result = yield* Fiber.join(late);
          expect(Result.isFailure(result)).toBe(true);

          if (Result.isFailure(result)) expect(result.failure.reason).toBe("conflict");
          const final = yield* operations.snapshot(project.projectId, 0);
          expect(final.facts.filter((fact) => fact.state === "proposed")).toHaveLength(1);
          expect(final.facts.find((fact) => fact.state === "proposed")?.origin?.responseId).toBe(
            "recorded-parent-fence",
          );
          expect(
            final.facts.filter((fact) => fact.state === "accepted").map((fact) => fact.value),
          ).toEqual([2]);
          expect(final.findings[0]?.outcome).toBe("stale");
          yield* query(
            Effect.flatMap(ReviewStore, (store) =>
              store.importPdf(
                {
                  commandId: id(),
                  projectId: project.projectId,
                  expectedVersion: final.project?.version ?? -1,
                  name: "Revision B",
                },
                new ImportedPdf({
                  sha256: "b".repeat(64),
                  byteLength: 100,
                  pages: [
                    { pageIndex: 0, label: "Scope B", box: sheet.box, rotation: 0, userUnit: 1 },
                  ],
                }),
              ),
            ),
          );
          const imported = yield* operations.snapshot(project.projectId, 0);
          const next = imported.sheets.find((candidate) => candidate.id !== sheet.id);

          if (next === undefined) return yield* Effect.die("Missing revision B");
          yield* operations.command(
            ReviewCommand.cases.AssociateRevision.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: imported.project?.version ?? -1,
              revisionId: next.revisionId,
              correspondence: [
                { oldSheetId: sheet.id, newSheetId: next.id, content: "changed", confirmed: false },
              ],
            }),
          );
          const pending = yield* operations.snapshot(project.projectId, 0);
          expect(pending.findings[0]?.drawnSheetId).toBe(sheet.id);
          yield* operations.command(
            ReviewCommand.cases.AssociateRevision.make({
              commandId: id(),
              projectId: project.projectId,
              expectedVersion: pending.project?.version ?? -1,
              revisionId: next.revisionId,
              correspondence: [
                { oldSheetId: sheet.id, newSheetId: next.id, content: "changed", confirmed: true },
              ],
            }),
          );
          const associated = yield* operations.snapshot(project.projectId, 0);
          expect(associated.findings[0]?.drawnSheetId).toBe(next.id);
          expect(associated.sheets.find((candidate) => candidate.id === next.id)?.confirmed).toBe(
            true,
          );

          const counts = yield* Effect.scoped(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`SELECT (SELECT count(*) FROM review_sheet_link_proposals) AS proposals,(SELECT count(*) FROM review_sheet_links) AS links`,
            ).pipe(Effect.provide(connection)),
          );

          expect(counts).toEqual([{ proposals: 1, links: 1 }]);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
