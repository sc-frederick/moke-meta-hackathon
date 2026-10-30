<script lang="ts">
  import type { Revision, RevisionCorrespondence, Sheet } from "#lib/review/contracts.ts";
  import ReviewIcon from "./ReviewIcon.svelte";
  import SheetThumbnail from "./SheetThumbnail.svelte";

  type Choice = {
    oldSheetId: string;
    newSheetId: string | null;
    confirmed: boolean;
    content: "changed" | "unchanged" | "removed" | "unresolved";
  };

  let {
    revisions,
    sheets,
    correspondence = [],
    busy,
    onApply,
    loadThumbnail,
  }: {
    revisions: ReadonlyArray<Revision>;
    sheets: ReadonlyArray<Sheet>;
    correspondence?: ReadonlyArray<RevisionCorrespondence>;
    busy: boolean;
    onApply: (revisionId: string, pairs: Array<Choice>) => Promise<void>;
    loadThumbnail?: (sheet: Sheet) => Promise<string | null>;
  } = $props();

  const latest = $derived(revisions.at(-1));
  const previous = $derived(revisions.at(-2));
  const oldSheets = $derived(sheets.filter((sheet) => sheet.revisionId === previous?.id));
  const candidates = $derived(sheets.filter((sheet) => sheet.revisionId === latest?.id));
  const saved = $derived(correspondence.filter((pair) => pair.revisionId === latest?.id));
  let choices = $state<Array<Choice>>([]);
  let previewSheet = $state<Sheet | null>(null);
  let previewDialog = $state<HTMLDialogElement>();

  function savedFor(oldSheetId: string) {
    return (
      saved.find((pair) => pair.oldSheetId === oldSheetId && pair.newSheetId !== null) ??
      saved.find((pair) => pair.oldSheetId === oldSheetId)
    );
  }

  function choiceFor(sheet: Sheet): Choice {
    const draft = choices.find((pair) => pair.oldSheetId === sheet.id);

    if (draft) return draft;
    const persisted = savedFor(sheet.id);

    if (persisted) return persisted;

    const exact =
      latest?.sha256 === previous?.sha256
        ? candidates.find((candidate) => candidate.pageIndex === sheet.pageIndex)
        : undefined;

    return {
      oldSheetId: sheet.id,
      newSheetId: exact?.id ?? null,
      content: exact ? "unchanged" : "unresolved",
      confirmed: false,
    };
  }

  function update(sheet: Sheet, change: Partial<Choice>) {
    choices = [
      ...choices.filter((pair) => pair.oldSheetId !== sheet.id),
      { ...choiceFor(sheet), ...change },
    ];
  }

  const pending = $derived(
    oldSheets.flatMap((sheet) => {
      const persisted = savedFor(sheet.id);

      if (persisted?.newSheetId || persisted?.content === "removed") return [];

      return [choiceFor(sheet)];
    }),
  );

  const hasDecision = $derived(
    pending.some(
      (pair) => pair.confirmed || choices.some((choice) => choice.oldSheetId === pair.oldSheetId),
    ),
  );

  const valid = $derived(pending.every((pair) => pair.content !== "removed" || pair.confirmed));

  const added = $derived(
    candidates.filter(
      (candidate) => !oldSheets.some((sheet) => choiceFor(sheet).newSheetId === candidate.id),
    ),
  );

  // Earlier sheets without a saved match or removal may still correspond to an unmatched new page.
  const openPrior = $derived(
    oldSheets.filter((sheet) => {
      const persisted = savedFor(sheet.id);

      return !persisted?.newSheetId && persisted?.content !== "removed";
    }).length,
  );

  const previewChoice = $derived(previewSheet ? choiceFor(previewSheet) : null);

  const previewReplacement = $derived(
    candidates.find((candidate) => candidate.id === previewChoice?.newSheetId),
  );

  function compare(sheet: Sheet) {
    previewSheet = sheet;
    previewDialog?.showModal();
  }
</script>

