import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  CommandId,
  CommandReceipt,
  ProjectId,
  ReviewError,
  ReviewRpc,
} from "#lib/review/contracts.ts";

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Shell import hands stable command identity to the trusted desktop frame. */
export const ChooseReviewPdf = Schema.Struct({
  projectId: ProjectId,
  expectedVersion: Version,
  commandId: CommandId,
});

/** Parent implements the file dialog and backend ImportReviewPdf call. */
export class ReviewShellRpc extends RpcGroup.make(
  Rpc.make("ChooseReviewPdf", {
    payload: ChooseReviewPdf,
    success: Schema.NullOr(CommandReceipt),
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewExport", {
    payload: Schema.Struct({}),
    success: Schema.NullOr(CommandReceipt),
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewRestore", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
) {}

/** Desktop renderer RPC: application review API plus shell file capabilities. */
export class ReviewDesktopRpc extends ReviewRpc.merge(ReviewShellRpc) {}
