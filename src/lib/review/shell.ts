import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { PacketReviewRpc } from "./packet.ts";
import { ExecutionRpc } from "./execution.ts";
import { CloudReviewRpc } from "./cloud.ts";
import { CommandId, CommandReceipt, ProjectId, ReviewError, ReviewRpc } from "./contracts.ts";

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Shell import hands stable command identity to the trusted desktop frame. */
const ChooseReviewPdf = Schema.Struct({
  projectId: ProjectId,
  expectedVersion: Version,
  commandId: CommandId,
});

/** Parent implements the file dialog and backend ImportReviewPdf call. */
export class ReviewShellRpc extends RpcGroup.make(
  Rpc.make("ChoosePacketReport", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Schema.String.check(Schema.isUUID()),
    }),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewPdf", {
    payload: ChooseReviewPdf,
    success: Schema.NullOr(CommandReceipt),
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewExport", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewRestore", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
) {}

/** Desktop renderer RPC: application review API plus shell file capabilities. */
export class ReviewDesktopRpc extends ReviewRpc.merge(ReviewShellRpc)
  .merge(ExecutionRpc)
  .merge(PacketReviewRpc)
  .merge(CloudReviewRpc) {}
