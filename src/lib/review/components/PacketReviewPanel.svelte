<script lang="ts">
  import { onMount } from "svelte";
  import { Match, Schema } from "effect";
  import type { PacketReview } from "#lib/review/packet.ts";
  import { configurationLabel, packetCoverageProgress } from "#lib/review/packet-coverage.ts";
  import { ReviewDiscipline, reviewDisciplines } from "#lib/review/disciplines.ts";
  import ReviewText from "./ReviewText.svelte";
  import { ReviewSourceUrl } from "#lib/review/source-url.ts";
  import { formatElapsed } from "./review-format.ts";

  let {
    review,
    busy = false,
    historical = false,
    onControl,
    onFinding,
    onExport,
    onOpenSource,
    onRefresh,
    onCopyDiagnostics,
  }: {
    review: PacketReview;
    busy?: boolean;
    historical?: boolean;
    onControl: (action: "pause" | "resume" | "cancel", maxCalls?: number | null) => Promise<void>;
    onFinding: (findingId: string) => Promise<void>;
    onExport: () => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onRefresh?: () => Promise<void>;
    onCopyDiagnostics: () => Promise<boolean>;
  } = $props();

  const passLabels = {
    completeness: "Document completeness",
    requirements: "Code and agency requirements",
    coordination: "Drawing coordination",
    prior_comments: "Prior comments",
  } as const;

  let diagnosticNotice = $state("");

  async function copyDiagnostics() {
    const copied = await onCopyDiagnostics();
    diagnosticNotice = copied
      ? "Review diagnostics copied."
      : "Copy is unavailable. The saved review report contains the failure details.";
  }

  const failureMessage = $derived(
    review.state === "cancelled"
      ? review.error?.replace(/\s*Cancel this review before starting a separate review\.\s*$/, "")
      : review.error,
  );

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

  const elapsed = $derived(
    Math.max(
      0,
      review.activeDurationMs === undefined
        ? (running ? now : review.changedAt) - review.startedAt
        : review.activeDurationMs +
            (running && review.activeSince != null ? now - review.activeSince : 0),
    ),
  );

  const scope = $derived(
    Match.value(review.scope).pipe(
      Match.tagsExhaustive({
        SelectedSheets: () => "Selected sheets review",
        WholeSet: () => "Whole-set review",
        Discipline: ({ discipline }) => `${discipline.replaceAll("_", " ")} review`,
      }),
    ),
  );

  const coverageProgress = $derived(packetCoverageProgress(review));

  type CoverageRow = PacketReview["coverage"][number];

  const CoverageFilter = Schema.Literals([
    "attention",
    "all",
    "unreviewed",
    "needs_input",
    "issue",
    "checked",
    "not_applicable",
  ]);

  const DisciplineFilter = Schema.Union([Schema.Literal("all"), ReviewDiscipline]);

  const statusLabels = {
    unreviewed: "Unreviewed",
    needs_input: "Needs input",
    issue: "Issue recorded",
    checked: "Checked",
    not_applicable: "Not applicable",
  } as const;

  const recordsPerPage = 20;
  let coverageFilter = $state<typeof CoverageFilter.Type>("attention");
  let disciplineFilter = $state<typeof DisciplineFilter.Type>("all");
  let sheetQuery = $state("");
  let includeEarlierCoverage = $state(false);
  let expandedSheetId = $state<string | null>(null);
  let coveragePage = $state(0);

  function summarizeCoverage(rows: ReadonlyArray<CoverageRow>) {
    return {
      total: rows.length,
      checked: rows.filter((row) => row.status === "checked").length,
      issues: rows.filter((row) => row.status === "issue").length,
      needsInput: rows.filter((row) => row.status === "needs_input").length,
      unreviewed: rows.filter((row) => row.status === "unreviewed").length,
      notApplicable: rows.filter((row) => row.status === "not_applicable").length,
    };
  }

  const disciplineCoverage = $derived(
    reviewDisciplines.flatMap((discipline) => {
      const rows = coverageProgress.rows.filter((row) => row.discipline === discipline.id);

      return rows.length > 0 ? [{ ...discipline, ...summarizeCoverage(rows) }] : [];
    }),
  );

  const detailCoverage = $derived(
    includeEarlierCoverage ? coverageProgress.ledger : coverageProgress.rows,
  );

  const matchingCoverage = $derived(
    detailCoverage.filter((row) => {
      if (disciplineFilter !== "all" && row.discipline !== disciplineFilter) return false;

      if (coverageFilter === "all") return true;

      if (coverageFilter !== "attention") return row.status === coverageFilter;

      return (
        row.status === "unreviewed" ||
        row.status === "needs_input" ||
        row.status === "issue" ||
        (row.status === "not_applicable" && row.note.trim().length === 0)
      );
    }),
  );

  const coverageSheets = $derived(
    review.sheets.flatMap((sheet) => {
      if (
        !`${sheet.label} ${sheet.documentName} page ${sheet.pageIndex + 1}`
          .toLowerCase()
          .includes(sheetQuery.trim().toLowerCase())
      )
        return [];

      const matching = matchingCoverage.filter((row) => row.sheetId === sheet.id);

      return matching.length > 0
        ? [
            {
              sheet,
              matching,
              counts: summarizeCoverage(detailCoverage.filter((row) => row.sheetId === sheet.id)),
            },
          ]
        : [];
    }),
  );

  const matchingCount = $derived(
    coverageSheets.reduce((total, entry) => total + entry.matching.length, 0),
  );

  // Needs-input and unexplained not-applicable passes count as recorded but leave a gap.
  const unsettledRecorded = $derived(coverageProgress.recorded - coverageProgress.settled);

  const hasCoverageGaps = $derived(
    review.sheets.some((sheet) => !review.inspectedSheetIds.includes(sheet.id)) ||
      !coverageProgress.complete,
  );

  const hasReviewGaps = $derived(
    review.missingInputs.length > 0 ||
      review.findings.some((finding) => finding.status === "Needs input") ||
      review.citations.some((citation) => citation.status !== "verified"),
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
              : hasCoverageGaps
                ? "Review finished with coverage gaps"
                : !review.finished || hasReviewGaps
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

<section
  class="packet-review"
  aria-label={scope}
  data-testid={historical ? "historical-review-panel" : "packet-review-panel"}
>
  <header>
    <div>
      <p class="eyebrow">MOKE · {scope}</p>
      <h2>{stateLabel}</h2>
    </div>
    <span class="duration" aria-label="Review elapsed time">{formatElapsed(elapsed)}</span>
  </header>
  <p class="progress" role="status">
    {review.inspectedSheetIds.length} of {review.sheets.length}
    {review.sheets.length === 1 ? "sheet" : "sheets"} opened · {coverageProgress.recorded}
    of
    {coverageProgress.total} review passes recorded{unsettledRecorded > 0
      ? ` · ${unsettledRecorded} still ${unsettledRecorded === 1 ? "needs" : "need"} input or a reason`
      : ""}
  </p>
  {#if review.summary}<div class="summary">
      <ReviewText
        text={review.summary.length > 500 ? review.summary.slice(0, 500) + "…" : review.summary}
      />
    </div>
    {#if review.summary.length > 500}<details class="records">
        <summary>Full review notes</summary>
        <ReviewText text={review.summary} />
      </details>{/if}{/if}
  {#if review.steering?.length}<details class="records">
      <summary>Follow-up instructions · {review.steering.length}</summary
      >{#each review.steering as instruction (instruction.commandId)}<p>
          {instruction.text}
          <span class="muted"
            >{instruction.status === "queued"
              ? "Queued for the next tool boundary"
              : instruction.status === "applied"
                ? "Applied"
                : instruction.status === "pending"
                  ? "Saved; delivery not confirmed"
                  : "Not answered — review stopped before it could finish"}</span
          >
        </p>{/each}
    </details>{/if}
  {#if failureMessage}<p class="attention" role="alert">{failureMessage}</p>{/if}
  {#if review.missingInputs.length > 0}
    <div class="missing">
      <h3>Needs input</h3>
      <ul>
        {#each review.missingInputs as input, index (`${index}:${input}`)}<li>{input}</li>{/each}
      </ul>
    </div>
  {/if}
  <div class="actions">
    <button disabled={busy} onclick={onExport}>Export review report</button>
    {#if review.error}<button onclick={copyDiagnostics}>Copy review diagnostics</button>{/if}
    {#if !historical && onRefresh}<button
        disabled={busy}
        data-testid="refresh-review"
        onclick={onRefresh}>Refresh review</button
      >{/if}
    {#if running && !historical}<button disabled={busy} onclick={() => onControl("pause")}
        >Pause review</button
      >{/if}
    {#if budgetExhausted && !historical}<div class="budget-extension">
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
      </div>{:else if review.state === "paused" && !historical}<button
        disabled={busy}
        onclick={() => onControl("resume")}>Resume review</button
      >{/if}
    {#if !historical && ["running", "paused", "uncertain"].includes(review.state)}<button
        disabled={busy}
        onclick={() => onControl("cancel")}>Cancel review</button
      >{/if}
  </div>
  {#if diagnosticNotice}<p role="status" class="muted">{diagnosticNotice}</p>{/if}
  {#if review.state === "uncertain"}<p class="muted">
      The last provider request has an uncertain outcome. Its recorded work is preserved; it will
      not be sent again automatically. It may have been charged. Cancel this stopped review to
      unlock a new request; saved findings and failure details remain in history.
    </p>{/if}
  {#if review.findings.length > 0}
    <div class="findings">
      <h3>Review findings <span>{review.findings.length}</span></h3>
      {#each review.findings as finding (finding.id)}
        <button
          type="button"
          class="finding"
          data-testid={`packet-finding-${finding.id}`}
          onclick={() => onFinding(finding.id)}
          ><span class="severity" data-severity={finding.severity}>{finding.severity}</span><strong
            >{finding.title}</strong
          ><span class="finding-status">{finding.status}</span></button
        >
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
        </p>
        <section class="source-record">
          <p>{source.url}</p>
          <p class="muted">Retrieved {new Date(source.retrievedAt).toLocaleString()}</p>
          {#if Schema.is(ReviewSourceUrl)(source.url)}<button
              onclick={() => onOpenSource(source.url)}>Open source in browser</button
            >{/if}
          <details>
            <summary>Saved retrieved text</summary>
            <p>{source.text || "No text was retrieved."}</p>
          </details>
        </section>{/each}
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
          <dl class="configuration">
            {#each Object.entries(review.projectConfiguration) as [name, value] (name)}<dt>
                {configurationLabel(name)}
              </dt>
              <dd>{value}</dd>{/each}
          </dl>
        </section>{/if}
      <p class="muted">
        The requested scope contains {review.sheets.length}
        {review.sheets.length === 1 ? "sheet" : "sheets"} × {disciplineCoverage.length}
        {disciplineCoverage.length === 1 ? "discipline" : "disciplines"} × {Object.keys(passLabels)
          .length} review passes = {coverageProgress.total} required passes. Checked and issue statuses
        record the reviewer's work; they do not establish engineering correctness. Not applicable is counted
        separately and requires a reason.
      </p>
      <div class="coverage-table-scroll" role="region" aria-label="Coverage by discipline">
        <table class="discipline-coverage" data-testid="discipline-coverage">
          <caption>Requested scope by discipline</caption>
          <thead
            ><tr
              ><th scope="col">Discipline</th><th scope="col">Required</th><th scope="col"
                >Checked</th
              ><th scope="col">Issues</th><th scope="col">Needs input</th><th scope="col"
                >Unreviewed</th
              ><th scope="col">Not applicable</th></tr
            ></thead
          >
          <tbody>
            {#each disciplineCoverage as discipline (discipline.id)}
              <tr
                ><th scope="row">{discipline.label}</th><td>{discipline.total}</td><td
                  >{discipline.checked}</td
                ><td>{discipline.issues}</td><td>{discipline.needsInput}</td><td
                  >{discipline.unreviewed}</td
                ><td>{discipline.notApplicable}</td></tr
              >
            {/each}
          </tbody>
        </table>
      </div>
      <fieldset class="coverage-filters">
        <legend>Find review records</legend>
        <div class="coverage-filter">
          <label for={`coverage-status-${review.id}`}>Status</label>
          <select
            id={`coverage-status-${review.id}`}
            value={coverageFilter}
            onchange={(event) => {
              coverageFilter = Schema.decodeUnknownSync(CoverageFilter)(event.currentTarget.value);
              coveragePage = 0;
            }}
            ><option value="attention">Needs attention</option><option value="all"
              >All statuses</option
            ><option value="unreviewed">Unreviewed</option><option value="needs_input"
              >Needs input</option
            ><option value="issue">Issues recorded</option><option value="checked">Checked</option
            ><option value="not_applicable">Not applicable</option></select
          >
        </div>
        <div class="coverage-filter">
          <label for={`coverage-discipline-${review.id}`}>Discipline</label>
          <select
            id={`coverage-discipline-${review.id}`}
            value={disciplineFilter}
            onchange={(event) => {
              disciplineFilter = Schema.decodeUnknownSync(DisciplineFilter)(
                event.currentTarget.value,
              );
              coveragePage = 0;
            }}
            ><option value="all">All disciplines</option
            >{#each reviewDisciplines as discipline (discipline.id)}<option value={discipline.id}
                >{discipline.label}</option
              >{/each}</select
          >
        </div>
        <div class="coverage-filter">
          <label for={`coverage-sheet-${review.id}`}>Sheet</label>
          <input
            id={`coverage-sheet-${review.id}`}
            type="search"
            placeholder="Sheet, document or page"
            bind:value={sheetQuery}
          />
        </div>
        <label class="earlier-coverage"
          ><input
            type="checkbox"
            checked={includeEarlierCoverage}
            onchange={(event) => {
              includeEarlierCoverage = event.currentTarget.checked;
              coveragePage = 0;
            }}
          />Include compatible records from earlier scopes</label
        >
      </fieldset>
      <p class="muted">
        Needs attention includes unreviewed passes, missing inputs, recorded issues and Not
        applicable entries without a reason. Filters affect the records below; the requested-scope
        counts above stay unchanged.
      </p>
      <p role="status" data-testid="coverage-matches">
        {matchingCount} matching {matchingCount === 1 ? "record" : "records"} across {coverageSheets.length}
        {coverageSheets.length === 1 ? "sheet" : "sheets"}. Open a sheet to inspect up to {recordsPerPage}
        records at a time.
      </p>
      {#each coverageSheets as entry (entry.sheet.id)}
        <details
          class="sheet-coverage"
          name={`coverage-${review.id}`}
          ontoggle={(event) => {
            if (event.newState === "open") {
              expandedSheetId = entry.sheet.id;
              coveragePage = 0;
            } else if (expandedSheetId === entry.sheet.id) expandedSheetId = null;
          }}
        >
          <summary>
            {entry.sheet.label}
            <span class="muted">· {entry.sheet.documentName}, page {entry.sheet.pageIndex + 1}</span
            >
            · {entry.matching.length} / {entry.counts.total} passes match
          </summary>
          {#if expandedSheetId === entry.sheet.id}
            {@const pages = Math.ceil(entry.matching.length / recordsPerPage)}
            {@const currentPage = Math.min(coveragePage, pages - 1)}
            <p class="muted sheet-counts">
              {entry.counts.checked} checked · {entry.counts.issues} issues · {entry.counts
                .needsInput} need input · {entry.counts.unreviewed} unreviewed · {entry.counts
                .notApplicable} not applicable
            </p>
            {#each entry.matching.slice(currentPage * recordsPerPage, (currentPage + 1) * recordsPerPage) as item (`${item.pass}:${item.discipline}`)}<p
                class="coverage-record"
                data-testid="coverage-record"
              >
                <span
                  >{passLabels[item.pass]} · {reviewDisciplines.find(
                    (discipline) => discipline.id === item.discipline,
                  )?.label}</span
                ><strong
                  >{statusLabels[item.status]}{item.status === "not_applicable" && !item.note.trim()
                    ? " · reason missing"
                    : ""}</strong
                >
                {#if item.note}<small>{item.note}</small>{/if}
              </p>{/each}
            {#if pages > 1}<nav
                class="coverage-pagination"
                aria-label={`Review records for ${entry.sheet.label}`}
              >
                <button
                  disabled={currentPage === 0}
                  onclick={() => (coveragePage = currentPage - 1)}>Previous records</button
                >
                <span>Page {currentPage + 1} of {pages}</span>
                <button
                  disabled={currentPage + 1 >= pages}
                  onclick={() => (coveragePage = currentPage + 1)}>Next records</button
                >
              </nav>{/if}
          {/if}
        </details>
      {/each}
      {#if coverageSheets.length === 0}<p>No review records match these filters.</p>{/if}
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
  li,
  small {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .eyebrow,
  .muted,
  .duration,
  .progress {
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
  .actions {
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
  input:focus-visible,
  select:focus-visible,
  .coverage-table-scroll:focus-visible {
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
    display: flex;
    width: 100%;
    text-align: left;
    border: 0;
    border-top: 1px solid var(--nd-hairline);
    border-radius: 0;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 7px;
    padding: 13px 0;
    cursor: pointer;
  }
  .finding::before {
    content: "›";
    color: var(--nd-ink-muted);
  }
  .finding strong {
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
  .sheet-coverage {
    padding: 10px 0;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .sheet-coverage summary {
    cursor: pointer;
    line-height: 1.6;
  }
  .coverage-table-scroll {
    overflow-x: auto;
    margin: 16px 0;
  }
  .discipline-coverage {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .discipline-coverage caption {
    text-align: left;
    font-weight: 500;
    margin-bottom: 8px;
  }
  .discipline-coverage th,
  .discipline-coverage td {
    border-bottom: 1px solid var(--nd-hairline);
    padding: 7px 8px;
    text-align: right;
    white-space: nowrap;
  }
  .discipline-coverage th:first-child {
    text-align: left;
    padding-left: 0;
  }
  .discipline-coverage th {
    font-weight: 500;
  }
  .coverage-filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
    gap: 10px;
    padding: 12px 0;
    margin: 0;
    border: 0;
  }
  .coverage-filters legend {
    padding: 0;
    font-weight: 500;
  }
  .coverage-filter {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .coverage-filters select,
  .coverage-filters input[type="search"] {
    width: 100%;
    min-width: 0;
    color: inherit;
    font: inherit;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    background: var(--nd-panel);
    padding: 7px 8px;
  }
  .coverage-filters .earlier-coverage {
    display: flex;
    align-items: center;
    gap: 7px;
    grid-column: 1 / -1;
  }
  .earlier-coverage input {
    margin: 0;
  }
  .coverage-list .sheet-counts {
    margin: 10px 0;
  }
  .coverage-record {
    padding: 7px 0;
    border-top: 1px solid var(--nd-hairline);
  }
  .coverage-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 10px;
  }
  .source-record {
    overflow-wrap: anywhere;
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
  .configuration {
    display: grid;
    grid-template-columns: minmax(120px, max-content) minmax(0, 1fr);
    gap: 6px 16px;
    margin: 4px 0 12px;
  }
  .configuration dt {
    color: var(--nd-ink-muted);
  }
  .configuration dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .coverage-list small {
    flex-basis: 100%;
    color: var(--nd-ink-muted);
  }
</style>
