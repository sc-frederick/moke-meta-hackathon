import type { SheetId } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import type { PacketActivityTool, PacketReview } from "#lib/review/packet.ts";

type Tool = typeof PacketActivityTool.Type;

/**
 * A conversation's part in a packet review. The coordinator keeps setup's tools until the
 * coordination stage, so steering while the sheet reviewers work cannot start the review early.
 */
export type PacketToolRole = "review" | "setup" | "sheet" | "coordination";

/** Setup reads the inventory, opens configuration sheets, researches sources and records the project. */
const setupTools: ReadonlySet<string> = new Set([
  "inventory_packet",
  "render_sheet",
  "search_sources",
  "search_code",
  "read_source",
  "record_project",
  "record_citation",
  "ask_reviewer",
  "finish_setup",
] satisfies ReadonlyArray<Tool>);

const withheld: Record<Exclude<PacketToolRole, "setup">, ReadonlySet<string>> = {
  review: new Set(["finish_setup", "finish_sheet"] satisfies ReadonlyArray<Tool>),
  // Project facts are fixed when setup ends; a sheet reviewer reports a different fact in its notes.
  sheet: new Set(["record_project", "finish_setup", "finish_review"] satisfies ReadonlyArray<Tool>),
  coordination: new Set(["finish_setup", "finish_sheet"] satisfies ReadonlyArray<Tool>),
};

/**
 * Whether a role is offered a tool and may execute it. The same answer selects each conversation's
 * wire tools and authorizes every execution, including recovery replay and steered runs. Each role
 * keeps one stable list, so its cached prompt prefix survives from request to request.
 */
export const permits = (role: PacketToolRole, tool: string) =>
  role === "setup" ? setupTools.has(tool) : !withheld[role].has(tool);

/** The role of one conversation in a review's current stage. */
export const toolRole = (
  review: Pick<PacketReview, "parallel">,
  assigned: string | undefined,
): PacketToolRole =>
  review.parallel === undefined
    ? "review"
    : assigned !== undefined
      ? "sheet"
      : review.parallel.stage === "coordination"
        ? "coordination"
        : "setup";

/** Reject a tool outside its conversation's role before it reads or changes anything. */
export const assertPermitted = (role: PacketToolRole, tool: Tool) => {
  if (permits(role, tool)) return;

  throw new ExecutionError({
    reason: "input",
    message:
      role === "setup"
        ? `Setup records the project configuration and governing sources; ${tool} belongs to a later stage. Call finish_setup when setup is recorded.`
        : `${tool} is not available to this reviewer.`,
  });
};

/**
 * A sheet reviewer writes only to its assigned sheet: renders, coverage, finding locations and
 * evidence, and segmentation. The coordinator and a single reviewer work across the set.
 */
export const assertAssignedSheet = (
  assigned: string | undefined,
  sheetIds: Iterable<string | null>,
) => {
  if (assigned === undefined) return;

  for (const sheetId of sheetIds)
    if (sheetId !== assigned)
      throw new ExecutionError({
        reason: "input",
        message:
          "You review one assigned sheet. Note references to other sheets in finish_sheet; the coordinator checks them across the set.",
      });
};

/** Setup opens a few configuration sheets and ends within a bounded number of model requests. */
export const defaultSetupLimits = { sheets: 6, requests: 20 } as const;

/** How many sheets and model requests coordinator setup may use. */
export interface SetupLimits {
  readonly sheets: number;
  readonly requests: number;
}

/**
 * Setup opens at most `limits.sheets` distinct sheets; the host records the first ones it opens.
 * After setup, coordinator steering before coordination may reopen only those sheets.
 */
export const assertSetupSheet = (
  review: Pick<PacketReview, "parallel" | "inspectedThisReviewSheetIds">,
  sheetId: typeof SheetId.Type,
  limits: SetupLimits,
) => {
  const parallel = review.parallel;

  if (parallel === undefined || parallel.stage === "coordination") return;
  const opened = parallel.setup?.sheetIds ?? review.inspectedThisReviewSheetIds ?? [];

  if (opened.includes(sheetId) || (parallel.setup === undefined && opened.length < limits.sheets))
    return;

  throw new ExecutionError({
    reason: "input",
    message: `Setup opens at most ${limits.sheets} configuration sheets, and these are open: ${opened.join(", ")}. Record what they show, list unknown project facts in finish_setup, and the sheet reviewers will inspect every sheet.`,
  });
};
