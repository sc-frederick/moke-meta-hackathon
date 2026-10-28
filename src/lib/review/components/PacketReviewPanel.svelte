<script lang="ts">
  import { onMount } from "svelte";
  import { Match } from "effect";
  import type { ArtifactId, SheetId, Region } from "#lib/review/contracts.ts";
  import type { PacketReview } from "#lib/review/packet.ts";
  import { formatElapsed } from "./review-format.ts";

  let {
    review,
    busy = false,
    onControl,
    onComplete,
    onExport,
    onEvidence,
  }: {
    review: PacketReview;
    busy?: boolean;
    onControl: (action: "pause" | "resume" | "cancel", maxCalls?: number | null) => Promise<void>;
    onComplete: (findingId: string, completed: boolean) => Promise<void>;
    onExport: () => Promise<void>;
    onEvidence: (
      artifactId: typeof ArtifactId.Type | null,
      location?: { sheetId: typeof SheetId.Type; region: Region | null; detail: string },
    ) => Promise<void>;
  } = $props();

  const passLabels = {
    completeness: "Document completeness",
    requirements: "Code and agency requirements",
    coordination: "Drawing coordination",
    prior_comments: "Prior comments",
  } as const;

  let additionalCallsDraft = $state<string | null>(null);
  const additionalCalls = $derived(Number(additionalCallsDraft ?? review.maxCalls ?? 1));
  const extendedBudget = $derived(review.admittedCalls + additionalCalls);

  const validAdditionalCalls = $derived(
    Number.isSafeInteger(additionalCalls) &&
      additionalCalls > 0 &&
      Number.isSafeInteger(extendedBudget),
  );

  const budgetExhausted = $derived(
    review.state === "paused" &&
      review.maxCalls !== null &&
      review.admittedCalls >= review.maxCalls,
  );

  let now = $state(Date.now());
  const running = $derived(review.state === "running");
  const elapsed = $derived(Math.max(0, (running ? now : review.changedAt) - review.startedAt));

  const scope = $derived(
    Match.value(review.scope).pipe(
      Match.tagsExhaustive({
        WholeSet: () => "Whole-set review",
        Discipline: ({ discipline }) => `${discipline.replaceAll("_", " ")} review`,
      }),
    ),
  );

  const pendingCoverage = $derived(review.coverage.filter((item) => item.status === "unreviewed"));
  const missingCoverage = $derived(review.coverage.filter((item) => item.status === "needs_input"));
  const completedCoverage = $derived(review.coverage.length - pendingCoverage.length);

  const hasCoverageGaps = $derived(
    review.sheets.some((sheet) =>
      Object.keys(passLabels).some(
        (pass) =>
          !review.coverage.some(
            (item) =>
              item.sheetId === sheet.id && item.pass === pass && item.status !== "unreviewed",
          ),
      ),
    ),
  );

  const stateLabel = $derived(
    running
      ? "Review in progress"
      : review.state === "paused"
        ? "Review paused"
        : review.state === "uncertain"
          ? "Review needs attention"
          : review.state === "cancelled"
            ? "Review cancelled"
            : review.state === "failed"
              ? "Review stopped"
              : !review.finished ||
                  hasCoverageGaps ||
                  pendingCoverage.length > 0 ||
                  missingCoverage.length > 0 ||
                  review.missingInputs.length > 0
                ? "Review finished with gaps"
                : "Review finished",
  );

  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);

    return () => clearInterval(timer);
  });
</script>

