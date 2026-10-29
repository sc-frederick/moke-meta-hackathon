import type { ProjectId } from "./contracts.ts";
import type { ReviewClient } from "./client.ts";
import type { PacketReview } from "./packet.ts";

function backoff(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) finish();
  });
}

/** Own one cancellable subscription, reload saved progress after an end, and retry with bounded backoff. */
export async function followPacketReviews(options: {
  client: Pick<ReviewClient, "observePacketReviews" | "listPacketReviews">;
  projectId: typeof ProjectId.Type;
  signal: AbortSignal;
  onReview: (review: PacketReview) => void;
  onConnectionLost: (lost: boolean) => void;
  onError: (message: string) => void;
}) {
  const { client, projectId, signal, onReview, onConnectionLost, onError } = options;
  let failures = 0;

  while (!signal.aborted) {
    const connectedAt = Date.now();

    const result = await client.observePacketReviews(
      projectId,
      async (review) => {
        if (signal.aborted) return;
        onReview(review);
        onConnectionLost(false);

        if (Date.now() - connectedAt > 10000) failures = 0;
      },
      signal,
    );

    if (signal.aborted) return;
    failures = Date.now() - connectedAt > 10000 ? 1 : failures + 1;

    if (failures >= 3) onConnectionLost(true);

    if (!result.ok) onError(result.error.message);
    const saved = await client.listPacketReviews(projectId);

    if (signal.aborted) return;

    if (saved.ok) saved.value.forEach(onReview);
    else onError(saved.error.message);
    await backoff(signal, Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15000));
  }
}
