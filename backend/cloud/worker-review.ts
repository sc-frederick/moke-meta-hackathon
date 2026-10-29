import { Effect, Stream } from "effect";
import type { Application } from "../application.ts";
import type { CloudReviewRequest, CloudReviewError } from "#lib/review/cloud.ts";
import type { CloudWorkerProgress } from "./contracts.ts";
import { packetCoverageProgress } from "#lib/review/packet-coverage.ts";
import { cloudPackageLimits } from "./transfer.ts";

type Progress = Omit<typeof CloudWorkerProgress.Type, "id" | "identity">;

/** Run one admitted request, drain its tools, and export before advertising results. */
export const runCloudReview = Effect.fn("CloudWorker.runReview")(function* (
  application: Pick<Application["Service"], "execution" | "packets" | "exportPackage">,
  request: typeof CloudReviewRequest.Type,
  timeoutMs: number,
  destination: string,
  publish: (progress: Progress) => Effect.Effect<void, CloudReviewError>,
) {
  if ("kind" in request) {
    const started = yield* application.packets.start(request);

    const packetProgress = (
      review: typeof started,
      stage: "reviewing" | "preparing-results" | "results-ready",
    ) => {
      const lastOpenedId = review.inspectedSheetIds.at(-1);
      const lastOpened = review.sheets.find((sheet) => sheet.id === lastOpenedId);

      const packet = {
        id: review.id,
        projectId: review.projectId,
        conversationId: review.conversationId,
        model: review.model,
        state: review.state,
        version: review.version,
        admittedCalls: review.admittedCalls,
        projectName: review.projectName,
        openedSheets: review.inspectedSheetIds.length,
        totalSheets: review.sheets.length,
        findings: review.findings.length,
        recordedPasses: packetCoverageProgress(review).recorded,
        totalPasses: packetCoverageProgress(review).total,
        changedAt: review.changedAt,
        stage,
        activity: review.state === "running" ? (review.activity ?? null) : null,
      };

      return lastOpened === undefined
        ? packet
        : {
            ...packet,
            lastOpenedDrawing: `${lastOpened.label || `Page ${lastOpened.pageIndex + 1}`} · ${lastOpened.documentName}`,
          };
    };

    const progress = (
      review: typeof started,
      stage: "reviewing" | "preparing-results" = "reviewing",
    ) =>
      publish({
        phase: "running",
        execution: null,
        packet: packetProgress(review, stage),
        message:
          stage === "preparing-results"
            ? "Saving the result package before download."
            : `Cloud review ${review.state}; ${review.admittedCalls} review calls admitted.`,
      });

    yield* progress(started);
    yield* application.packets.observe(request.projectId).pipe(
      Stream.filter((review) => review.id === started.id),
      Stream.takeUntil((review) => review.state !== "running"),
      Stream.runForEach(progress),
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () => application.packets.quiesce),
    );
    yield* progress(
      yield* application.packets.get(request.projectId, started.id),
      "preparing-results",
    );
    yield* application.exportPackage(destination, cloudPackageLimits);
    const finished = yield* application.packets.get(request.projectId, started.id);
    yield* publish({
      phase: "ready",
      execution: null,
      packet: packetProgress(finished, "results-ready"),
      message:
        finished.state === "completed"
          ? "The cloud review finished. Findings and sources will sync automatically."
          : "The cloud review stopped before finishing. Partial findings and sources will sync automatically.",
    });

    return;
  }

  const started = yield* application.execution.start(request);
  yield* publish({
    phase: "running",
    execution: started,
    message: "Review running in the cloud. You can close the desktop and reconnect later.",
  });

  const terminal = new Set([
    "completed",
    "cancelled",
    "failed",
    "uncertain",
    "incompatible",
    "paused",
  ]);

  yield* application.execution.observe(request.projectId, 0).pipe(
    Stream.filter((event) => event.runId === started.runId),
    Stream.takeUntil((event) => terminal.has(event.state)),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const status = yield* application.execution.status(request.projectId, started.runId);
        yield* publish({
          phase: "running",
          execution: status,
          message: `Cloud inspection ${status.state}; ${status.admittedCalls} review calls admitted.`,
        });
      }),
    ),
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", () => application.execution.quiesce),
  );
  yield* publish({
    phase: "running",
    execution: yield* application.execution.status(request.projectId, started.runId),
    message: "Saving the result package before download.",
  });
  yield* application.exportPackage(destination, cloudPackageLimits);
  const finished = yield* application.execution.status(request.projectId, started.runId);
  yield* publish({
    phase: "ready",
    execution: finished,
    message:
      finished.state === "completed"
        ? "The cloud review finished. Results will sync automatically; proposed evidence still needs your review."
        : "The cloud review stopped before finishing. Partial results will sync automatically; proposed evidence still needs your review.",
  });
});
