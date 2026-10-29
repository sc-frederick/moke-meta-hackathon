import { Effect } from "effect";
import { CommandReceipt, ReviewStorageError } from "../src/lib/review/contracts.ts";
import type { ReviewClient } from "../src/lib/review/client.ts";

type ImportRequest = Parameters<ReviewClient["chooseReviewPdf"]>[0];

type Drop = {
  source: string;
  expires: number;
  claim?: { identity: string; receipt?: CommandReceipt };
};

/** Session-local PDF capabilities. A claim binds the complete command before backend work starts. */
export function createDropImports() {
  const drops = new Map<string, Drop>();

  return {
    stage(source: string) {
      for (const [token, drop] of drops)
        if (drop.expires < Date.now() && !drop.claim) drops.delete(token);

      // Never evict a claimed command's retry knowledge during this desktop session.
      if (drops.size >= 64) return null;
      const token = crypto.randomUUID();
      drops.set(token, { source, expires: Date.now() + 300000 });

      return token;
    },
    claim(request: ImportRequest, token: string) {
      return Effect.suspend(() => {
        const drop = drops.get(token);
        const identity = JSON.stringify(request);

        if (!drop || (!drop.claim && drop.expires < Date.now()))
          return Effect.fail(
            new ReviewStorageError({
              message: "This dropped file expired. Drop the PDF again.",
            }),
          );

        if (drop.claim && drop.claim.identity !== identity)
          return Effect.fail(
            new ReviewStorageError({
              message:
                "This dropped file belongs to another import request. Retry that request or drop the PDF again.",
            }),
          );

        drop.claim ??= { identity };

        return Effect.succeed({
          source: drop.source,
          receipt: drop.claim.receipt,
          complete(receipt: CommandReceipt) {
            drop.claim = { identity, receipt };
          },
        });
      });
    },
  };
}
