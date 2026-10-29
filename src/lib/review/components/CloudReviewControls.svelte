<script lang="ts">
  import { onMount } from "svelte";
  import type { ReviewClient } from "#lib/review/client.ts";
  import { createCloudResultDelivery } from "#lib/review/cloud-delivery.ts";
  import { packetActivityStageLabels } from "#lib/review/packet.ts";
  import { reviewModels } from "#lib/review/models.ts";
  import {
    CloudReviewUpdate,
    cloudReviewLocksWorkspace,
    latestCloudReviewStatus,
    type CloudReviewSetup,
    type CloudReviewStatus,
  } from "#lib/review/cloud.ts";

  let {
    client,
    projectId = null,
    conversationId = null,
    projectName = "",
    projects = [],
    status = $bindable(null),
    setup = $bindable(null),
    loaded = $bindable(false),
    onReturned,
  }: {
    client: ReviewClient;
    projectId?: string | null;
    conversationId?: string | null;
    projectName?: string;
    projects?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    status?: CloudReviewStatus | null;
    setup?: CloudReviewSetup | null;
    loaded?: boolean;
    onReturned: (action: "import" | "cancel") => Promise<boolean>;
  } = $props();

  let busy = $state(false);
  let error = $state("");
  let acknowledge = $state(false);

  // Only the latest receipt is shown, so remembering its dismissal survives a restart.
  const dismissedKey = "moke.cloudReview.dismissed";
  let dismissedId = $state<string | null>(globalThis.localStorage?.getItem(dismissedKey) ?? null);
  let showReceiptDetails = $state(false);
  let now = $state(Date.now());
  const deliver = createCloudResultDelivery((action) => onReturned(action));
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const visible = $derived(
    status !== null &&
      (cloudReviewLocksWorkspace(status.phase) ||
        (status.projectId === projectId &&
          (status.conversationId === undefined || status.conversationId === conversationId))) &&
      status.id !== dismissedId,
  );

  // Upload runs before packet progress exists, so name the job's project from the local list.
  const targetName = $derived(
    (status?.packet?.projectName ??
      (status?.projectId === projectId
        ? projectName
        : projects.find((item) => item.id === status?.projectId)?.name)) ||
      "Project",
  );

  const context = $derived(
    [
      targetName,
      reviewModels.find((model) => model.id === status?.model)?.label ?? status?.model,
      status?.scopeLabel?.replaceAll("_", " "),
    ]
      .filter(Boolean)
      .join(" · "),
  );

  const calls = $derived(status?.packet?.admittedCalls ?? status?.execution?.admittedCalls ?? 0);

  const duration = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const locked = $derived(status !== null && cloudReviewLocksWorkspace(status.phase));

  const partial = $derived(
    (status?.packet !== undefined && status.packet.state !== "completed") ||
      (status?.execution !== null &&
        status?.execution !== undefined &&
        status.execution.state !== "completed"),
  );

  const phaseLabels = {
    preparing: "Preparing cloud workspace",
    dispatching: "Sending review",
    running: "In progress",
    failed: "Review stopped",
    ready: "Syncing results",
    importing: "Syncing results",
    imported: "Results synced",
    cancelled: "Stopped",
  } as const;

  const stageLabels = {
    reviewing: "Reviewing drawings",
    "preparing-results": "Saving result package",
    "results-ready": "Result package ready",
  } as const;

  const stage = $derived.by(() => {
    if (status === null) return "";

    if (status.syncFailure !== null) return "Sync paused";

    if (
      status.transfer !== undefined &&
      status.transfer.completedFiles < status.transfer.totalFiles
    )
      return status.transfer.direction === "upload"
        ? "Uploading workspace files"
        : "Downloading result files";

    if (status.phase === "importing") return "Verifying and importing results";

    if (status.phase === "ready") return "Preparing result sync";

    if (status.packet?.stage === "preparing-results") return stageLabels[status.packet.stage];

    if (status.packet !== undefined && status.packet.state !== "running")
      return `Review ${status.packet.state}`;

    if (status.packet?.activity?.status === "active")
      return packetActivityStageLabels[status.packet.activity.stage];

    if (status.packet?.stage !== undefined) return stageLabels[status.packet.stage];

    return phaseLabels[status.phase];
  });

  const activity = $derived(
    status?.phase === "running" &&
      status.packet?.state === "running" &&
      status.packet.stage !== "preparing-results"
      ? (status.packet.activity ?? null)
      : null,
  );

  async function receive(update: CloudReviewUpdate) {
    const next = update.status === null ? null : latestCloudReviewStatus(status, update.status);

    if (update.status !== null && next !== update.status) return;

    if (next !== null && (next.phase === "imported" || next.phase === "cancelled")) loaded = false;

    if (next?.id !== status?.id) {
      acknowledge = false;
      showReceiptDetails = false;
    }

    status = next;
    error =
      next !== null && cloudReviewLocksWorkspace(next.phase) ? (update.error?.message ?? "") : "";

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

    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);

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
          error =
            status !== null && cloudReviewLocksWorkspace(status.phase)
              ? result.ok
                ? "Cloud updates disconnected. Reconnecting…"
                : result.error.message
              : "";
          timer = setTimeout(connect, 2000);
        });
    }

    connect();

    return () => {
      controller.abort();
      clearInterval(clock);
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(viewTimer);
    };
  });
