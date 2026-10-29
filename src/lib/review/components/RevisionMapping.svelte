<script lang="ts">
  import type { Revision, RevisionCorrespondence, Sheet } from "#lib/review/contracts.ts";

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
  }: {
    revisions: ReadonlyArray<Revision>;
    sheets: ReadonlyArray<Sheet>;
    correspondence?: ReadonlyArray<RevisionCorrespondence>;
    busy: boolean;
    onApply: (revisionId: string, pairs: Array<Choice>) => Promise<void>;
  } = $props();

  const latest = $derived(revisions.at(-1));
  const previous = $derived(revisions.at(-2));
  const oldSheets = $derived(sheets.filter((sheet) => sheet.revisionId === previous?.id));
  const candidates = $derived(sheets.filter((sheet) => sheet.revisionId === latest?.id));
  const saved = $derived(correspondence.filter((pair) => pair.revisionId === latest?.id));
  let choices = $state<Array<Choice>>([]);

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
</script>

{#if latest && previous}
  <section class="revision-mapping" aria-label="Sheet revision mapping">
    <h3>{previous.name} → {latest.name}</h3>
    <p>
      Confirm retained sheets or mark them removed. Unresolved sheets stay linked to their original
      evidence and require review.
    </p>
    {#if latest.sha256 === previous.sha256}<p class="hint">
        The PDFs are byte-identical. Page matches are proposed below; confirm them before reusing
        evidence.
      </p>{/if}
    <ul class="mapping-list">
      {#each oldSheets as sheet (sheet.id)}
        {@const choice = choiceFor(sheet)}
        {@const persisted = savedFor(sheet.id)}
        {@const locked =
          (persisted?.newSheetId !== null && persisted?.newSheetId !== undefined) ||
          persisted?.content === "removed"}
        <li>
          <strong>{sheet.label} <small>· original page {sheet.pageIndex + 1}</small></strong>
          {#if locked}<p class="saved" role="status">
              Saved: {choice.content === "removed"
                ? "Removed from this revision"
                : `${candidates.find((candidate) => candidate.id === choice.newSheetId)?.label ?? "Retained sheet"} · ${choice.content} · confirmed`}
            </p>
          {:else}
            <div class="mapping-fields">
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
            </div>
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
              >{/if}
            {#if persisted?.content === "unresolved"}<small
                >Saved as unresolved. Original evidence remains unavailable for automatic reuse.</small
              >{/if}
          {/if}
        </li>
      {/each}
    </ul>
    {#if added.length > 0}<details>
        <summary
          >{added.length}
          {added.length === 1 ? "new or unmatched sheet" : "new or unmatched sheets"}</summary
        >
        <ul>
          {#each added as sheet (sheet.id)}<li>
              {sheet.label} · page {sheet.pageIndex + 1} · requires fresh review
            </li>{/each}
        </ul>
      </details>{/if}
    <button
      data-testid="apply-revision"
      disabled={busy || !hasDecision || !valid || pending.length === 0}
      onclick={() => onApply(latest.id, pending)}>Apply revision correspondence</button
    >
    {#if saved.length > 0}<p class="saved" role="status">
        Saved revision decisions are shown above. Confirmed associations are immutable; changed,
        removed and unresolved sources require fresh evidence.
      </p>{/if}
  </section>
{:else}
  <p>
    Import the next revision, then map sheet correspondence. Earlier sources and review history are
    preserved.
  </p>
{/if}

<style>
  .revision-mapping {
    display: grid;
    gap: 12px;
    font-size: 13px;
  }
  h3,
  p {
    margin: 0;
    line-height: 1.5;
  }
  h3 {
    font-size: 14px;
  }
  .hint,
  small {
    color: var(--nd-ink-muted);
  }
  .mapping-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
  }
  .mapping-list > li {
    display: grid;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--nd-hairline);
  }
  strong {
    font-weight: 500;
  }
  .mapping-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  label {
    display: grid;
    gap: 4px;
    flex: 1;
    min-width: 130px;
  }
  select,
  button {
    font: inherit;
    color: inherit;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    background: var(--nd-shell);
    padding: 7px 8px;
    min-width: 0;
    width: 100%;
  }
  .confirmation {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .confirmation input {
    margin: 0;
  }
  .saved {
    color: var(--nd-ink-muted);
  }
  button {
    cursor: pointer;
    background: var(--nd-raised);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  summary {
    cursor: pointer;
  }
</style>
