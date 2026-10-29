import type { CommandId, FindingId, ReviewCommand } from "./contracts.ts";
import type { ReviewClient } from "./client.ts";
import type { ExecutionBudget, ExecutionStatus, ReviewDisciplineSelection } from "./execution.ts";
import type { ReviewModelId } from "./models.ts";

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
