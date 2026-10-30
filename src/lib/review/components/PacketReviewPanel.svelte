<script lang="ts">
  import { onMount } from "svelte";
  import { Match, Schema } from "effect";
  import {
    cachedPromptShare,
    packetFindingText,
    packetVerdictLabels,
    type PacketReview,
  } from "#lib/review/packet.ts";
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
  const cachedShare = $derived(cachedPromptShare(review.promptUsage));

  // Large reviews run setup, one reviewer per sheet, then cross-sheet coordination.
  const stageLine = $derived.by(() => {
    if (review.parallel === undefined || review.state !== "running") return null;
    const { stage, sheets } = review.parallel;

    if (stage === "setup") return "Recording project facts before sheet reviewers start";

    if (stage === "coordination") return "Comparing sheets for cross-sheet conflicts";

    const count = (state: string) => sheets.filter((entry) => entry.state === state).length;

    return `Sheet reviewers: ${count("running")} running · ${count("completed")} of ${sheets.length} finished${
      count("failed") > 0 ? ` · ${count("failed")} stopped` : ""
    }`;
  });

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
      <h2>{stateLabel}</h2>
      <p class="scope">{scope}</p>
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
  {#if stageLine}<p class="muted stage-line">{stageLine}</p>{/if}
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
    <button class="btn" disabled={busy} onclick={onExport}>Export review report</button>
    {#if review.error || review.state !== "running"}<button class="btn" onclick={copyDiagnostics}
        >Copy review diagnostics</button
      >{/if}
    {#if !historical && onRefresh}<button
        class="btn"
        disabled={busy}
        data-testid="refresh-review"
        onclick={onRefresh}>Refresh review</button
      >{/if}
    {#if running && !historical}<button
        class="btn"
        disabled={busy}
        onclick={() => onControl("pause")}>Pause review</button
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
          class="btn"
          disabled={busy || !validAdditionalCalls}
          onclick={() => onControl("resume", extendedBudget)}>Add calls and resume</button
        >
        <p class="muted">
          {#if validAdditionalCalls}New call budget: {extendedBudget} total, including {review.admittedCalls}
            already used.{:else}Enter a positive whole number of additional calls.{/if}
        </p>
      </div>{:else if review.state === "paused" && !historical}<button
        class="btn"
        disabled={busy}
        onclick={() => onControl("resume")}>Resume review</button
      >{/if}
    {#if !historical && ["running", "paused", "uncertain"].includes(review.state)}<button
        class="btn"
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
          data-decision={finding.decision?.verdict}
          onclick={() => onFinding(finding.id)}
          ><span class="severity" data-severity={finding.severity}>{finding.severity}</span><strong
            >{packetFindingText(finding).title}</strong
          ><span class="finding-status"
            >{finding.decision
              ? `${finding.status} · ${packetVerdictLabels[finding.decision.verdict]}`
              : finding.status}</span
          ></button
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
          {#if citation.reference}
            {@const reference = citation.reference}
            <p class="muted">{reference.title} · {reference.document}, {reference.edition}</p>
            {#if Schema.is(ReviewSourceUrl)(reference.url)}<button
                class="btn"
                onclick={() => onOpenSource(reference.url)}
                >{reference.access === "open_in_browser"
                  ? "Open section to confirm"
                  : "Open section in browser"}</button
              >{/if}{/if}
        </section>{/each}{#each review.sources as source (source.id)}<p class="muted">
          {source.title || source.url} · {source.status}{source.official
            ? " · official source"
            : ""}
        </p>
        <section class="source-record">
          <p>{source.url}</p>
          <p class="muted">Retrieved {new Date(source.retrievedAt).toLocaleString()}</p>
          {#if Schema.is(ReviewSourceUrl)(source.url)}<button
              class="btn"
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
      {#if review.jurisdictionLeads}{@const leads = review.jurisdictionLeads}
        <p class="muted" data-testid="jurisdiction-leads">
          {leads.reviews.length === 0
            ? "No earlier review in this workspace matched the jurisdiction."
            : `Earlier reviews in this jurisdiction: ${leads.reviews.map((item) => `${item.projectName} (same ${item.match === "locality" ? "county or city" : "state"})`).join(", ")}. Offered as leads, not evidence: ${leads.sources} sources, ${leads.citations} citations, ${leads.editions} code editions, ${leads.agencyComments} agency comments.`}
        </p>{/if}
      {#if review.firmChecklist}<p class="muted" data-testid="firm-checklist-applied">
          Firm checklist revision {review.firmChecklist.revision} applied to this review.
        </p>{/if}
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
                  class="btn"
                  disabled={currentPage === 0}
                  onclick={() => (coveragePage = currentPage - 1)}>Previous records</button
                >
                <span>Page {currentPage + 1} of {pages}</span>
                <button
                  class="btn"
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
          : ` of the optional ${review.maxCalls}-call budget`}{cachedShare === null
          ? ""
          : ` · ${Math.round(cachedShare * 100)}% of prompt tokens cached`} · {review.promptVersion}{review.preset
          ? ` · ${review.preset}`
          : ""}
      </p>
    </div>
  </details>
</section>

<style>
  .packet-review {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-lg) var(--space-lg);
    margin: 20px 0 28px;
    color: var(--color-text);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    font-size: var(--text-body-sm);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    margin: 0 calc(var(--space-lg) * -1) var(--space-md);
    padding: var(--space-md) var(--space-lg);
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-title-md);
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-body-md);
    font-weight: 600;
    margin: var(--space-lg) 0 var(--space-xs);
  }
  h4 {
    font-size: var(--text-body-sm);
    font-weight: 600;
    margin: var(--space-sm) 0 4px;
  }
  p {
    line-height: var(--leading-relaxed);
    margin: 6px 0;
  }
  .summary,
  li,
  small {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .scope,
  .muted,
  .progress {
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  .scope {
    margin: 2px 0 0;
    text-transform: capitalize;
  }
  .duration {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .progress {
    margin-top: 0;
  }
  .stage-line {
    font-size: var(--text-mono-sm);
  }
  .budget-extension {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-xs);
    flex-basis: 100%;
  }
  .budget-extension label {
    display: grid;
    gap: 6px;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .budget-extension input {
    width: 130px;
  }
  .budget-extension p {
    flex-basis: 100%;
    margin-top: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
    margin-top: var(--space-md);
  }
  .coverage-table-scroll:focus-visible {
    box-shadow: var(--shadow-focus-ring);
  }
  .attention,
  .missing {
    border-left: 2px solid var(--color-accent);
    padding-left: var(--space-sm);
  }
  .attention {
    color: var(--color-error);
    border-left-color: var(--color-error);
  }
  .missing h3 {
    margin-top: var(--space-sm);
  }
  ul {
    margin: 6px 0;
    padding-left: 20px;
  }
  li {
    font-size: var(--text-body-sm);
    line-height: var(--leading-relaxed);
  }
  .findings > h3 span {
    min-width: 20px;
    height: 20px;
    display: inline-grid;
    place-items: center;
    padding: 0 4px;
    border-radius: var(--radius-sm);
    background: var(--color-slate);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
  }
  .finding {
    display: flex;
    width: 100%;
    text-align: left;
    border: 0;
    border-top: 1px solid var(--color-border);
    border-radius: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px var(--space-sm);
    padding: var(--space-sm) var(--space-xs);
    background: transparent;
    color: var(--color-text);
    transition: background var(--duration-fast) var(--ease-out);
  }
  .finding:hover {
    background: var(--color-wash);
  }
  .finding::after {
    content: "";
    order: 3;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    background: var(--color-text-muted);
    -webkit-mask: var(--icon-chevron-right) center / 16px 16px no-repeat;
    mask: var(--icon-chevron-right) center / 16px 16px no-repeat;
  }
  .finding strong {
    order: 1;
    flex: 1;
    min-width: 120px;
    font-size: var(--text-body-sm);
    font-weight: 500;
  }
  .severity,
  .finding-status {
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .severity {
    order: 0;
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
  }
  .severity[data-severity="Critical"] {
    border-color: var(--color-error);
    color: var(--color-error);
  }
  .finding-status {
    order: 2;
    color: var(--color-text-muted);
  }
  .finding:is(
      [data-decision="false_alarm"],
      [data-decision="not_applicable"],
      [data-decision="duplicate"]
    )
    strong {
    color: var(--color-text-muted);
    text-decoration: line-through;
  }
  .records {
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-sm);
    margin-top: var(--space-md);
    font-size: var(--text-body-sm);
  }
  .records > summary,
  .coverage > summary {
    font-size: var(--text-body-sm);
    font-weight: 500;
  }
  .records p,
  blockquote {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .records blockquote {
    margin: 10px 0;
    padding-left: var(--space-sm);
    border-left: 2px solid var(--color-border-strong);
    color: var(--color-text-muted);
  }
  .coverage {
    margin-top: var(--space-md);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-sm);
    font-size: var(--text-mono-sm);
  }
  .sheet-coverage {
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border);
  }
  .sheet-coverage summary {
    flex-wrap: wrap;
    line-height: var(--leading-relaxed);
    color: var(--color-text);
  }
  .coverage-table-scroll {
    overflow-x: auto;
    margin: var(--space-md) 0;
  }
  .discipline-coverage {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .discipline-coverage caption {
    text-align: left;
    font-weight: 600;
    margin-bottom: var(--space-xs);
  }
  .discipline-coverage th,
  .discipline-coverage td {
    border-bottom: 1px solid var(--color-border);
    padding: var(--space-xs);
    text-align: right;
    white-space: nowrap;
  }
  .discipline-coverage td {
    font-family: var(--font-mono);
    letter-spacing: var(--tracking-wide);
  }
  .discipline-coverage thead th {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .discipline-coverage tbody tr:hover > * {
    background: var(--color-wash);
  }
  .discipline-coverage th:first-child {
    text-align: left;
    padding-left: 0;
  }
  .discipline-coverage tbody th {
    font-weight: 500;
  }
  .coverage-filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
    margin: 0;
    border: 0;
  }
  .coverage-filters legend {
    padding: 0 0 var(--space-xs);
    font-weight: 600;
  }
  .coverage-filter {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .coverage-filter label {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .coverage-filters select,
  .coverage-filters input[type="search"] {
    width: 100%;
    min-width: 0;
  }
  .coverage-filters .earlier-coverage {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    grid-column: 1 / -1;
    font-size: var(--text-body-sm);
  }
  .coverage-list .sheet-counts {
    margin: 10px 0;
  }
  .coverage-record {
    padding: 6px 0;
    border-top: 1px solid var(--color-border);
  }
  .coverage-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
    margin-top: 10px;
  }
  .coverage-pagination span {
    font-family: var(--font-mono);
    letter-spacing: var(--tracking-wide);
    color: var(--color-text-muted);
  }
  .source-record {
    overflow-wrap: anywhere;
  }
  .coverage-list section {
    margin-top: var(--space-sm);
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
    gap: 6px var(--space-md);
    margin: 4px 0 var(--space-sm);
  }
  .configuration dt {
    color: var(--color-text-muted);
  }
  .configuration dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .coverage-list small {
    flex-basis: 100%;
    color: var(--color-text-muted);
  }
</style>