</script>

{#if visible || error || !loaded}
  <section class="cloud-review" aria-label="Cloud review" data-testid="cloud-review-controls">
    {#if status && visible}
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
            >{calls} review {calls === 1 ? "call" : "calls"}</span
          >{/if}
        {#if !locked}<button
            class="dismiss"
            onclick={() => {
              if (status === null) return;
              dismissedId = status.id;
              globalThis.localStorage?.setItem(dismissedKey, status.id);
            }}>Dismiss</button
          >{/if}
      </div>
      <p class="context">{context}</p>
      {#if !locked}
        <button
          aria-expanded={showReceiptDetails}
          onclick={() => {
            showReceiptDetails = !showReceiptDetails;
          }}
        >
          {showReceiptDetails ? "Hide" : "Show"} transfer and review details
        </button>
      {/if}
      {#if locked || showReceiptDetails}
        <div class="receipt-details">
          {#if !locked || status.phase === "failed"}<p>{status.message}</p>{/if}
          {#if status.transfer !== undefined && (!locked || status.transfer.completedFiles < status.transfer.totalFiles)}
            <div class="transfer" data-testid="cloud-transfer-progress">
              <p>
                {status.transfer.direction === "upload" ? "Upload" : "Download"}:
                {(status.transfer.completedBytes / 1024 / 1024).toFixed(1)} / {(
                  status.transfer.totalBytes /
                  1024 /
                  1024
                ).toFixed(1)} MiB · {status.transfer.completedFiles} / {status.transfer.totalFiles} files
                complete
              </p>
              <progress
                aria-label={`${status.transfer.direction === "upload" ? "Upload" : "Download"} completed bytes`}
                value={status.transfer.completedBytes}
                max={Math.max(1, status.transfer.totalBytes)}
              ></progress>
            </div>
          {:else if status.transferBytes !== undefined && locked}
            <p>
              Prepared workspace package: {(status.transferBytes / 1024 / 1024).toFixed(1)} MiB.
            </p>
          {/if}
          {#if locked}
            <p>Stage: {stage}.</p>
          {/if}
          {#if locked && activity !== null}
            <p data-testid="cloud-tool-activity">
              {activity.status === "active" ? "Current tool" : "Last tool"}: {activity.tool.replaceAll(
                "_",
                " ",
              )}
              {#if activity.sheetLabel}
                · {activity.sheetLabel}{/if}
              {#if activity.status === "finished"}
                · finished{/if}
            </p>
          {/if}
          {#if status.packet?.lastOpenedDrawing !== undefined && locked}
            <p>Last recorded drawing opened: {status.packet.lastOpenedDrawing}.</p>
          {/if}
          {#if status.packet?.totalSheets !== undefined}
            <p>
              {status.packet.openedSheets ?? 0}/{status.packet.totalSheets} sheets opened · {status
                .packet.findings ?? 0} findings · {status.packet.recordedPasses ?? 0}/{status.packet
                .totalPasses ?? 0} passes recorded
            </p>
          {/if}
          {#if status.packet?.changedAt !== undefined && locked}
            <p>Last review activity {duration(now - status.packet.changedAt)} ago.</p>
          {/if}
          {#if locked}
            <p>
              Elapsed {duration(now - status.createdAt)} · Remaining {duration(
                status.expiresAt - now,
              )}. Local edits are paused. Ends by {new Date(status.expiresAt).toLocaleTimeString(
                [],
                {
                  hour: "numeric",
                  minute: "2-digit",
                },
              )}.
            </p>
            <label
              ><input type="checkbox" bind:checked={acknowledge} /> I understand this review may have
              used credits. Cloud changes that have not synced may be lost.</label
            >
            <button disabled={busy || !acknowledge} onclick={cancel}
              >Stop cloud review and return to local work</button
            >
          {/if}
        </div>
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
  .dismiss {
    margin-left: auto;
  }
  .context {
    color: var(--nd-ink);
  }
  strong {
    color: var(--nd-ink);
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  .transfer {
    display: grid;
    gap: 4px;
  }
  /* Keep the composer reachable in compact windows; long details scroll inside the card. */
  .receipt-details {
    display: grid;
    gap: 8px;
    max-height: 28vh;
    overflow-y: auto;
  }
  progress {
    width: min(100%, 420px);
    height: 7px;
    accent-color: var(--nd-ink);
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
