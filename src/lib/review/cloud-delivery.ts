import type { CloudReviewStatus } from "./cloud.ts";
import type { ReviewClient } from "./client.ts";
import type { ExecutionStatus } from "./execution.ts";

/** Identity of the view receiving a completed cloud package. */
export interface CloudReturnSelection {
  readonly projectId: string | null;
  readonly findingId: string | null;
  readonly receipt: CloudReviewStatus | null;
}

/** Application-owned view operations used during asynchronous result hydration. */
export interface CloudReturnView {
  readonly selection: () => CloudReturnSelection;
  readonly refreshSnapshot: () => Promise<boolean>;
  readonly loadExecution: ReviewClient["executionStatus"];
  readonly applyExecution: (status: ExecutionStatus | null) => void;
  readonly reportError: (message: string) => void;
}

/** Apply returned execution controls only while their receipt and selected check remain current. */
export function createCloudReturnHydration(view: CloudReturnView) {
  return async (action: "import" | "cancel"): Promise<boolean> => {
    const selected = view.selection();
    const receipt = selected.receipt;

    if (receipt === null) return false;

    const current = () => {
      const next = view.selection();

      return (
        next.projectId === selected.projectId &&
        next.findingId === selected.findingId &&
        next.receipt?.id === receipt.id &&
        next.receipt.revision === receipt.revision
      );
    };

    const sameCheck =
      selected.projectId === receipt.projectId && selected.findingId === receipt.findingId;

    if (sameCheck) view.applyExecution(null);

    if (!(await view.refreshSnapshot()) || !current()) return false;

    if (action === "import" && sameCheck && receipt.execution !== null) {
      const result = await view.loadExecution(receipt.projectId, receipt.execution.runId);

      if (!current()) return false;

      if (!result.ok) {
        view.reportError(result.error.message);

        return false;
      }

      if (
        result.value.projectId !== receipt.projectId ||
        result.value.findingId !== receipt.findingId ||
        result.value.runId !== receipt.execution.runId
      )
        return false;
      view.applyExecution(result.value);
    }

    return current();
  };
}

/** A terminal receipt is delivered only after its local snapshot was applied successfully. */
export function createCloudResultDelivery(
  refresh: (action: "import" | "cancel") => Promise<boolean>,
) {
  let applied = "";
  let pending: { readonly receipt: string; readonly result: Promise<boolean> } | null = null;

  return (status: CloudReviewStatus | null): Promise<boolean> => {
    if (status === null || (status.phase !== "imported" && status.phase !== "cancelled"))
      return Promise.resolve(true);
    const receipt = `${status.id}:${status.phase}:${status.revision}`;

    if (applied === receipt) return Promise.resolve(true);

    if (pending?.receipt === receipt) return pending.result;

    const result = refresh(status.phase === "imported" ? "import" : "cancel")
      .then((success) => {
        if (success) applied = receipt;

        return success;
      })
      .finally(() => {
        if (pending?.receipt === receipt) pending = null;
      });

    pending = { receipt, result };

    return result;
  };
}
