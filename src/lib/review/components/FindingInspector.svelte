<script lang="ts">
  import { untrack } from "svelte";
  import type { CheckRun, CountFact, Finding, Region, Sheet } from "#lib/review/contracts.ts";
  import ReviewIcon from "./ReviewIcon.svelte";
  import { checksForFinding, formatOutcome, latestAcceptedFact } from "./review-format.ts";

  let {
    finding,
    sheets,
    facts,
    checks,
    busy = false,
    onAccept,
    onEvaluate,
    onCorrect,
    onStatus,
    onRequestDetail,
  }: {
    finding: Finding;
    sheets: ReadonlyArray<Sheet>;
    facts: ReadonlyArray<CountFact>;
    checks: ReadonlyArray<CheckRun>;
    busy?: boolean;
    onAccept: (
      side: "drawn" | "scheduled",
      payload: {
        value: number;
        statement: string;
        rationale: string;
        coverageConfirmed: boolean;
        region: Region;
      },
    ) => void;
    onEvaluate: () => void;
    onCorrect: (side: "drawn" | "scheduled") => void;
    onStatus: (closed: boolean, taskCompleted: boolean) => void;
    onRequestDetail: (side: "drawn" | "scheduled", region: Region) => void;
  } = $props();

  const history = $derived(checksForFinding(checks, finding.id));
  const drawnSheet = $derived(sheets.find((sheet) => sheet.id === finding.drawnSheetId));
  const scheduledSheet = $derived(sheets.find((sheet) => sheet.id === finding.scheduledSheetId));
  const drawnFact = $derived(latestAcceptedFact(facts, finding.id, "drawn"));
  const scheduledFact = $derived(latestAcceptedFact(facts, finding.id, "scheduled"));

  let drawnValue = $state(0);
  let scheduledValue = $state(0);
  let drawnStatement = $state("");
  let scheduledStatement = $state("");
  let drawnRationale = $state("");
  let scheduledRationale = $state("");
  let drawnCoverage = $state(false);
  let scheduledCoverage = $state(false);

  let drawnRegion = $state({ x: 0, y: 0, width: 100, height: 100 });
  let scheduledRegion = $state({ x: 0, y: 0, width: 100, height: 100 });
  const drawnIdentity = $derived(`${finding.drawnSheetId}:${drawnFact?.id ?? ""}`);
  const scheduledIdentity = $derived(`${finding.scheduledSheetId}:${scheduledFact?.id ?? ""}`);

  const proposals = $derived(
    facts.filter((fact) => fact.findingId === finding.id && fact.state === "proposed"),
  );

  $effect(() => {
    const identity = drawnIdentity;
    untrack(() => {
      const fact = facts.find((entry) => `${finding.drawnSheetId}:${entry.id}` === identity);
      drawnValue = fact?.value ?? 0;
      drawnStatement = fact?.evidence.statement ?? "";
      drawnRationale = fact?.rationale ?? "";
      drawnCoverage = fact?.evidence.sheetId === finding.drawnSheetId && fact.coverageConfirmed;
      drawnRegion = { ...(fact?.evidence.region ?? defaultRegion(drawnSheet)) };
    });
  });

  $effect(() => {
    const identity = scheduledIdentity;
    untrack(() => {
      const fact = facts.find((entry) => `${finding.scheduledSheetId}:${entry.id}` === identity);
      scheduledValue = fact?.value ?? 0;
      scheduledStatement = fact?.evidence.statement ?? "";
      scheduledRationale = fact?.rationale ?? "";
      scheduledCoverage =
        fact?.evidence.sheetId === finding.scheduledSheetId && fact.coverageConfirmed;
      scheduledRegion = { ...(fact?.evidence.region ?? defaultRegion(scheduledSheet)) };
    });
  });

  function defaultRegion(sheet: Sheet | undefined): Region {
    if (sheet === undefined) return { x: 0, y: 0, width: 100, height: 100 };

    return { x: sheet.box.x, y: sheet.box.y, width: sheet.box.width, height: sheet.box.height };
  }
</script>