<section class="packet-review" aria-label={scope} data-testid="packet-review-panel">
  <header>
    <div>
      <p class="eyebrow">Moke · {scope}</p>
      <h2>{stateLabel}</h2>
    </div>
    <span class="duration" aria-label="Review elapsed time">{formatElapsed(elapsed)}</span>
  </header>
  <p class="progress" role="status">
    {review.inspectedSheetIds.length} of {review.sheets.length} sheets opened · {completedCoverage} of
    {review.coverage.length} review passes recorded
  </p>
  {#if review.summary}<p class="summary">{review.summary}</p>{/if}
  {#if review.error}<p class="attention" role="alert">{review.error}</p>{/if}
  {#if review.missingInputs.length > 0}
    <div class="missing">
      <h3>Needs input</h3>
      <ul>
        {#each review.missingInputs as input, index (`${index}:${input}`)}<li>{input}</li>{/each}
      </ul>
    </div>
  {/if}
  <div class="actions">
    {#if running}<button disabled={busy} onclick={() => onControl("pause")}>Pause review</button
      >{/if}
    {#if budgetExhausted}<div class="budget-extension">
        <label
          >Additional calls<input
            type="number"
            min="1"
            step="1"
            value={additionalCallsDraft ?? String(review.maxCalls ?? 1)}
            disabled={busy}
            oninput={(event) => {
              additionalCallsDraft = event.currentTarget.value;
            }}
          /></label
        ><button
          disabled={busy || !validAdditionalCalls}
          onclick={() => onControl("resume", extendedBudget)}>Add calls and resume</button
        >
        <p class="muted">
          {#if validAdditionalCalls}New call budget: {extendedBudget} total, including {review.admittedCalls}
            already used.{:else}Enter a positive whole number of additional calls.{/if}
        </p>
      </div>{:else if review.state === "paused"}<button
        disabled={busy}
        onclick={() => onControl("resume")}>Resume review</button
      >{/if}
    {#if ["running", "paused", "uncertain"].includes(review.state)}<button
        disabled={busy}
        onclick={() => onControl("cancel")}>Cancel review</button
      >{/if}
    <button disabled={busy} onclick={onExport}>Export HTML report</button>
  </div>
  {#if review.state === "uncertain"}<p class="muted">
      The last provider request has an uncertain outcome. Its recorded work is preserved; it will
      not be sent again automatically.
    </p>{/if}
  {#if review.findings.length > 0}
    <div class="findings">
      <h3>Review findings <span>{review.findings.length}</span></h3>
      {#each review.findings as finding (finding.id)}
        <details class="finding" data-testid={`packet-finding-${finding.id}`}>
          <summary
            ><span class="severity" data-severity={finding.severity}>{finding.severity}</span
            ><strong>{finding.title}</strong><span class="finding-status">{finding.status}</span
            ></summary
          >
          <div class="finding-body">
            <p class="muted">
              {finding.discipline.replaceAll("_", " ")} · {finding.classification}
            </p>
            <p>{finding.observed}</p>
            <h4>Correction</h4>
            <p>{finding.correction}</p>
            <div class="evidence-links">
              {#each finding.evidenceIds as artifactId (artifactId)}<button
                  disabled={busy}
                  onclick={() => onEvidence(artifactId, finding.locations[0])}
                  >Open source evidence</button
                >{/each}
              {#each finding.locations as location, index (`${location.sheetId}:${index}`)}<button
                  disabled={busy}
                  onclick={() => onEvidence(null, location)}
                  >{review.sheets.find((sheet) => sheet.id === location.sheetId)?.label ??
                    "Source sheet"} · {location.detail}</button
                >{/each}
            </div>
            {#if finding.evidenceNote}<p class="muted">{finding.evidenceNote}</p>{/if}
            {#if finding.citationIds.length > 0}<h4>Sources</h4>
              <ul>
                {#each finding.citationIds as citationId (citationId)}{@const citation =
                    review.citations.find((item) => item.id === citationId)}{#if citation}<li>
                      {citation.document}
                      {citation.edition} · {citation.section} — {citation.status}{#if citation.note}:
                        {citation.note}{/if}
                    </li>{/if}{/each}
              </ul>{/if}
            <label class="completion"
              ><input
                type="checkbox"
                checked={finding.completed}
                disabled={busy}
                aria-label={`Completed: ${finding.title}`}
                onchange={(event) => {
                  const completed = event.currentTarget.checked;
                  event.currentTarget.checked = finding.completed;
                  void onComplete(finding.id, completed);
                }}
              />Completed</label
            >
            <p class="completion-note">
              Tracks your correction work. Finding status and verified closure remain separate.
            </p>
          </div>
        </details>
      {/each}
    </div>
  {/if}
  {#if review.calculations.length > 0}<details class="records">
      <summary>Supporting calculations · {review.calculations.length}</summary
      >{#each review.calculations as calculation (calculation.id)}<section>
          <h4>{calculation.title}</h4>
          <p>
            <code>{calculation.expression}</code> =
            <strong>{calculation.result} {calculation.unit}</strong>
          </p>
          <p class="muted">
            {Object.entries(calculation.inputs)
              .map(([name, input]) => `${name} = ${input.value} ${input.unit}`)
              .join(" · ")}
          </p>
          <p>{calculation.explanation}</p>
        </section>{/each}
    </details>{/if}
  {#if review.citations.length > 0 || review.sources.length > 0}<details class="records">
      <summary>Governing sources and citations</summary
      >{#each review.citations as citation (citation.id)}<section>
          <h4>{citation.document} {citation.edition} · {citation.section}</h4>
          <p class="muted">{citation.jurisdiction} · {citation.status}</p>
          {#if citation.quote}<blockquote>{citation.quote}</blockquote>{/if}
          <p>{citation.application}</p>
          {#if citation.note}<p class="muted">{citation.note}</p>{/if}
        </section>{/each}{#each review.sources as source (source.id)}<p class="muted">
          {source.title || source.url} · {source.status}{source.official
            ? " · official source"
            : ""}
        </p>{/each}
    </details>{/if}
  {#if review.priorComments.length > 0}<details class="records">
      <summary>Prior comments · {review.priorComments.length}</summary
      >{#each review.priorComments as comment (comment.id)}<section>
          <h4>{comment.agency} {comment.number} · {comment.status}</h4>
          <p>{comment.comment}</p>
          <p>{comment.response}</p>
          {#if comment.changedSources}<p class="muted">{comment.changedSources}</p>{/if}
        </section>{/each}
    </details>{/if}
  <details class="coverage">
    <summary>Sheet coverage and review records</summary>
    <div class="coverage-list">
      {#if Object.keys(review.projectConfiguration).length > 0}<section>
          <h4>Project configuration</h4>
          {#each Object.entries(review.projectConfiguration) as [name, value] (name)}<p>
              <span>{name}</span><strong>{value}</strong>
            </p>{/each}
        </section>{/if}
      {#each review.sheets as sheet (sheet.id)}
        <section>
          <h4>
            {sheet.label}
            <span class="muted">· {sheet.documentName}, page {sheet.pageIndex + 1}</span>
          </h4>
          {#each review.coverage.filter((item) => item.sheetId === sheet.id) as item (`${item.pass}:${item.discipline}`)}<p
            >
              <span>{passLabels[item.pass]} · {item.discipline.replaceAll("_", " ")}</span><strong
                >{item.status.replaceAll("_", " ")}</strong
              >{#if item.note}<small>{item.note}</small>{/if}
            </p>{/each}
        </section>
      {/each}
      <p class="muted">
        {review.citations.length} citations · {review.calculations.length} calculations · {review
          .priorComments.length} prior comments
      </p>
      <p class="muted">
        {review.admittedCalls} provider calls{review.maxCalls === null
          ? ""
          : ` of the optional ${review.maxCalls}-call budget`} · {review.promptVersion}
      </p>
    </div>
  </details>
</section>

<style>
  .packet-review {
    border: 1px solid var(--nd-hairline);
    border-radius: 14px;
    padding: 20px;
    margin: 20px 0 28px;
    color: var(--nd-ink);
    background: var(--nd-panel);
  }
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }
  h2 {
    margin: 4px 0 12px;
    font-size: 17px;
    font-weight: 600;
  }
  h3 {
    font-size: 14px;
    margin: 18px 0 10px;
  }
  h4 {
    font-size: 13px;
    margin: 12px 0 5px;
  }
  p {
    line-height: 1.6;
    margin: 7px 0;
  }
  .summary,
  .finding-body > p,
  li,
  small {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .eyebrow,
  .muted,
  .duration,
  .progress,
  .completion-note {
    color: var(--nd-ink-muted);
    font-size: 12px;
  }
  .eyebrow {
    margin: 0;
    text-transform: capitalize;
  }
  .duration {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .budget-extension {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
    flex-basis: 100%;
  }
  .budget-extension label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  .budget-extension input {
    width: 130px;
    padding: 7px 10px;
    color: inherit;
    font: inherit;
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-panel);
    border-radius: 7px;
  }
  .budget-extension p {
    flex-basis: 100%;
    margin-top: 0;
  }
  .actions,
  .evidence-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  button {
    cursor: pointer;
    color: inherit;
    font: inherit;
    font-size: 12px;
    padding: 7px 10px;
    border-radius: 7px;
    border: 1px solid var(--nd-hairline-strong);
    background: transparent;
  }
  button:hover {
    background: var(--nd-raised-hover);
  }
  button:disabled,
  input:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:focus-visible,
  summary:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--nd-ink);
    outline-offset: 3px;
  }
  .attention,
  .missing {
    border-left: 2px solid var(--nd-warning, #b89852);
    padding-left: 12px;
  }
  .missing h3 {
    margin-top: 12px;
  }
  ul {
    margin: 7px 0;
    padding-left: 20px;
  }
  li {
    font-size: 13px;
    line-height: 1.6;
  }
  .findings > h3 span {
    color: var(--nd-ink-muted);
    font-weight: 400;
  }
  .finding {
    border-top: 1px solid var(--nd-hairline);
  }
  .finding > summary {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 7px;
    padding: 13px 0;
    cursor: pointer;
    list-style: none;
  }
  .finding > summary::before {
    content: "›";
    color: var(--nd-ink-muted);
  }
  .finding[open] > summary::before {
    content: "⌄";
  }
  summary strong {
    flex: 1;
    min-width: 120px;
    font-size: 13px;
  }
  .severity,
  .finding-status {
    font-size: 11px;
  }
  .severity {
    color: var(--nd-ink-muted);
  }
  .severity[data-severity="Critical"] {
    color: var(--nd-warning);
  }
  .finding-status {
    color: var(--nd-ink-muted);
  }
  .finding-body {
    padding: 0 0 16px 14px;
    font-size: 13px;
  }
  .completion {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 16px;
  }
  .completion-note {
    margin-top: 3px;
    font-size: 11px;
  }
  .records {
    border-top: 1px solid var(--nd-hairline);
    padding-top: 14px;
    margin-top: 18px;
    font-size: 13px;
  }
  .records > summary {
    cursor: pointer;
    color: var(--nd-ink-muted);
    font-size: 12px;
  }
  .records p,
  blockquote {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .records blockquote {
    margin: 10px 0;
    padding-left: 12px;
    border-left: 2px solid var(--nd-hairline-strong);
  }
  .records code {
    font-size: 12px;
  }
  .coverage {
    margin-top: 18px;
    border-top: 1px solid var(--nd-hairline);
    padding-top: 14px;
    font-size: 12px;
  }
  .coverage > summary {
    cursor: pointer;
    color: var(--nd-ink-muted);
  }
  .coverage-list section {
    margin-top: 14px;
  }
  .coverage-list p {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 4px 0;
  }
  .coverage-list strong {
    font-weight: 500;
    text-transform: capitalize;
    margin-left: auto;
  }
  .coverage-list small {
    flex-basis: 100%;
    color: var(--nd-ink-muted);
  }
</style>
