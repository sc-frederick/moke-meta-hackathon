<script lang="ts">
  import { untrack } from "svelte";
  import { Schema } from "effect";
  import {
    Region,
    type CheckRun,
    type CountFact,
    type Finding,
    type Sheet,
  } from "#lib/review/contracts.ts";
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
    onStatus,
    onRequestDetail,
    onChooseRegion,
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
    onStatus: (closed: boolean, taskCompleted: boolean) => void;
    onRequestDetail: (side: "drawn" | "scheduled", region: Region) => void;
    onChooseRegion: (side: "drawn" | "scheduled", apply: (region: Region) => void) => void;
  } = $props();

  const history = $derived(checksForFinding(checks, finding.id));
  const drawnSheet = $derived(sheets.find((sheet) => sheet.id === finding.drawnSheetId));
  const scheduledSheet = $derived(sheets.find((sheet) => sheet.id === finding.scheduledSheetId));
  const drawnFact = $derived(latestAcceptedFact(facts, finding.id, "drawn"));
  const scheduledFact = $derived(latestAcceptedFact(facts, finding.id, "scheduled"));

  let drawnInput: HTMLInputElement | undefined = $state();
  let scheduledInput: HTMLInputElement | undefined = $state();
  const drawnIdentity = $derived(`${finding.drawnSheetId}:${drawnFact?.id ?? ""}`);
  const scheduledIdentity = $derived(`${finding.scheduledSheetId}:${scheduledFact?.id ?? ""}`);

  const proposals = $derived(
    facts.filter(
      (fact) =>
        fact.findingId === finding.id &&
        fact.state === "proposed" &&
        fact.evidence.sheetId ===
          (fact.side === "drawn" ? finding.drawnSheetId : finding.scheduledSheetId) &&
        fact.version > ((fact.side === "drawn" ? drawnFact : scheduledFact)?.version ?? 0),
    ),
  );

  // Unrelated snapshot refreshes must preserve drafts; accepted evidence or sheet changes reset them.
  const drawnDefaults = $derived.by(() => {
    const identity = drawnIdentity;

    return untrack(() => {
      const fact = facts.find((entry) => `${finding.drawnSheetId}:${entry.id}` === identity);

      return {
        value: fact?.value ?? 0,
        statement: fact?.evidence.statement ?? "",
        rationale: fact?.rationale ?? "",
        coverage: fact?.evidence.sheetId === finding.drawnSheetId && fact.coverageConfirmed,
        region: fact?.evidence.region ?? defaultRegion(drawnSheet),
      };
    });
  });

  const scheduledDefaults = $derived.by(() => {
    const identity = scheduledIdentity;

    return untrack(() => {
      const fact = facts.find((entry) => `${finding.scheduledSheetId}:${entry.id}` === identity);

      return {
        value: fact?.value ?? 0,
        statement: fact?.evidence.statement ?? "",
        rationale: fact?.rationale ?? "",
        coverage: fact?.evidence.sheetId === finding.scheduledSheetId && fact.coverageConfirmed,
        region: fact?.evidence.region ?? defaultRegion(scheduledSheet),
      };
    });
  });

  let drawnValue = $derived(drawnDefaults.value);
  let scheduledValue = $derived(scheduledDefaults.value);
  let drawnStatement = $derived(drawnDefaults.statement);
  let scheduledStatement = $derived(scheduledDefaults.statement);
  let drawnRationale = $derived(drawnDefaults.rationale);
  let scheduledRationale = $derived(scheduledDefaults.rationale);
  let drawnCoverage = $derived(drawnDefaults.coverage);
  let scheduledCoverage = $derived(scheduledDefaults.coverage);

  function editableRegion({ x, y, width, height }: Region) {
    const region = $state({ x, y, width, height });

    return region;
  }

  let drawnRegion = $derived(editableRegion(drawnDefaults.region));
  let scheduledRegion = $derived(editableRegion(scheduledDefaults.region));
  const RegionInput = Schema.Struct(Region.fields);
  const drawnRegionValid = $derived(Schema.is(RegionInput)(drawnRegion));
  const scheduledRegionValid = $derived(Schema.is(RegionInput)(scheduledRegion));

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
      <h3>Suggested counts</h3>
      <p class="meta">Check the highlighted area before accepting a count.</p>
      {#each proposals as proposal (proposal.id)}
        <p>
          <strong
            >{proposal.value} {proposal.side === "drawn" ? "on drawing" : "in schedule"}</strong
          >
          · {proposal.evidence.statement}
        </p>
        <details class="technical-details">
          <summary>Source details</summary>
          {#if proposal.origin}<p class="meta">
              {proposal.origin.route} · {proposal.origin.provider} / {proposal.origin.model} · response
              {proposal.origin.responseId ?? "ID unavailable"}
            </p>
            <p class="meta">
              {proposal.origin.promptVersion} · {proposal.origin.discipline?.replaceAll("_", " ") ??
                "general"} · skills {proposal.origin.instructionRevision?.slice(0, 12) ?? "legacy"}
            </p>{/if}
          <p class="meta">
            {sheets.find((sheet) => sheet.id === proposal.evidence.sheetId)?.label} · PDF region {proposal
              .evidence.region.x}, {proposal.evidence.region.y}, {proposal.evidence.region.width} × {proposal
              .evidence.region.height}
          </p>
        </details>
        <button
          class="btn"
          disabled={busy}
          onclick={() => onRequestDetail(proposal.side, proposal.evidence.region)}
          >View proposal evidence</button
        >
        <button
          class="btn"
          disabled={busy}
          onclick={() => {
            if (proposal.side === "drawn") {
              drawnValue = proposal.value;
              drawnStatement = proposal.evidence.statement;
              drawnRationale = proposal.rationale;
              drawnRegion = editableRegion(proposal.evidence.region);
              drawnCoverage = false;
            } else {
              scheduledValue = proposal.value;
              scheduledStatement = proposal.evidence.statement;
              scheduledRationale = proposal.rationale;
              scheduledRegion = editableRegion(proposal.evidence.region);
              scheduledCoverage = false;
            }
          }}>Use this count</button
        >
      {/each}
    </section>
  {/if}
  <section class="operand" aria-label="drawn operand">
    <h3>On the drawing</h3>
    <p class="sheet-line">{drawnSheet ? drawnSheet.label : "Missing sheet"}</p>
    {#if drawnFact && drawnFact.evidence.sheetId !== finding.drawnSheetId}<p class="warn">
        Accepted input cites an earlier revision. Confirm unchanged correspondence or accept fresh
        evidence.
      </p>{/if}
    {#if drawnSheet && !drawnSheet.confirmed}
      <p class="warn" role="status">Confirm this sheet before accepting evidence.</p>
    {/if}
    <label
      >Count<input
        disabled={busy}
        type="number"
        min="0"
        max="100000"
        bind:value={drawnValue}
        bind:this={drawnInput}
        data-testid="drawn-count-input"
      /></label
    >

    <label
      >What you see<textarea
        disabled={busy}
        rows="2"
        maxlength="2000"
        bind:value={drawnStatement}
        data-testid="drawn-statement-input"></textarea></label
    >
    <button
      class="btn"
      type="button"
      disabled={busy}
      onclick={() =>
        onChooseRegion("drawn", (region) => {
          drawnRegion = editableRegion(region);
          drawnCoverage = false;
        })}>Select area on drawing</button
    >
    <details class="technical-details" data-testid="drawn-advanced">
      <summary>Source details and optional note</summary>
      <fieldset
        class="region-fields"
        oninput={() => {
          drawnCoverage = false;
        }}
      >
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
        >Review note (optional)<textarea
          disabled={busy}
          rows="2"
          maxlength="2000"
          bind:value={drawnRationale}
          data-testid="drawn-rationale-input"></textarea></label
      >
      {#if drawnFact}<p class="fact-id">
          Fact {drawnFact.id.slice(0, 8)} · v{drawnFact.version}
        </p>{/if}
    </details>
    <label class="checkbox"
      ><input type="checkbox" bind:checked={drawnCoverage} data-testid="drawn-coverage-checkbox" />I
      checked the entire selected area</label
    >
    <div class="operand-actions">
      <button
        class="btn"
        type="button"
        disabled={busy ||
          drawnSheet === undefined ||
          !drawnSheet.confirmed ||
          !drawnStatement.trim() ||
          !Number.isInteger(drawnValue) ||
          drawnValue < 0 ||
          drawnValue > 100000 ||
          !drawnRegionValid}
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
        class="btn"
        type="button"
        disabled={busy || !drawnRegionValid}
        data-testid="detail-drawn"
        onclick={() => onRequestDetail("drawn", drawnRegion)}>Enlarge source</button
      >
      {#if drawnFact}<button
          class="btn"
          type="button"
          disabled={busy}
          data-testid="correct-drawn"
          onclick={() => {
            drawnInput?.scrollIntoView({ block: "center" });
            drawnInput?.focus();
          }}>Correct drawn</button
        >{/if}
    </div>
  </section>

  <section class="operand" aria-label="scheduled operand">
    <h3>In the schedule</h3>
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
        max="100000"
        bind:value={scheduledValue}
        bind:this={scheduledInput}
        data-testid="scheduled-count-input"
      /></label
    >

    <label
      >What you see<textarea
        disabled={busy}
        rows="2"
        maxlength="2000"
        bind:value={scheduledStatement}
        data-testid="scheduled-statement-input"></textarea></label
    >
    <button
      class="btn"
      type="button"
      disabled={busy}
      onclick={() =>
        onChooseRegion("scheduled", (region) => {
          scheduledRegion = editableRegion(region);
          scheduledCoverage = false;
        })}>Select area on drawing</button
    >
    <details class="technical-details" data-testid="scheduled-advanced">
      <summary>Source details and optional note</summary>
      <fieldset
        class="region-fields"
        oninput={() => {
          scheduledCoverage = false;
        }}
      >
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
        >Review note (optional)<textarea
          disabled={busy}
          rows="2"
          maxlength="2000"
          bind:value={scheduledRationale}
          data-testid="scheduled-rationale-input"></textarea></label
      >
      {#if scheduledFact}<p class="fact-id">
          Fact {scheduledFact.id.slice(0, 8)} · v{scheduledFact.version}
        </p>{/if}
    </details>
    <label class="checkbox"
      ><input
        type="checkbox"
        bind:checked={scheduledCoverage}
        data-testid="scheduled-coverage-checkbox"
      />I checked the entire selected area</label
    >
    <div class="operand-actions">
      <button
        class="btn"
        type="button"
        disabled={busy ||
          scheduledSheet === undefined ||
          !scheduledSheet.confirmed ||
          !scheduledStatement.trim() ||
          !Number.isInteger(scheduledValue) ||
          scheduledValue < 0 ||
          scheduledValue > 100000 ||
          !scheduledRegionValid}
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
        class="btn"
        type="button"
        disabled={busy || !scheduledRegionValid}
        data-testid="detail-scheduled"
        onclick={() => onRequestDetail("scheduled", scheduledRegion)}>Enlarge source</button
      >
      {#if scheduledFact}<button
          class="btn"
          type="button"
          disabled={busy}
          data-testid="correct-scheduled"
          onclick={() => {
            scheduledInput?.scrollIntoView({ block: "center" });
            scheduledInput?.focus();
          }}>Correct scheduled</button
        >{/if}
    </div>
  </section>

  <div class="evaluate-row">
    <button
      type="button"
      class="btn primary"
      disabled={busy}
      data-testid="evaluate-finding"
      onclick={onEvaluate}>Compare counts</button
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={finding.closed}
        onchange={(event) => onStatus(event.currentTarget.checked, finding.taskCompleted)}
      />Close finding</label
    >
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={finding.taskCompleted}
        onchange={(event) => onStatus(finding.closed, event.currentTarget.checked)}
      />Mark task complete</label
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
            <details open={run.id === finding.latestCheckId}>
              <summary>
                <strong>{formatOutcome(run.outcome)}</strong>
                {#if run.difference !== null}
                  <span>{run.drawnCount} − {run.scheduledCount} = {run.difference}</span>
                {/if}
              </summary>
              <p>{run.explanation}</p>
              <details class="technical-details">
                <summary>Record details</summary>
                <p class="fact-id">
                  Check {run.id.slice(0, 8)} · drawn {run.drawnFactId?.slice(0, 8) ?? "—"} · scheduled
                  {run.scheduledFactId?.slice(0, 8) ?? "—"}
                </p>
              </details>
            </details>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-body-sm);
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  h3 {
    margin: 0 0 var(--space-2xs);
    font-size: var(--text-body-md);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }
  h3 :global(svg) {
    color: var(--color-text-muted);
  }
  p {
    margin: 0;
    line-height: var(--leading-relaxed);
  }
  .meta {
    margin: 4px 0 0;
    color: var(--color-text-muted);
  }
  section[aria-label="Proposed observations"] {
    display: grid;
    gap: var(--space-xs);
    justify-items: start;
  }
  .technical-details {
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
  }
  .technical-details > :not(summary) {
    margin-top: var(--space-xs);
  }
  summary {
    min-height: 24px;
  }
  .region-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-xs);
    padding: var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .region-fields input {
    min-width: 0;
    width: 100%;
  }
  .operand {
    padding: var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    box-shadow: var(--shadow-card);
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .operand h3 {
    margin: 0;
    padding-bottom: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
    font-family: var(--font-body);
    font-size: var(--text-body-sm);
    letter-spacing: normal;
    text-transform: none;
  }
  input,
  textarea {
    width: 100%;
  }
  input[type="checkbox"] {
    width: 18px;
  }
  textarea {
    min-height: 64px;
    resize: vertical;
  }
  .warn {
    color: var(--color-accent);
    margin: 0;
  }
  .sheet-line {
    margin: 0;
    color: var(--color-text-muted);
  }
  .operand > .btn {
    align-self: stretch;
  }
  .operand-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .evaluate-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
  }
  .history {
    padding-top: var(--space-md);
    border-top: 1px solid var(--color-border);
  }
  .history > p {
    color: var(--color-text-muted);
  }
  .history ol {
    margin: var(--space-xs) 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }
  .history li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-xs) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .history li > details > summary {
    gap: var(--space-xs);
    color: var(--color-text);
  }
  .history li > details > summary span {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
  }
  .history li > details > :not(summary) {
    margin-top: 6px;
    padding-left: 20px;
  }
  .fact-id {
    margin: 0;
    font-size: var(--text-label-sm);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    letter-spacing: var(--tracking-wide);
  }
</style>
