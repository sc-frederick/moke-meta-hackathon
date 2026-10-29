import type { CommandId, FindingId, ReviewCommand } from "./contracts.ts";
import type { ReviewClient } from "./client.ts";
import type { ExecutionBudget, ExecutionStatus, ReviewDisciplineSelection } from "./execution.ts";
import type { ReviewModelId } from "./models.ts";
import type { CloudReviewStatus } from "./cloud.ts";

/** A reviewer send is saved once, then explicitly admitted for the selected check. */
interface ReviewMessageSubmission {
  readonly command: typeof ReviewCommand.cases.PostMessage.Type;
  readonly executionCommandId: typeof CommandId.Type;
  readonly findingId: typeof FindingId.Type;
  readonly discipline: typeof ReviewDisciplineSelection.Type;
  readonly model?: typeof ReviewModelId.Type;
  readonly budget: ExecutionBudget;
}

/** A saved request may remain a note if provider admission fails; callers must not resend it silently. */
type ReviewMessageResult =
  | { readonly saved: false; readonly error: string }
  | {
      readonly saved: true;
      readonly execution: ExecutionStatus | null;
      readonly error: string | null;
    };

/** Connect the existing conversation and execution APIs without accepting any model evidence. */
export async function sendReviewMessage(
  client: Pick<ReviewClient, "command" | "startExecution">,
  submission: ReviewMessageSubmission,
): Promise<ReviewMessageResult> {
  const saved = await client.command(submission.command);

  if (!saved.ok) return { saved: false, error: saved.error.message };

  const execution = {
    commandId: submission.executionCommandId,
    projectId: submission.command.projectId,
    findingId: submission.findingId,
    budget: submission.budget,
    reviewRequest: {
      conversationId: submission.command.conversationId,
      messageId: saved.value.entityId,
      discipline: submission.discipline,
    },
  };

  const started = await client.startExecution(
    submission.model === undefined ? execution : { ...execution, model: submission.model },
  );

  return started.ok
    ? { saved: true, execution: started.value, error: null }
    : {
        saved: true,
        execution: null,
        error: `Message saved. Review did not start: ${started.error.message}`,
      };
}

/** Save cloud review instructions once and transfer their exact message identity with the workspace. */
export async function sendCloudReviewMessage(
  client: Pick<ReviewClient, "command" | "startCloudReview">,
  submission: ReviewMessageSubmission,
): Promise<{
  readonly saved: boolean;
  readonly cloud: CloudReviewStatus | null;
  readonly error: string | null;
}> {
  const saved = await client.command(submission.command);

  if (!saved.ok) return { saved: false, cloud: null, error: saved.error.message };

  const cloudRequest = {
    commandId: submission.executionCommandId,
    projectId: submission.command.projectId,
    findingId: submission.findingId,
    budget: submission.budget,
    reviewRequest: {
      conversationId: submission.command.conversationId,
      messageId: saved.value.entityId,
      discipline: submission.discipline,
    },
    transferScope: "whole-application" as const,
  };

  const started = await client.startCloudReview(
    submission.model === undefined ? cloudRequest : { ...cloudRequest, model: submission.model },
  );

  return started.ok
    ? { saved: true, cloud: started.value, error: null }
    : {
        saved: true,
        cloud: null,
        error: `Message saved. The cloud review could not be confirmed: ${started.error.message}`,
      };
}