<div class="inspector" data-testid="finding-inspector">
  <header>
    <h2>{finding.title}</h2>
    <p class="meta">{finding.objectClass} · {formatOutcome(finding.outcome)}</p>
  </header>

  {#if proposals.length > 0}
    <section aria-label="Proposed observations">
      <h3>Model proposals · awaiting acceptance</h3>
      {#each proposals as proposal (proposal.id)}
        <p>{proposal.side}: {proposal.value} · {proposal.evidence.statement}</p>
        {#if proposal.origin}<p class="meta">
            {proposal.origin.route} · {proposal.origin.provider} / {proposal.origin.model} · response
            {proposal.origin.responseId ?? "ID unavailable"}
          </p>{/if}
        <button
          disabled={busy}
          onclick={() => {
            if (proposal.side === "drawn") {
              drawnValue = proposal.value;
              drawnStatement = proposal.evidence.statement;
              drawnRationale = proposal.rationale;
              drawnRegion = { ...proposal.evidence.region };
              drawnCoverage = false;
            } else {
              scheduledValue = proposal.value;
              scheduledStatement = proposal.evidence.statement;
              scheduledRationale = proposal.rationale;
              scheduledRegion = { ...proposal.evidence.region };
              scheduledCoverage = false;
            }
          }}>Use proposal as draft</button
        >
      {/each}
    </section>
  {/if}
  <section class="operand" aria-label="drawn operand">
    <h3>Drawn count</h3>
    <p class="sheet-line">{drawnSheet ? drawnSheet.label : "Missing sheet"}</p>
    {#if drawnFact && drawnFact.evidence.sheetId !== finding.drawnSheetId}<p class="warn">
        Accepted input cites an earlier revision. Inspect and accept fresh evidence.
      </p>{/if}
    {#if drawnSheet && !drawnSheet.confirmed}
      <p class="warn" role="status">Confirm this sheet before accepting evidence.</p>
    {/if}
    <label
      >Count<input
        disabled={busy}
        type="number"
        min="0"
        bind:value={drawnValue}
        data-testid="drawn-count-input"
      /></label
    >
    <fieldset class="region-fields">
      <legend>Source region in PDF points</legend>
      <label
        >X<input
          type="number"
          disabled={busy}
          bind:value={drawnRegion.x}
          data-testid="drawn-region-x"
        /></label
      >
      <label
        >Y<input
          type="number"
          disabled={busy}
          bind:value={drawnRegion.y}
          data-testid="drawn-region-y"
        /></label
      >
      <label
        >Width<input
          type="number"
          disabled={busy}
          bind:value={drawnRegion.width}
          data-testid="drawn-region-width"
        /></label
      >
      <label
        >Height<input
          type="number"
          disabled={busy}
          bind:value={drawnRegion.height}
          data-testid="drawn-region-height"
        /></label
      >
    </fieldset>
    <label
      >Visible statement<textarea
        disabled={busy}
        rows="2"
        bind:value={drawnStatement}
        data-testid="drawn-statement-input"></textarea></label
    >
    <label
      >Rationale<textarea
        disabled={busy}
        rows="2"
        bind:value={drawnRationale}
        data-testid="drawn-rationale-input"></textarea></label
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        bind:checked={drawnCoverage}
        data-testid="drawn-coverage-checkbox"
      />Coverage of the selected scope is complete</label
    >
    <div class="operand-actions">
      <button
        type="button"
        disabled={busy ||
          drawnSheet === undefined ||
          !drawnSheet.confirmed ||
          !drawnStatement.trim() ||
          !drawnRationale.trim() ||
          !Number.isInteger(drawnValue) ||
          drawnValue < 0 ||
          drawnRegion.width <= 0 ||
          drawnRegion.height <= 0}
        data-testid="accept-drawn-count"
        onclick={() =>
          onAccept("drawn", {
            value: drawnValue,
            statement: drawnStatement.trim(),
            rationale: drawnRationale.trim(),
            coverageConfirmed: drawnCoverage,
            region: drawnRegion,
          })}>Accept drawn count</button
      >
      <button
        type="button"
        disabled={busy}
        data-testid="detail-drawn"
        onclick={() => onRequestDetail("drawn", drawnRegion)}>300 DPI detail</button
      >
      {#if drawnFact}<button
          type="button"
          disabled={busy}
          data-testid="correct-drawn"
          onclick={() => onCorrect("drawn")}>Correct drawn</button
        >{/if}
    </div>
    {#if drawnFact}<p class="fact-id">
        Fact {drawnFact.id.slice(0, 8)} · v{drawnFact.version}
      </p>{/if}
  </section>

  <section class="operand" aria-label="scheduled operand">
    <h3>Scheduled count</h3>
    <p class="sheet-line">{scheduledSheet ? scheduledSheet.label : "Missing sheet"}</p>
    {#if scheduledFact && scheduledFact.evidence.sheetId !== finding.scheduledSheetId}<p
        class="warn"
      >
        Accepted input cites an earlier revision. Confirm unchanged correspondence or accept fresh
        evidence.
      </p>{/if}
    {#if scheduledSheet && !scheduledSheet.confirmed}
      <p class="warn" role="status">Confirm this sheet before accepting evidence.</p>
    {/if}
    <label
      >Count<input
        disabled={busy}
        type="number"
        min="0"
        bind:value={scheduledValue}
        data-testid="scheduled-count-input"
      /></label
    >
    <fieldset class="region-fields">
      <legend>Source region in PDF points</legend>
      <label
        >X<input
          type="number"
          disabled={busy}
          bind:value={scheduledRegion.x}
          data-testid="scheduled-region-x"
        /></label
      >
      <label
        >Y<input
          type="number"
          disabled={busy}
          bind:value={scheduledRegion.y}
          data-testid="scheduled-region-y"
        /></label
      >
      <label
        >Width<input
          type="number"
          disabled={busy}
          bind:value={scheduledRegion.width}
          data-testid="scheduled-region-width"
        /></label
      >
      <label
        >Height<input
          type="number"
          disabled={busy}
          bind:value={scheduledRegion.height}
          data-testid="scheduled-region-height"
        /></label
      >
    </fieldset>
    <label
      >Visible statement<textarea
        disabled={busy}
        rows="2"
        bind:value={scheduledStatement}
        data-testid="scheduled-statement-input"></textarea></label
    >
    <label
      >Rationale<textarea
        disabled={busy}
        rows="2"
        bind:value={scheduledRationale}
        data-testid="scheduled-rationale-input"></textarea></label
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        bind:checked={scheduledCoverage}
        data-testid="scheduled-coverage-checkbox"
      />Coverage of the selected scope is complete</label
    >
    <div class="operand-actions">
      <button
        type="button"
        disabled={busy ||
          scheduledSheet === undefined ||
          !scheduledSheet.confirmed ||
          !scheduledStatement.trim() ||
          !scheduledRationale.trim() ||
          !Number.isInteger(scheduledValue) ||
          scheduledValue < 0 ||
          scheduledRegion.width <= 0 ||
          scheduledRegion.height <= 0}
        data-testid="accept-scheduled-count"
        onclick={() =>
          onAccept("scheduled", {
            value: scheduledValue,
            statement: scheduledStatement.trim(),
            rationale: scheduledRationale.trim(),
            coverageConfirmed: scheduledCoverage,
            region: scheduledRegion,
          })}>Accept scheduled count</button
      >
      <button
        type="button"
        disabled={busy}
        data-testid="detail-scheduled"
        onclick={() => onRequestDetail("scheduled", scheduledRegion)}>300 DPI detail</button
      >
      {#if scheduledFact}<button
          type="button"
          disabled={busy}
          data-testid="correct-scheduled"
          onclick={() => onCorrect("scheduled")}>Correct scheduled</button
        >{/if}
    </div>
    {#if scheduledFact}<p class="fact-id">
        Fact {scheduledFact.id.slice(0, 8)} · v{scheduledFact.version}
      </p>{/if}
  </section>

  <div class="evaluate-row">
    <button
      type="button"
      class="primary"
      disabled={busy}
      data-testid="evaluate-finding"
      onclick={onEvaluate}>Evaluate coordination</button
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={finding.closed}
        onchange={(event) =>
          onStatus((event.currentTarget as HTMLInputElement).checked, finding.taskCompleted)}
      />Reviewer closed</label
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={finding.taskCompleted}
        onchange={(event) =>
          onStatus(finding.closed, (event.currentTarget as HTMLInputElement).checked)}
      />Task complete</label
    >
  </div>

  <section class="history" aria-label="Check history">
    <h3><ReviewIcon name="history" size={16} /> Evaluation history</h3>
    {#if history.length === 0}
      <p>No evaluations yet.</p>
    {:else}
      <ol data-testid="check-history">
        {#each history as run (run.id)}
          <li data-check-id={run.id}>
            <strong>{formatOutcome(run.outcome)}</strong>
            {#if run.difference !== null}
              <span>{run.drawnCount} − {run.scheduledCount} = {run.difference}</span>
            {/if}
            <p>{run.explanation}</p>
            <p class="fact-id">
              Check {run.id.slice(0, 8)} · drawn {run.drawnFactId?.slice(0, 8) ?? "—"} · scheduled {run.scheduledFactId?.slice(
                0,
                8,
              ) ?? "—"}
            </p>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .region-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    border: 1px solid var(--nd-hairline);
  }
  .region-fields input {
    min-width: 0;
    width: 100%;
  }
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 14px;
    font-size: 13px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .meta {
    margin: 4px 0 0;
    color: var(--nd-ink-muted);
  }
  .operand {
    padding: 12px;
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    background: var(--nd-panel);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  input,
  textarea {
    font: inherit;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-shell);
    color: inherit;
  }
  .warn {
    color: #e8a020;
    margin: 0;
  }
  .sheet-line {
    margin: 0;
    color: var(--nd-ink-muted);
  }
  .operand-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    font: inherit;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-raised);
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary {
    background: var(--nd-ink);
    color: var(--nd-shell);
    border-color: transparent;
  }
  .evaluate-row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }
  .history ol {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .history li {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fact-id {
    margin: 0;
    font-size: 11px;
    color: var(--nd-ink-muted);
    font-family: ui-monospace, monospace;
  }
</style>
