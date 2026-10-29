<script lang="ts">
  import { onMount } from "svelte";
  import type { Conversation, Finding } from "#lib/review/contracts.ts";
  import type { ExecutionStatus } from "#lib/review/execution.ts";
  import type { ReviewClient } from "#lib/review/client.ts";
  import { formatElapsed } from "./review-format.ts";

  let {
    client,
    finding,
    conversation,
    hasReply = false,
    status = $bindable(null),
    onProgress,
  }: {
    client: ReviewClient;
    finding: Finding;
    conversation: Conversation | null;
    hasReply?: boolean;
    status?: ExecutionStatus | null;
    onProgress: () => Promise<void>;
  } = $props();

  let now = $state(Date.now());

  const elapsed = $derived(
    status?.startedAt == null
      ? null
      : Math.max(
          0,
          (status.state === "running" || status.state === "pausing"
            ? now
            : (status.stateChangedAt ?? now)) - status.startedAt,
        ),
  );

  $effect(() => {
    if (status?.state !== "running" && status?.state !== "pausing") return;

    const interval = setInterval(() => {
      now = Date.now();
    }, 1000);

    return () => clearInterval(interval);
  });

  let busy = $state(false);
  let chargeAcknowledged = $state(false);
  let error = $state("");

  const active = $derived(
    status?.state === "running" || status?.state === "pausing" || status?.state === "paused",
  );

  async function control(action: "pause" | "resume" | "cancel") {
    if (status === null) return;
    busy = true;
    error = "";

    const result = await client.controlExecution(
      finding.projectId,
      status.runId,
      status.version,
      action,
    );

    if (result.ok) status = result.value;
    else error = result.error.message;
    busy = false;
    await onProgress();
  }

  async function acknowledge() {
    if (status === null || !chargeAcknowledged) return;
    busy = true;
    error = "";

    const result = await client.acknowledgeExecution(
      finding.projectId,
      status.runId,
      status.version,
    );

    if (result.ok) status = result.value;
    else error = result.error.message;
    busy = false;
    await onProgress();
  }

  onMount(() => {
    const controller = new AbortController();
    const firstSequences = new Map<string, number>();
    let newestStart = 0;
    void client
      .observeExecution(
        finding.projectId,
        0,
        async (event) => {
          if (controller.signal.aborted) return;
          const firstSequence = firstSequences.get(event.runId) ?? event.sequence;
          firstSequences.set(event.runId, firstSequence);

          if (firstSequence < newestStart) return;
          const result = await client.executionStatus(finding.projectId, event.runId);

          if (
            controller.signal.aborted ||
            !result.ok ||
            result.value.findingId !== finding.id ||
            (result.value.conversationId != null &&
              result.value.conversationId !== conversation?.id)
          )
            return;
          newestStart = firstSequence;
          status = result.value;
          await onProgress();
        },
        controller.signal,
      )
      .then(() => {
        if (!controller.signal.aborted)
          error = "Progress disconnected. Select this check again to reconnect.";
      });

    return () => controller.abort();
  });
</script>

{#if status && (status.state !== "completed" || !hasReply)}
  <section class="execution" aria-label="Review execution" data-testid="execution-controls">
    {#if status}
      <div class="status-line" role="status" data-testid="execution-status">
        <span class={["status-dot", { running: status.state === "running" }]}></span><span
          >{status.state === "running"
            ? "Reviewing drawings"
            : status.state === "pausing"
              ? "Pausing review"
              : status.state === "paused"
                ? "Review paused"
                : status.state === "completed"
                  ? "Review complete"
                  : status.state === "failed"
                    ? "Review stopped"
                    : status.state}</span
        >
      </div>
      {#if elapsed !== null}<span class="elapsed" data-testid="execution-timer"
          >Elapsed {formatElapsed(elapsed)}</span
        >{/if}
      {#if status.state === "completed"}<p>
          Inspection finished. Open Findings to review the results.
        </p>{/if}
      {#if status.state === "failed"}<p>
          The inspection stopped. Check the evidence, configuration and call limit before starting
          another.
        </p>{/if}
      {#if status.state === "incompatible"}<p>
          This saved inspection uses an earlier engine or instruction version. Start a separate
          inspection to use this build.
        </p>{/if}
      {#if status.state === "uncertain" || (status.unresolvedAttempts > 0 && status.state === "cancelled")}
        <p class="uncertain">
          An earlier request may have been billed. It will not be sent again automatically.
        </p>
        <label
          ><input type="checkbox" bind:checked={chargeAcknowledged} />I understand the prior request
          may have been charged.</label
        >
        <button
          disabled={busy || !chargeAcknowledged || status.uncertaintyAcknowledged}
          onclick={acknowledge}
          >{status.uncertaintyAcknowledged
            ? "Acknowledgement recorded"
            : "Acknowledge possible charge"}</button
        >
      {/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="controls">
      {#if status?.state === "running"}<button disabled={busy} onclick={() => control("pause")}
          >Pause</button
        >{/if}
      {#if status?.state === "paused"}<button disabled={busy} onclick={() => control("resume")}
          >Resume</button
        >{/if}
      {#if active || status?.state === "uncertain"}<button
          disabled={busy}
          onclick={() => control("cancel")}>Cancel inspection</button
        >{/if}
    </div>
  </section>
{/if}

<style>
  .execution {
    font-size: 13px;
    display: grid;
    gap: 8px;
    padding: 10px 0;
    color: var(--nd-ink-muted);
  }
  p {
    line-height: 1.6;
    margin: 0;
  }
  .elapsed {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .status-line {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--nd-ink);
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--nd-ink-muted);
  }
  .status-dot.running {
    background: var(--nd-ink);
    animation: pulse 1.6s ease-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-dot.running {
      animation: none;
    }
  }
  .uncertain {
    color: var(--nd-warning);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  label {
    display: flex;
    align-items: start;
    gap: 8px;
  }
  button {
    font: inherit;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    padding: 6px 10px;
    background: var(--nd-panel);
    color: var(--nd-ink);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
