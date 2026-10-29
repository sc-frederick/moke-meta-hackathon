<script lang="ts">
  import { onMount } from "svelte";
  import type { ReviewClient } from "#lib/review/client.ts";
  import { createCloudResultDelivery } from "#lib/review/cloud-delivery.ts";
  import {
    CloudReviewUpdate,
    cloudReviewLocksWorkspace,
    latestCloudReviewStatus,
    type CloudReviewSetup,
    type CloudReviewStatus,
  } from "#lib/review/cloud.ts";

  let {
    client,
    status = $bindable(null),
    setup = $bindable(null),
    loaded = $bindable(false),
    onReturned,
  }: {
    client: ReviewClient;
    status?: CloudReviewStatus | null;
    setup?: CloudReviewSetup | null;
    loaded?: boolean;
    onReturned: (action: "import" | "cancel") => Promise<boolean>;
  } = $props();

  let busy = $state(false);
  let error = $state("");
  let acknowledge = $state(false);
  const deliver = createCloudResultDelivery((action) => onReturned(action));
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const locked = $derived(status !== null && cloudReviewLocksWorkspace(status.phase));

  const partial = $derived(
    (status?.packet !== undefined && status.packet.state !== "completed") ||
      (status?.execution !== null &&
        status?.execution !== undefined &&
        status.execution.state !== "completed"),
  );

  const phaseLabels = {
    preparing: "Preparing drawings",
    dispatching: "Sending review",
    running: "In progress",
    failed: "Review stopped",
    ready: "Syncing results",
    importing: "Syncing results",
    imported: "Results synced",
    cancelled: "Stopped",
  } as const;

  async function receive(update: CloudReviewUpdate) {
    const next = update.status === null ? null : latestCloudReviewStatus(status, update.status);

    if (update.status !== null && next !== update.status) return;

    if (next !== null && (next.phase === "imported" || next.phase === "cancelled")) loaded = false;
    status = next;
    error = update.error?.message ?? "";

    const delivered = await deliver(next);

    if (destroyed || status?.id !== next?.id || status?.revision !== next?.revision) return;

    if (!delivered) {
      loaded = false;
      error = "This view could not refresh. Retrying automatically…";
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        void receive(new CloudReviewUpdate({ status: next, error: null }));
      }, 2000);

      return;
    }

    clearTimeout(viewTimer);
    loaded = true;
  }

  async function reconnect() {
    if (busy) return;
    busy = true;
    const result = await client.retryCloudSync();

    if (!result.ok) error = result.error.message;
    busy = false;
  }

  async function cancel() {
    if (status === null || busy || !acknowledge) return;
    busy = true;
    const result = await client.cancelCloudReview(status.id);

    if (result.ok) await receive(new CloudReviewUpdate({ status: result.value, error: null }));
    else error = result.error.message;
    busy = false;
  }

  onMount(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void client.cloudSetup().then((result) => {
      if (!controller.signal.aborted && result.ok) setup = result.value;
    });

    function connect() {
      void client
        .observeCloudReview(async (update) => {
          if (!controller.signal.aborted) await receive(update);
        }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          error = result.ok ? "Cloud updates disconnected. Reconnecting…" : result.error.message;
          timer = setTimeout(connect, 2000);
        });
    }

    connect();

    return () => {
      controller.abort();
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(viewTimer);
    };
  });
</script>

{#if status || error || !loaded}
  <section class="cloud-review" aria-label="Cloud review" data-testid="cloud-review-controls">
    {#if status}
      <div class="summary" role="status">
        <strong
          >Cloud review · {!loaded && status.phase === "imported"
            ? "Updating this view"
            : partial && status.phase === "ready"
              ? "Syncing partial results"
              : partial && status.phase === "imported"
                ? "Partial results synced"
                : phaseLabels[status.phase]}</strong
        >
        {#if status.execution || status.packet}<span
            >{status.packet?.admittedCalls ?? status.execution?.admittedCalls} review calls</span
          >{/if}
      </div>
      <p>{status.message}</p>
      {#if locked}
        <p>
          Local edits are paused while this workspace is in the cloud. Review time limit: {new Date(
            status.expiresAt,
          ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
        </p>
        <label
          ><input type="checkbox" bind:checked={acknowledge} /> I understand this review may have used
          credits. Cloud changes that have not synced may be lost.</label
        >
        <button disabled={busy || !acknowledge} onclick={cancel}
          >Stop cloud review and return to local work</button
        >
      {/if}
    {:else if !loaded}<p role="status">Checking for an existing cloud review…</p>{/if}
    {#if error}<p role="alert">{error}</p>
      <button disabled={busy} onclick={reconnect}>Retry sync</button>{/if}
  </section>
{/if}

<style>
  .cloud-review {
    margin: 10px 24px;
    padding: 14px 16px;
    display: grid;
    gap: 8px;
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    font-size: 12px;
    color: var(--nd-ink-muted);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  strong {
    color: var(--nd-ink);
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  button {
    width: fit-content;
    border: 1px solid var(--nd-hairline);
    background: transparent;
    border-radius: 5px;
    padding: 6px 10px;
    color: var(--nd-ink);
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.45;
  }
  label {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    line-height: 1.6;
  }
</style>
