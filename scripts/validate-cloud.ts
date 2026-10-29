import { Effect, Schema, Stream } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BackendApi, type BackendLaunch } from "../desktop/backend.ts";
import { readModalConfiguration } from "../desktop/modal-credentials.ts";
import { readProviderConfiguration } from "../desktop/credential-files.ts";
import { CommandId, FindingId, ReviewCommand } from "#lib/review/contracts.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { ExecutionBudget } from "#lib/review/execution.ts";
import { createHeroPdf } from "../tests/fixtures/hero-case.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

const unavailable = () =>
  new CloudReviewError({
    reason: "unavailable",
    message:
      "Cloud acceptance did not finish. Inspect the retained local cloud state before dispatching another review.",
  });

const main = Effect.gen(function* () {
  if (!Bun.argv.includes("--live")) {
    console.log(
      "No resources started. Use --live for one bounded cloud review of the authored schematic.",
    );

    return;
  }

  const modal = yield* readModalConfiguration(false);
  const providerFile = Bun.env.MOKE_SESSION_CREDENTIAL_FILE;

  if (modal === undefined || providerFile === undefined)
    return yield* new CloudReviewError({
      reason: "configuration",
      message:
        "Set MOKE_MODAL_CONFIG and MOKE_SESSION_CREDENTIAL_FILE to private connection files before live acceptance.",
    });

  const inference = yield* Effect.tryPromise({
    try: () => readProviderConfiguration(providerFile, true),
    catch: unavailable,
  });

  const directory = resolve(
    ".local/cloud-validation",
    new Date().toISOString().replaceAll(":", "-"),
  );

  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: unavailable,
  });
  const source = join(directory, "original-revision-a.pdf");
  yield* Effect.tryPromise({
    try: () => writeFile(source, createHeroPdf("A")),
    catch: unavailable,
  });
  const assets = resolve("dist/backend/pdf-assets");

  const layout = yield* Effect.tryPromise({
    try: () => readFile(join(assets, "layout.json"), "utf8"),
    catch: unavailable,
  });

  const native = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ nativeFile: Schema.String })),
  )(layout);

  const launch: BackendLaunch = {
    command: [resolve("dist/backend/app-backend")],
    dataDirectory: join(directory, "data"),
    migrationDirectory: resolve("migrations"),
    modal,
    inference,
    processing: {
      workerCommand: [resolve("dist/backend/pdf-worker")],
      assetsDirectory: join(assets, "pdfjs"),
      nativeLibraryPath: join(assets, "native", native.nativeFile),
    },
  };

  const callsIndex = Bun.argv.indexOf("--calls");

  const budget = yield* Schema.decodeUnknownEffect(ExecutionBudget)({
    maxCalls: callsIndex === -1 ? 12 : Number(Bun.argv[callsIndex + 1]),
    maxInputTokens: 64000,
    maxOutputTokens: 2048,
  });

  console.log(
    JSON.stringify({
      phase: "preparing",
      directory,
      maxCalls: budget.maxCalls,
      timeoutMinutes: modal.timeoutMinutes,
    }),
  );
  const startedAt = performance.now();

  const admitted = yield* Effect.scoped(
    Effect.gen(function* () {
      const { api } = yield* BackendApi;

      const created = yield* api.ReviewCommand({
        command: ReviewCommand.cases.CreateProject.make({
          commandId: id(),
          name: "Original schematic cloud acceptance",
        }),
      });

      const projectId = created.projectId;
      let state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });
      yield* api.ImportReviewPdf({
        commandId: id(),
        projectId,
        expectedVersion: state.project?.version ?? -1,
        source,
        name: "Original schematic, Rev A",
      });
      state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });

      for (const sheet of state.sheets) {
        yield* api.ReviewCommand({
          command: ReviewCommand.cases.ConfirmSheet.make({
            commandId: id(),
            projectId,
            expectedVersion: state.project?.version ?? -1,
            sheetId: sheet.id,
            label: sheet.pageIndex === 0 ? "L-101" : "L-601",
            coverage: "partial",
          }),
        });
        state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });
      }

      const plan = state.sheets.find((sheet) => sheet.pageIndex === 0);
      const schedule = state.sheets.find((sheet) => sheet.pageIndex === 1);
      const conversation = state.conversations[0];

      if (plan === undefined || schedule === undefined || conversation === undefined)
        return yield* unavailable();

      const finding = yield* api.ReviewCommand({
        command: ReviewCommand.cases.CreateFinding.make({
          commandId: id(),
          projectId,
          expectedVersion: state.project?.version ?? -1,
          title: "Room 101 type A fixture coordination",
          objectClass:
            "Type A luminaires inside Room 101 compared with the Room 101 A schedule row",
          drawnSheetId: plan.id,
          scheduledSheetId: schedule.id,
          applicabilityConfirmed: true,
        }),
      });

      state = yield* api.ReviewSnapshot({ projectId, afterSequence: 0 });

      const posted = yield* api.ReviewCommand({
        command: ReviewCommand.cases.PostMessage.make({
          commandId: id(),
          projectId,
          expectedVersion: state.project?.version ?? -1,
          conversationId: conversation.id,
          text: "Compare the type A lighting fixture count inside Room 101 with its corresponding schedule quantity. Inspect the original drawing images and propose both counts with exact source regions. Keep governing-code claims unverified.",
        }),
      });

      const request = {
        commandId: id(),
        projectId,
        findingId: Schema.decodeUnknownSync(FindingId)(finding.entityId),
        budget,
        reviewRequest: {
          conversationId: conversation.id,
          messageId: posted.entityId,
          discipline: "electrical" as const,
        },
        transferScope: "whole-application" as const,
      };

      const status = yield* api.StartCloudReview(request);
      yield* Effect.tryPromise({
        try: () =>
          writeFile(join(directory, "admitted.json"), JSON.stringify({ status, request }, null, 2)),
        catch: unavailable,
      });
      console.log(JSON.stringify({ phase: status.phase, id: status.id }));

      const blocked = yield* api
        .ReviewCommand({
          command: ReviewCommand.cases.CreateProject.make({
            commandId: id(),
            name: "Must remain blocked",
          }),
        })
        .pipe(Effect.flip);

      if (!blocked.message.includes("cloud review owns")) return yield* unavailable();
      console.log(JSON.stringify({ phase: status.phase, id: status.id, localWritesBlocked: true }));

      return {
        status,
        projectId,
        sourceHashes: state.revisions.map((revision) => revision.sha256),
      };
    }).pipe(Effect.provide(BackendApi.layer(launch))),
  );

  // Reopening acquires a fresh local process owner; it must reconnect without dispatching again.
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const { api } = yield* BackendApi;
      let status = yield* api.CloudReviewStatus({});

      if (status?.id !== admitted.status.id) return yield* unavailable();
      console.log(JSON.stringify({ phase: "reopened", id: status.id }));
      const observedPhases: Array<string> = [];
      yield* api.ObserveCloudReview({}).pipe(
        Stream.tap((update) =>
          Effect.sync(() => {
            if (update.status !== null && observedPhases.at(-1) !== update.status.phase)
              observedPhases.push(update.status.phase);
            console.log(
              JSON.stringify({
                phase: update.status?.phase,
                state: update.status?.execution?.state,
                calls: update.status?.execution?.admittedCalls,
                syncError: update.error?.reason,
              }),
            );

            if (update.status !== null) status = update.status;
          }),
        ),
        Stream.takeUntil((update) => update.status?.phase === "imported"),
        Stream.runDrain,
        Effect.timeout("5 minutes"),
      );

      const snapshot = yield* api.ReviewSnapshot({
        projectId: admitted.projectId,
        afterSequence: 0,
      });

      const drawn = snapshot.facts
        .filter((fact) => fact.side === "drawn")
        .map((fact) => fact.value);

      const scheduled = snapshot.facts
        .filter((fact) => fact.side === "scheduled")
        .map((fact) => fact.value);

      const sourceHashes = snapshot.revisions.map((revision) => revision.sha256);
      const allProposed = snapshot.facts.every((fact) => fact.state === "proposed");
      const allowPartial = Bun.argv.includes("--allow-partial");

      if (
        JSON.stringify(sourceHashes) !== JSON.stringify(admitted.sourceHashes) ||
        !allProposed ||
        snapshot.findings.some((finding) => finding.closed || finding.taskCompleted) ||
        (!allowPartial &&
          (status.execution?.state !== "completed" ||
            drawn.at(-1) !== 2 ||
            scheduled.at(-1) !== 3 ||
            !snapshot.messages.some((message) => message.role === "application")))
      )
        return yield* unavailable();
      const conversation = snapshot.conversations[0];

      if (conversation === undefined) return yield* unavailable();
      yield* api.ReviewCommand({
        command: ReviewCommand.cases.PostMessage.make({
          commandId: id(),
          projectId: admitted.projectId,
          expectedVersion: snapshot.project?.version ?? -1,
          conversationId: conversation.id,
          text: "Cloud return complete; local editing is available again.",
        }),
      });

      return {
        cloudId: status.id,
        execution: status.execution,
        sourceHashes,
        drawn,
        scheduled,
        allProposed,
        artifactCount: snapshot.artifacts.length,
        messages: snapshot.messages.length,
        reopenedWithoutRedispatch: true,
        automaticResultReturn: true,
        progressTransport: "rpc-stream",
        observedPhases,
        localWritesBlockedDuringCloud: true,
        localWritesAvailableAfterImport: true,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }).pipe(Effect.provide(BackendApi.layer(launch))),
  );

  yield* Effect.tryPromise({
    try: () => writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2)),
    catch: unavailable,
  });
  console.log(JSON.stringify({ ...result, directory }));
});

await Effect.runPromise(main).catch((error) => {
  if (Schema.is(CloudReviewError)(error)) console.error(error.reason + ": " + error.message);
  console.error(
    "Cloud acceptance stopped. Retained data and ownership records require inspection before retrying.",
  );
  process.exitCode = 1;
});
