<script lang="ts">
  import { Option, Schema } from "effect";
  import type { Sheet } from "#lib/review/contracts.ts";
  import { ReviewDiscipline, reviewDisciplines } from "#lib/review/disciplines.ts";
  import { sheetCaption } from "./review-format.ts";
  import SheetThumbnail from "./SheetThumbnail.svelte";

  let {
    sheets,
    busy,
    createOpen = $bindable(false),
    onConfirm,
    onAssign,
    selectedIds = $bindable([]),
    onPreview,
    onCreate,
    loadThumbnail,
  }: {
    sheets: ReadonlyArray<Sheet>;
    busy: boolean;
    createOpen?: boolean;
    selectedIds?: ReadonlyArray<Sheet["id"]>;
    onAssign: (
      ids: ReadonlyArray<Sheet["id"]>,
      discipline: typeof ReviewDiscipline.Type | null,
    ) => Promise<void>;
    onConfirm: (sheet: Sheet, label: string, coverage: Sheet["coverage"]) => Promise<void>;
    onPreview: (sheet: Sheet) => void;
    loadThumbnail?: (sheet: Sheet) => Promise<string | null>;
    onCreate: (input: {
      title: string;
      objectClass: string;
      drawnSheetId: string;
      scheduledSheetId: string;
      applicabilityConfirmed: boolean;
    }) => Promise<boolean>;
  } = $props();

  const confirmed = $derived(sheets.filter((sheet) => sheet.confirmed));
  let title = $state("");
  let objectClass = $state("");
  let drawnSheetId = $state("");
  let scheduledSheetId = $state("");
  let applicabilityConfirmed = $state(false);
  let query = $state("");

  const filteredSheets = $derived(
    sheets.filter((sheet) =>
      `${sheet.label} ${sheet.discipline ?? "unassigned"} page ${sheet.pageIndex + 1}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ),
  );

  function focusCheckName(element: HTMLInputElement) {
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
  }

  const Confirmation = Schema.Struct({
    label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    coverage: Schema.Literals(["unreviewed", "partial", "reviewer_complete"]),
  });
</script>

<section class="sheet-setup" aria-label="Project sheets">
  <div class="section-heading">
    <h2>Project sheets</h2>
    <span>{sheets.length} {sheets.length === 1 ? "sheet" : "sheets"}</span>
  </div>
  <p class="muted">
    Assign disciplines to focus a review, or review the whole set. No sheet confirmation is needed
    for document review.
  </p>
  {#if sheets.length === 0}<p>
      Import a drawing PDF to begin. Earlier revisions stay in the project.
    </p>
  {:else}
    <label class="sheet-search"
      >Find a sheet<input
        type="search"
        placeholder="Sheet number, title, discipline or page"
        bind:value={query}
      /></label
    >
    <div class="bulk-actions">
      <label class="checkbox"
        ><input
          type="checkbox"
          aria-label="Select all sheets"
          checked={filteredSheets.length > 0 &&
            filteredSheets.every((sheet) => selectedIds.includes(sheet.id))}
          onchange={(event) => {
            const visibleIds = new Set(filteredSheets.map((sheet) => sheet.id));
            selectedIds = event.currentTarget.checked
              ? [...new Set([...selectedIds, ...visibleIds])]
              : selectedIds.filter((id) => !visibleIds.has(id));
          }}
        />Select all</label
      >
      <span>{selectedIds.length} selected</span>
      <select
        aria-label="Assign selected sheets to discipline"
        disabled={busy || selectedIds.length === 0}
        value=""
        onchange={async (event) => {
          const select = event.currentTarget;
          const value = select.value;
          if (value)
            await onAssign(
              selectedIds,
              value === "unassigned" ? null : Schema.decodeUnknownSync(ReviewDiscipline)(value),
            );
          select.value = "";
        }}
      >
        <option value="">Assign discipline…</option><option value="unassigned">Unassigned</option>
        {#each reviewDisciplines as discipline (discipline.id)}<option value={discipline.id}
            >{discipline.label}</option
          >{/each}
      </select>
    </div>
    <ul class="sheet-list" data-testid="sheet-list">
      {#each filteredSheets as sheet (sheet.id)}
        <li>
          <div class="sheet-row" class:with-thumbnail={loadThumbnail !== undefined}>
            <input
              type="checkbox"
              aria-label={`Select ${sheet.label}`}
              checked={selectedIds.includes(sheet.id)}
              onchange={(event) => {
                selectedIds = event.currentTarget.checked
                  ? [...selectedIds, sheet.id]
                  : selectedIds.filter((id) => id !== sheet.id);
              }}
            />
            {#if loadThumbnail}<button
                class="thumbnail-button"
                type="button"
                disabled={busy}
                aria-label={`Preview ${sheet.label}`}
                onclick={() => onPreview(sheet)}><SheetThumbnail {sheet} {loadThumbnail} /></button
              >{/if}
            <span class="sheet-identity" title={sheetCaption(sheet)}
              ><strong>{sheet.label}</strong><small
                >Original PDF page {sheet.pageIndex + 1}{!sheet.confirmed
                  ? " · label unverified"
                  : ""}</small
              ></span
            >
            <select
              aria-label={`Discipline for ${sheet.label}`}
              value={sheet.discipline ?? ""}
              disabled={busy}
              onchange={(event) =>
                onAssign(
                  [sheet.id],
                  event.currentTarget.value
                    ? Schema.decodeUnknownSync(ReviewDiscipline)(event.currentTarget.value)
                    : null,
                )}
            >
              <option value="">Unassigned</option
              >{#each reviewDisciplines as discipline (discipline.id)}<option value={discipline.id}
                  >{discipline.label}</option
                >{/each}
            </select>
            <button type="button" disabled={busy} onclick={() => onPreview(sheet)}
              >View sheet</button
            >
          </div>
          <details>
            <summary>Label &amp; count-check verification</summary>
            <form
              onsubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const result = Schema.decodeUnknownOption(Confirmation)({
                  label: data.get("label"),
                  coverage: data.get("coverage"),
                });
                if (Option.isSome(result))
                  await onConfirm(sheet, result.value.label, result.value.coverage);
              }}
            >
              <label
                >Sheet label<input
                  name="label"
                  value={sheet.label}
                  required
                  maxlength="160"
                /></label
              >
              <p class="muted">
                Only for verified count comparisons. Discipline assignment does not confirm source
                coverage.
              </p>
              <label
                >Count-check coverage<select name="coverage" value={sheet.coverage}
                  ><option value="unreviewed">Not reviewed yet</option><option value="partial"
                    >Part of the sheet</option
                  ><option value="reviewer_complete">The whole sheet</option></select
                ></label
              >
              <button type="submit" disabled={busy} data-testid={`confirm-sheet-${sheet.id}`}
                >{sheet.confirmed
                  ? "Update verification"
                  : "Confirm sheet for count checks"}</button
              >
            </form>
          </details>
        </li>
      {/each}
    </ul>
    {#if filteredSheets.length === 0}<p role="status">No sheets match “{query}”.</p>{/if}
  {/if}
  {#if createOpen}
    <form
      class="scope-form"
      data-testid="create-finding-form"
      onsubmit={async (event) => {
        event.preventDefault();
        const created = await onCreate({
          title: title.trim(),
          objectClass: objectClass.trim(),
          drawnSheetId,
          scheduledSheetId,
          applicabilityConfirmed,
        });
        if (created) {
          createOpen = false;
          title = "";
          objectClass = "";
          applicabilityConfirmed = false;
        }
      }}
    >
      <h2>New count check</h2>
      <p class="muted">
        Choose one object type and a bounded room or area. MOKE compares its drawn and scheduled
        counts.
      </p>
      <label
        >Check name<input
          {@attach focusCheckName}
          bind:value={title}
          required
          maxlength="160"
          placeholder="Room 101 · type A lighting"
        /></label
      >
      <label
        >What are you counting?<input
          bind:value={objectClass}
          required
          maxlength="160"
          placeholder="Type A luminaires within Room 101 only"
        /></label
      >
      <label
        >Drawing sheet<select bind:value={drawnSheetId} required
          ><option value="">Choose confirmed sheet…</option
          >{#each confirmed as sheet (sheet.id)}<option value={sheet.id}>{sheet.label}</option
            >{/each}</select
        ></label
      >
      <label
        >Schedule sheet<select bind:value={scheduledSheetId} required
          ><option value="">Choose confirmed sheet…</option
          >{#each confirmed as sheet (sheet.id)}<option value={sheet.id}>{sheet.label}</option
            >{/each}</select
        ></label
      >
      <label class="checkbox"
        ><input type="checkbox" bind:checked={applicabilityConfirmed} required />Both sources apply
        to the same items and area</label
      >
      {#if confirmed.length === 0}<p class="muted">
          Confirm at least one source sheet above first.
        </p>{/if}
      <div class="actions">
        <button type="button" onclick={() => (createOpen = false)}>Cancel</button><button
          class="primary"
          type="submit"
          data-testid="create-finding-submit"
          disabled={busy || confirmed.length === 0}>Create check</button
        >
      </div>
    </form>
  {/if}
</section>

<style>
  .sheet-setup {
    display: grid;
    gap: 14px;
    font-size: 13px;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  .muted,
  .section-heading span {
    color: var(--nd-ink-muted);
  }
  .bulk-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .sheet-row {
    display: grid;
    grid-template-columns: 18px minmax(90px, 1fr) minmax(130px, 180px) auto;
    gap: 10px;
    align-items: center;
    padding: 4px 0;
  }
  .sheet-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-identity {
    display: grid;
    gap: 3px;
  }
  .sheet-identity strong {
    font-weight: 500;
  }
  .sheet-identity small {
    color: var(--nd-ink-muted);
    font-size: 11px;
  }
  .sheet-row select,
  .sheet-row button {
    padding: 6px 8px;
  }
  .sheet-row.with-thumbnail {
    grid-template-columns: 18px 32px minmax(90px, 1fr) minmax(110px, 150px) auto;
  }
  .sheet-row .thumbnail-button {
    padding: 0;
    border: 0;
    background: transparent;
  }
  @media (max-width: 720px) {
    .sheet-row,
    .sheet-row.with-thumbnail {
      grid-template-columns: 18px minmax(0, 1fr) auto;
    }
    .sheet-row.with-thumbnail .thumbnail-button {
      display: none;
    }
    .sheet-row select {
      grid-column: 2;
      grid-row: 2;
    }
    .sheet-row > button:last-child {
      grid-column: 3;
      grid-row: 1 / 3;
    }
  }
  .sheet-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0;
  }
  .sheet-list li {
    border-bottom: 1px solid var(--nd-hairline);
    padding: 4px 0;
  }
  details {
    color: var(--nd-ink-muted);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    min-height: 26px;
    padding: 2px 0 6px;
    font-size: 11px;
  }
  form {
    display: grid;
    gap: 12px;
    padding: 12px;
  }
  .scope-form {
    border-top: 1px solid var(--nd-hairline);
    padding: 20px 0 0;
  }
  label {
    display: grid;
    gap: 6px;
    line-height: 1.5;
  }
  input,
  select,
  button {
    font: inherit;
    color: inherit;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    padding: 8px 10px;
    min-width: 0;
    background: var(--nd-shell);
  }
  .checkbox {
    display: flex;
    align-items: start;
    gap: 8px;
  }
  .checkbox input {
    margin-top: 3px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
  button {
    background: var(--nd-raised);
    cursor: pointer;
  }
  button.primary {
    background: var(--nd-ink);
    color: var(--nd-shell);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
