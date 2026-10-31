import { Schema } from "effect";
import { StartCloudPacketReview, StartCloudReview } from "#lib/review/cloud.ts";
import { cloudEngineIdentity, type CloudReviewRecord } from "../../backend/cloud/contracts.ts";

/** A selected-count cloud request with fresh identities. */
export const countRequest = () =>
  Schema.decodeUnknownSync(StartCloudReview)({
    commandId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    findingId: crypto.randomUUID(),
    transferScope: "whole-application",
    budget: { maxCalls: 2, maxInputTokens: 1000, maxOutputTokens: 256 },
  });

/** A selected-sheets drawing-set request naming `sheets` sheet identities. */
export const packetRequest = (sheets: number) =>
  Schema.decodeUnknownSync(StartCloudPacketReview)({
    kind: "packet",
    transferScope: "whole-application",
    commandId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    model: "muse-spark-1.3",
    discipline: "auto",
    selection: {
      mode: "selected_sheets",
      revisionId: crypto.randomUUID(),
      sheetIds: Array.from({ length: sheets }, () => crypto.randomUUID()),
    },
    maxCalls: null,
  });

/** A schema-valid ownership receipt as an earlier desktop saved it, with its raw request fingerprint. */
export const cloudRecord = (
  request: CloudReviewRecord["request"],
  phase: CloudReviewRecord["phase"],
  revision: number,
): CloudReviewRecord => {
  const id = crypto.randomUUID();

  return {
    id,
    workerProtocol: cloudEngineIdentity.protocol,
    revision,
    syncFailure: null,
    fingerprint: JSON.stringify(request),
    request,
    phase,
    createdAt: 1_793_232_000_000 + revision,
    expiresAt: 1_793_232_900_000 + revision,
    sandboxId: "sandbox-one",
    inputSnapshotId: "source-checkpoint",
    resultSnapshotId: phase === "imported" ? "result-checkpoint" : null,
    sandboxName: `moke-review-${id}`,
    appName: "test",
    environment: "main",
    sourceVersion: 0,
    factVersion: 0,
    projectVersion: 0,
    execution: null,
    message:
      phase === "imported"
        ? "Cloud results synced. Local editing is available; proposed evidence still needs your review."
        : "Sending your review to the cloud. Progress and results will sync automatically.",
  };
};
