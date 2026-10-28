<script lang="ts">
  import { onMount } from "svelte";
  import { ReviewCommand, type Conversation, type Finding } from "#lib/review/contracts.ts";
  import type {
    ExecutionBudget,
    ExecutionSetup,
    ExecutionStatus,
    ReviewDiscipline,
  } from "#lib/review/execution.ts";
  import { sendReviewMessage } from "#lib/review/conversation.ts";
  import { newCommandId, type ReviewClient } from "#lib/review/client.ts";

  let {
    client,
    finding,
    setup,
    budget,
    conversation,
    projectVersion,
    discipline,
    status = $bindable(null),
    onProgress,
  }: {
    client: ReviewClient;
    finding: Finding;
    setup: ExecutionSetup | null;
    budget: ExecutionBudget;
    conversation: Conversation | null;
    projectVersion: number;
    discipline: typeof ReviewDiscipline.Type;
    status?: ExecutionStatus | null;
    onProgress: () => Promise<void>;
  } = $props();

  let busy = $state(false);
  let chargeAcknowledged = $state(false);
  let error = $state("");

  const active = $derived(
    status?.state === "running" || status?.state === "pausing" || status?.state === "paused",
  );

  async function start() {
    if (conversation === null) return;
    busy = true;
    error = "";

    const result = await sendReviewMessage(client, {
      command: ReviewCommand.cases.PostMessage.make({
        commandId: newCommandId(),
        projectId: finding.projectId,
        expectedVersion: projectVersion,
        conversationId: conversation.id,
        text: "Inspect the selected coordination check and propose counts with exact drawing evidence. Identify missing inputs and keep governing-code claims unverified.",
      }),
      executionCommandId: newCommandId(),
      findingId: finding.id,
      discipline,
      budget,
    });

    if (result.saved) {
      status = result.execution;
      chargeAcknowledged = false;
    }

    error = result.error ?? "";
    busy = false;
    await onProgress();
  }

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

          if (controller.signal.aborted || !result.ok || result.value.findingId !== finding.id)
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

<section class="execution" aria-label="Review execution" data-testid="execution-controls">
  {#if status}
    <div class="status-line" role="status" data-testid="execution-status">
      <span class:running={status.state === "running"} class="status-dot"></span><span
        >{status.provider === "meta" ? "Meta" : "Baseten"} · {status.state} · {status.admittedCalls} calls</span
      >
    </div>
    {#if status.state === "completed"}<p>
        Inspection finished. Review proposed counts in Findings before accepting them.
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
    {#if !active}<button
        data-testid="start-inspection"
        disabled={busy ||
          !setup?.configured ||
          ((status?.unresolvedAttempts ?? 0) > 0 && !status?.uncertaintyAcknowledged) ||
          status?.state === "uncertain"}
        onclick={start}>Inspect selected check</button
      >{/if}
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
