import { Effect, Predicate, Stream } from "effect";
import type { Application } from "../application.ts";
import {
  cloudFindingPreviewLimits,
  type CloudFindingPreview,
  type CloudReviewRequest,
  type CloudReviewError,
  type CloudSheetReviewProgress,
} from "#lib/review/cloud.ts";
import type { PacketFinding, PacketParallelReview, PacketSheetReview } from "#lib/review/packet.ts";
import type { CloudWorkerProgress } from "./contracts.ts";
import { packetCoverageProgress } from "#lib/review/packet-coverage.ts";
import { cloudPackageLimits } from "./transfer.ts";

type Progress = Omit<typeof CloudWorkerProgress.Type, "id" | "identity">;

/** Shorten to `limit` UTF-16 units without splitting a surrogate pair. */
const clip = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);

  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

/**
 * Newest findings for live progress, without observations, corrections or evidence. Findings
 * are upserted at the end of the list, so its tail holds the latest changes. Older entries are
 * dropped until the preview fits its byte bound.
 */
export const cloudFindingPreview = (review: {
  readonly sheets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly pageIndex: number;
  }>;
  readonly findings: ReadonlyArray<
    Pick<typeof PacketFinding.Type, "id" | "title" | "severity" | "discipline"> & {
      readonly locations: ReadonlyArray<{ readonly sheetId: string }>;
    }
  >;
}): Array<typeof CloudFindingPreview.Type> => {
  const labels = new Map(
    review.sheets.map((sheet) => [sheet.id, sheet.label || `Page ${sheet.pageIndex + 1}`]),
  );

  const preview = review.findings.slice(-cloudFindingPreviewLimits.findings).map((finding) => ({
    id: finding.id,
    title: clip(finding.title, cloudFindingPreviewLimits.title),
    severity: finding.severity,
    discipline: finding.discipline,
    sheets: [...new Set(finding.locations.map((location) => labels.get(location.sheetId) ?? ""))]
      .filter((label) => label !== "")
      .slice(0, cloudFindingPreviewLimits.sheets)
      .map((label) => clip(label, cloudFindingPreviewLimits.sheetLabel)),
  }));

  while (
    preview.length > 0 &&
    Buffer.byteLength(JSON.stringify(preview)) > cloudFindingPreviewLimits.bytes
  )
    preview.shift();

  return preview;
};

/** Count parallel sheet reviewers by state; reviews run as one conversation have none. */
export const cloudSheetReviewProgress = (review: {
  readonly parallel?: {
    readonly stage: (typeof PacketParallelReview.Type)["stage"];
    readonly sheets: ReadonlyArray<{ readonly state: (typeof PacketSheetReview.Type)["state"] }>;
  };
}): typeof CloudSheetReviewProgress.Type | undefined => {
  if (review.parallel === undefined) return undefined;
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };

  for (const sheet of review.parallel.sheets) counts[sheet.state]++;

  return { stage: review.parallel.stage, ...counts };
};

/** Each progress write wakes the desktop's watcher, so busy parallel reviews write once a second. */
const progressInterval = "1 second";

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
        findingPreview: cloudFindingPreview(review),
      };

      const sheetReviews = cloudSheetReviewProgress(review);
      const staged = sheetReviews === undefined ? packet : { ...packet, sheetReviews };

      return lastOpened === undefined
        ? staged
        : {
            ...staged,
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
      // Publish only the latest review of each interval; the final one is never dropped.
      Stream.groupedWithin(10_000, progressInterval),
      Stream.map((reviews) => reviews.at(-1)),
      Stream.filter(Predicate.isNotUndefined),
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
