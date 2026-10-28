import { Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/sql";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BackendApi } from "../desktop/backend.ts";
import { InferenceConfiguration } from "#lib/backend-rpc.ts";
import { CommandId, FindingId, ReviewCommand } from "#lib/review/contracts.ts";
import { ResponseReceipt } from "../backend/inference/response.ts";
import { createHeroPdf } from "../tests/fixtures/hero-case.ts";

const live = Bun.argv.includes("--live");
const provider = Bun.argv.includes("--baseten") ? "baseten" : "meta";

const directory = resolve(
  ".local/core-validation",
  `${new Date().toISOString().replaceAll(":", "-")}-${provider}`,
);

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

const program = Effect.gen(function* () {
  if (!live) {
    console.log(
      "No requests sent. Use --live for an explicit, bounded compiled-backend image/tool validation.",
    );

    return;
  }

  const inference = yield* Schema.decodeUnknownEffect(InferenceConfiguration)({
    provider,
    apiKey: provider === "meta" ? Bun.env.MODEL_API_KEY : Bun.env.BASETEN_API_KEY,
    baseUrl: provider === "meta" ? "https://api.meta.ai/v1" : "https://inference.baseten.co/v1",
    model: provider === "meta" ? "muse-spark-1.3" : "meta-models/muse-spark-open-1026",
  });

  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  const source = join(directory, "original-revision-a.pdf");
  yield* Effect.promise(() => writeFile(source, createHeroPdf("A")));
  const assets = resolve("dist/backend/pdf-assets");
  const layout = yield* Effect.promise(() => readFile(join(assets, "layout.json"), "utf8"));

  const native = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ nativeFile: Schema.String })),
  )(layout);

  const started = performance.now();

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const { api } = yield* BackendApi;

      const created = yield* api.ReviewCommand({
        command: ReviewCommand.cases.CreateProject.make({
          commandId: id(),
          name: "Original fixture live validation",
        }),
      });

      const projectId = created.projectId;
      let state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });
      const version = () => state.project?.version ?? -1;
      yield* api.ImportReviewPdf({
        commandId: id(),
        projectId,
        expectedVersion: version(),
        source,
        name: "Original Moke schematic, Rev A",
      });
      state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });

      for (const sheet of state.sheets) {
        yield* api.ReviewCommand({
          command: ReviewCommand.cases.ConfirmSheet.make({
            commandId: id(),
            projectId,
            expectedVersion: version(),
            sheetId: sheet.id,
            label: sheet.pageIndex === 0 ? "L-101" : "L-601",
            coverage: "partial",
          }),
        });
        state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });
      }

      const plan = state.sheets.find((sheet) => sheet.pageIndex === 0);
      const schedule = state.sheets.find((sheet) => sheet.pageIndex === 1);

      if (plan === undefined || schedule === undefined)
        return yield* Effect.die("Missing generated source");

      const check = yield* api.ReviewCommand({
        command: ReviewCommand.cases.CreateFinding.make({
          commandId: id(),
          projectId,
          expectedVersion: version(),
          title: "Room 101 type A fixture coordination",
          objectClass:
            "Type A luminaires within Room 101, compared with the corresponding schedule row",
          drawnSheetId: plan.id,
          scheduledSheetId: schedule.id,
          applicabilityConfirmed: true,
        }),
      });

      const findingId = Schema.decodeUnknownSync(FindingId)(check.entityId);

      let status = yield* api.StartExecution({
        commandId: id(),
        projectId,
        findingId,
        budget: { maxCalls: 12, maxInputTokens: 64000, maxOutputTokens: 4096 },
      });

      console.log(
        JSON.stringify({
          provider,
          model: status.model,
          state: status.state,
          budget:
            "12 calls; 64,000 conservative text tokens and 4,096 output tokens per call; image tokens and cost unknown",
        }),
      );

      while (status.state === "running" || status.state === "pausing") {
        if (performance.now() - started > 240000) {
          status = yield* api.ControlExecution({
            commandId: id(),
            projectId,
            runId: status.runId,
            expectedVersion: status.version,
            action: "cancel",
          });
          break;
        }

        yield* Effect.sleep("1 second");
        const next = yield* api.ExecutionStatus({ projectId, runId: status.runId });

        if (next.admittedCalls !== status.admittedCalls || next.state !== status.state)
          console.log(
            JSON.stringify({
              state: next.state,
              admittedCalls: next.admittedCalls,
              unresolvedAttempts: next.unresolvedAttempts,
            }),
          );
        status = next;
      }

      state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });

      return {
        status,
        sourceHashes: state.revisions.map((revision) => revision.sha256),
        proposals: state.facts,
        artifacts: state.artifacts,
        events: state.events,
        elapsedMs: Math.round(performance.now() - started),
      };
    }).pipe(
      Effect.provide(
        BackendApi.layer({
          command: [
            resolve(
              process.platform === "win32"
                ? "dist/backend/app-backend.exe"
                : "dist/backend/app-backend",
            ),
          ],
          dataDirectory: join(directory, "data"),
          migrationDirectory: resolve("migrations"),
          inference,
          processing: {
            workerCommand: [
              resolve(
                process.platform === "win32"
                  ? "dist/backend/pdf-worker.exe"
                  : "dist/backend/pdf-worker",
              ),
            ],
            assetsDirectory: join(assets, "pdfjs"),
            nativeLibraryPath: join(assets, "native", native.nativeFile),
          },
        }),
      ),
    ),
  );

  const receipts = yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows =
        yield* sql`SELECT response_json FROM review_execution_attempts WHERE status='completed' ORDER BY task_id`;

      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ response_json: Schema.String })),
      )(rows);

      return yield* Effect.forEach(parsed, (row) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(ResponseReceipt))(row.response_json),
      );
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: join(directory, "data/app.sqlite"), readonly: true }),
      ),
    ),
  );

  const calls = receipts.flatMap((receipt) =>
    receipt.content.flatMap((part) =>
      part.type === "toolCall" ? [{ name: part.name, id: part.id }] : [],
    ),
  );

  const evidence = {
    ...result,
    receipts: receipts.map((receipt) => ({
      responseId: receipt.responseId ?? null,
      provider: receipt.provider,
      model: receipt.model,
      usage: {
        input: receipt.usage.input,
        output: receipt.usage.output,
        totalTokens: receipt.usage.totalTokens,
      },
      stopReason: receipt.stopReason,
    })),
    tools: calls,
  };

  yield* Effect.promise(() =>
    writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2)),
  );
  console.log(
    JSON.stringify({
      state: result.status.state,
      calls: result.status.admittedCalls,
      proposedCounts: result.proposals.map((fact) => ({
        side: fact.side,
        value: fact.value,
        state: fact.state,
      })),
      tools: calls.map((call) => call.name),
      elapsedMs: result.elapsedMs,
      evidence: join(directory, "evidence.json"),
    }),
  );
  const hasCrop = calls.some((call) => call.name === "render_missing_detail");

  if (result.status.state !== "completed" || !hasCrop || result.proposals.length < 2)
    process.exitCode = 1;
});

await Effect.runPromise(program).catch(() => {
  console.error(
    "Core live validation stopped. No automatic retry was sent; inspect the preserved local ledger.",
  );
  process.exitCode = 1;
});