{#if latest && previous}
  <section class="revision-mapping" aria-label="Sheet revision mapping">
    <header class="mapping-heading">
      <h3>
        <span>{previous.name}</span><ReviewIcon name="arrow-right" /><span>{latest.name}</span>
      </h3>
      <p>
        Compare each original sheet with its replacement. Confirm retained sheets, mark removed
        sheets, or leave them unresolved for later review.
      </p>
    </header>
    {#if latest.sha256 === previous.sha256}<p class="hint">
        The PDFs are byte-identical. Page matches are proposed below; confirm them before reusing
        evidence.
      </p>{/if}
    <div class="column-headings" aria-hidden="true">
      <span>Previous revision</span><span></span><span>New revision</span><span
        >Review decision</span
      >
    </div>
    <ul class="mapping-list">
      {#each oldSheets as sheet (sheet.id)}
        {@const choice = choiceFor(sheet)}
        {@const persisted = savedFor(sheet.id)}
        {@const locked =
          (persisted?.newSheetId !== null && persisted?.newSheetId !== undefined) ||
          persisted?.content === "removed"}
        {@const replacement = candidates.find((candidate) => candidate.id === choice.newSheetId)}
        <li class="mapping-row" data-testid={`revision-row-${sheet.id}`}>
          <div class="sheet-cell previous-sheet">
            <div class="page-preview" data-testid={`revision-old-preview-${sheet.id}`}>
              {#if loadThumbnail}<button
                  class="preview-button"
                  aria-label={`Preview previous ${sheet.label}`}
                  onclick={() => compare(sheet)}><SheetThumbnail {sheet} {loadThumbnail} /></button
                >{:else}<span class="page-number" aria-hidden="true">{sheet.pageIndex + 1}</span
                >{/if}
            </div>
            <div class="sheet-meta">
              <strong>{sheet.label}</strong>
              <small>Original · page {sheet.pageIndex + 1}</small>
            </div>
          </div>
          <span class="mapping-arrow"><ReviewIcon name="arrow-right" /></span>
          <div class="sheet-cell new-sheet">
            <div class="page-preview" data-testid={`revision-new-preview-${sheet.id}`}>
              {#if replacement}
                {#if loadThumbnail}<button
                    class="preview-button"
                    aria-label={`Preview new ${replacement.label}`}
                    onclick={() => compare(sheet)}
                    >{#key replacement.id}<SheetThumbnail
                        sheet={replacement}
                        {loadThumbnail}
                      />{/key}</button
                  >{:else}<span class="page-number" aria-hidden="true"
                    >{replacement.pageIndex + 1}</span
                  >{/if}
              {:else}<span class="no-page" aria-hidden="true"
                  >{choice.content === "removed" ? "−" : "?"}</span
                >{/if}
            </div>
            <div class="sheet-meta">
              {#if locked}
                <strong>{replacement?.label ?? "Removed"}</strong>
                <small
                  >{replacement
                    ? `New · page ${replacement.pageIndex + 1}`
                    : "No replacement page"}</small
                >
              {:else}
                <label
                  >New sheet<select
                    value={choice.newSheetId ?? choice.content}
                    disabled={busy}
                    data-testid={`revision-map-${sheet.id}`}
                    onchange={(event) => {
                      const value = event.currentTarget.value;
                      update(
                        sheet,
                        value === "removed" || value === "unresolved"
                          ? { newSheetId: null, content: value, confirmed: false }
                          : { newSheetId: value, content: "changed", confirmed: false },
                      );
                    }}
                  >
                    <option value="unresolved">Unresolved — decide later</option>
                    <option value="removed">Removed from revision</option>
                    {#each candidates as candidate (candidate.id)}<option value={candidate.id}
                        >{candidate.label} · page {candidate.pageIndex + 1}</option
                      >{/each}
                  </select></label
                >
                <small
                  >{replacement
                    ? `New · page ${replacement.pageIndex + 1}`
                    : choice.content === "removed"
                      ? "No replacement page"
                      : "No page selected"}</small
                >
              {/if}
            </div>
          </div>
          <div class="decision">
            {#if locked}<p class="saved" role="status">
                Saved: {choice.content === "removed"
                  ? "Removed from this revision"
                  : `${replacement?.label ?? "Retained sheet"} · ${choice.content} · confirmed`}
              </p>
            {:else}
              {#if choice.newSheetId}<label
                  >Contents<select
                    disabled={busy}
                    value={choice.content}
                    data-testid={`revision-content-${sheet.id}`}
                    onchange={(event) =>
                      update(sheet, {
                        content:
                          event.currentTarget.value === "unchanged" ? "unchanged" : "changed",
                        confirmed: false,
                      })}
                  >
                    <option value="changed">Changed</option><option value="unchanged"
                      >Unchanged</option
                    >
                  </select></label
                >{/if}
              {#if choice.content !== "unresolved"}<label class="confirmation"
                  ><input
                    type="checkbox"
                    disabled={busy}
                    checked={choice.confirmed}
                    data-testid={`revision-confirm-${sheet.id}`}
                    onchange={(event) => update(sheet, { confirmed: event.currentTarget.checked })}
                  />{choice.content === "removed"
                    ? "I confirmed this sheet was removed"
                    : "Sheet correspondence confirmed"}</label
                >{:else}<p class="unresolved">Unresolved</p>{/if}
              {#if persisted?.content === "unresolved"}<small
                  >Saved as unresolved. Original evidence requires fresh review.</small
                >{:else if choice.content === "unresolved"}<small
                  >Original evidence stays with the previous revision.</small
                >{/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if added.length > 0}
      <section class="added-sheets" aria-label="New pages in this revision">
        <h4>{openPrior === 0 ? "Added in this revision" : "New or unmatched pages"}</h4>
        <p class="hint">
          {openPrior === 0
            ? "Every earlier sheet has a saved decision, so these pages have no predecessor."
            : `${openPrior} earlier ${openPrior === 1 ? "sheet is" : "sheets are"} not yet saved as matched or removed, so these pages may still be replacements. Apply the decisions above to settle them.`}
        </p>
        <ul class="mapping-list">
          {#each added as sheet (sheet.id)}
            <li class="added-row" data-testid={`revision-added-${sheet.id}`}>
              <div class="page-preview">
                {#if loadThumbnail}<SheetThumbnail {sheet} {loadThumbnail} />{:else}<span
                    class="page-number"
                    aria-hidden="true">{sheet.pageIndex + 1}</span
                  >{/if}
              </div>
              <div class="sheet-meta">
                <strong>{sheet.label}</strong>
                <small>New · page {sheet.pageIndex + 1}</small>
              </div>
              <p class="saved">
                {openPrior === 0 ? "Added" : "Unmatched"} · requires fresh review
              </p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <button
      class="btn primary apply-button"
      data-testid="apply-revision"
      disabled={busy || !hasDecision || !valid || pending.length === 0}
      onclick={() => onApply(latest.id, pending)}>Apply revision correspondence</button
    >
    {#if saved.length > 0}<p class="saved" role="status">
        Saved revision decisions are shown above. Confirmed associations are immutable; changed,
        removed and unresolved sources require fresh evidence.
      </p>{/if}
  </section>
  <dialog
    class="comparison-dialog"
    bind:this={previewDialog}
    aria-labelledby="revision-preview-title"
    onclose={() => (previewSheet = null)}
  >
    <header class="comparison-heading">
      <h3 id="revision-preview-title">Compare revision pages</h3>
      <button
        class="icon-btn"
        aria-label="Close page comparison"
        onclick={() => previewDialog?.close()}><ReviewIcon name="x" size={18} /></button
      >
    </header>
    {#if previewSheet}
      <div class="comparison-pages">
        <figure>
          <figcaption>
            <small>Previous revision</small><strong>{previewSheet.label}</strong>
          </figcaption>
          {#if loadThumbnail}<SheetThumbnail sheet={previewSheet} {loadThumbnail} />{/if}
          <small>{previous.name} · page {previewSheet.pageIndex + 1}</small>
        </figure>
        <figure>
          <figcaption>
            <small>New revision</small><strong
              >{previewReplacement?.label ??
                (previewChoice?.content === "removed" ? "Removed" : "Unresolved")}</strong
            >
          </figcaption>
          {#if previewReplacement && loadThumbnail}<SheetThumbnail
              sheet={previewReplacement}
              {loadThumbnail}
            />{:else}<div class="comparison-placeholder">
              {previewChoice?.content === "removed" ? "No replacement page" : "No page selected"}
            </div>{/if}
          <small
            >{latest.name}{previewReplacement
              ? ` · page ${previewReplacement.pageIndex + 1}`
              : ""}</small
          >
        </figure>
      </div>
    {/if}
  </dialog>
{:else}
  <p>
    Import the next revision, then map sheet correspondence. Earlier sources and review history are
    preserved.
  </p>
{/if}

<style>
  .revision-mapping {
    container-type: inline-size;
    display: grid;
    gap: var(--space-sm);
    font-size: var(--text-body-sm);
  }
  .mapping-heading {
    display: grid;
    gap: 4px;
  }
  h3,
  p {
    margin: 0;
    line-height: 1.5;
  }
  h3 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-xs);
    font-family: var(--font-display);
    font-size: var(--text-title-md);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }
  h3 :global(svg) {
    color: var(--color-text-muted);
  }
  .hint,
  small {
    color: var(--color-text-muted);
  }
  small {
    font-size: var(--text-mono-sm);
    line-height: 1.45;
  }
  .column-headings,
  .mapping-row {
    display: grid;
    grid-template-columns: minmax(130px, 1fr) 16px minmax(230px, 1.4fr) minmax(180px, 1fr);
    align-items: center;
    gap: var(--space-sm);
  }
  .column-headings {
    padding: 0 var(--space-sm);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .mapping-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    overflow: hidden;
  }
  .mapping-row {
    padding: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .mapping-row:last-child {
    border-bottom: 0;
  }
  .sheet-cell {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
  }
  .sheet-meta,
  .decision {
    min-width: 0;
    display: grid;
    gap: 6px;
  }
  .new-sheet .sheet-meta {
    flex: 1;
  }
  .page-preview {
    --sheet-thumbnail-width: 56px;
    --sheet-thumbnail-height: 72px;
    flex-shrink: 0;
  }
  .page-number,
  .no-page {
    display: grid;
    place-items: center;
    width: 56px;
    height: 72px;
    box-sizing: border-box;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }
  .no-page {
    border-style: dashed;
    font-size: 20px;
  }
  .mapping-arrow {
    display: grid;
    place-items: center;
    color: var(--color-text-muted);
  }
  strong {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  label {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  select {
    min-width: 0;
    width: 100%;
  }
  .confirmation {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    min-width: 0;
    color: var(--color-text);
    font-family: var(--font-body);
    font-size: var(--text-body-sm);
    letter-spacing: normal;
    text-transform: none;
    line-height: 1.4;
  }
  .saved {
    color: var(--color-text-muted);
  }
  .unresolved {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .preview-button {
    display: block;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    transition: box-shadow var(--duration-fast) var(--ease-out);
  }
  .preview-button:hover {
    box-shadow: 0 0 0 1px var(--color-ember);
  }
  .apply-button {
    justify-self: start;
  }
  .added-sheets {
    display: grid;
    gap: var(--space-xs);
  }
  .added-sheets h4,
  .added-sheets p {
    margin: 0;
  }
  .added-sheets h4 {
    font-size: var(--text-body-md);
    font-weight: 600;
  }
  .added-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .added-row:last-child {
    border-bottom: 0;
  }
  .comparison-dialog {
    width: min(760px, calc(100vw - 48px));
    max-height: calc(100vh - 48px);
    box-sizing: border-box;
    padding: var(--space-lg);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-pop);
  }
  .comparison-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-md);
    margin-bottom: 20px;
    padding-bottom: var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .comparison-pages {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
  }
  figure {
    --sheet-thumbnail-width: min(31vw, 280px);
    --sheet-thumbnail-height: min(40vw, 360px);
    display: grid;
    justify-items: center;
    align-content: start;
    gap: var(--space-sm);
    min-width: 0;
    margin: 0;
    text-align: center;
  }
  figcaption {
    display: grid;
    gap: 4px;
  }
  figcaption small {
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .comparison-placeholder {
    display: grid;
    place-items: center;
    width: var(--sheet-thumbnail-width);
    height: var(--sheet-thumbnail-height);
    box-sizing: border-box;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-sm);
    color: var(--color-text-muted);
  }
  @container (max-width: 740px) {
    .column-headings {
      display: none;
    }
    .mapping-row {
      grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1.4fr);
      gap: 10px;
    }
    .decision {
      grid-column: 3;
      padding-left: 52px;
    }
    .decision select {
      max-width: 180px;
    }
    .sheet-cell {
      gap: var(--space-xs);
    }
    .page-preview {
      --sheet-thumbnail-width: 44px;
      --sheet-thumbnail-height: 58px;
    }
    .page-number,
    .no-page {
      width: 44px;
      height: 58px;
    }
  }
  @container (max-width: 420px) {
    .mapping-row {
      grid-template-columns: minmax(0, 1fr) 12px minmax(0, 1.4fr);
      gap: 6px;
      padding: 10px;
    }
    .sheet-cell {
      flex-direction: column;
      align-items: stretch;
    }
    .page-preview {
      align-self: flex-start;
    }
    .decision {
      padding-left: 0;
    }
  }
</style>
