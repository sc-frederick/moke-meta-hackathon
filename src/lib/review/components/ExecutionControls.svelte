<script lang="ts">
  import { onMount } from "svelte";
  import type { Finding } from "#lib/review/contracts.ts";
  import type { ExecutionStatus } from "#lib/review/execution.ts";
  import { newCommandId, type ReviewClient } from "#lib/review/client.ts";

  let {
    client,
    finding,
    onProgress,
  }: { client: ReviewClient; finding: Finding; onProgress: () => Promise<void> } = $props();

  let status = $state.raw<ExecutionStatus | null>(null);
  let busy = $state(false);
  let chargeAcknowledged = $state(false);

  let error = $state("");

  let active = $derived(
    status?.state === "running" || status?.state === "pausing" || status?.state === "paused",
  );

  async function start() {
    busy = true;
    error = "";

    const result = await client.startExecution({
      commandId: newCommandId(),
      projectId: finding.projectId,
      findingId: finding.id,
      budget: { maxCalls: 12, maxInputTokens: 64000, maxOutputTokens: 4096 },
    });

    if (result.ok) {
      status = result.value;
      chargeAcknowledged = false;
    } else error = result.error.message;
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

    if (result.ok) {
      status = result.value;
    } else error = result.error.message;
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
          error = "Progress disconnected. Reopen this finding to reconnect.";
      });

    return () => controller.abort();
  });
</script>

<section class="execution" aria-label="Review execution" data-testid="execution-controls">
  <h3>Muse inspection</h3>
  <p>
    Inspect selected source images with the configured provider. Observations remain proposed until
    you accept them.
  </p>
  <p class="muted">
    Budget: 12 calls, including at most 2 SAM calls. Cost and image-token usage remain unknown.
  </p>
  {#if status}
    <p role="status" data-testid="execution-status">
      {status.route} · {status.provider} / {status.model} · {status.state} · {status.admittedCalls}/12
      calls
    </p>
    {#if status.state === "uncertain" || (status.unresolvedAttempts > 0 && status.state === "cancelled")}
      <p class="uncertain">
        An earlier request may have been billed. It will not be sent again automatically.
      </p>
      <label
        ><input type="checkbox" bind:checked={chargeAcknowledged} /> I understand the prior request may
        have been charged.</label
      >
      <button
        disabled={busy || !chargeAcknowledged || status.uncertaintyAcknowledged}
        onclick={acknowledge}>Record acknowledgement; permit a new inspection</button
      >
    {/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="controls">
    <button
      data-testid="start-inspection"
      disabled={busy ||
        active ||
        ((status?.unresolvedAttempts ?? 0) > 0 && !status?.uncertaintyAcknowledged)}
      onclick={start}>Start live inspection</button
    >
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
    padding-block: 8px 16px;
    border-bottom: 1px solid var(--nd-hairline);
    font-size: 13px;
  }
  h3 {
    font-size: 14px;
    margin: 0;
  }
  p {
    line-height: 1.5;
    margin: 8px 0;
  }
  .muted {
    color: var(--nd-ink-muted);
  }
  .uncertain {
    color: #e8a020;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    font: inherit;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    padding: 6px 10px;
    background: var(--nd-raised);
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
