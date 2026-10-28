<script lang="ts">
  import { Option, Schema } from "effect";
  import type { Sheet } from "#lib/review/contracts.ts";
  import ReviewIcon from "./ReviewIcon.svelte";
  import { sheetCaption } from "./review-format.ts";

  let {
    sheets,
    busy,
    createOpen = $bindable(false),
    onConfirm,
    onPreview,
    onCreate,
  }: {
    sheets: ReadonlyArray<Sheet>;
    busy: boolean;
    createOpen?: boolean;
    onConfirm: (sheet: Sheet, label: string, coverage: Sheet["coverage"]) => Promise<void>;
    onPreview: (sheet: Sheet) => void;
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

  const Confirmation = Schema.Struct({
    label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    coverage: Schema.Literals(["unreviewed", "partial", "reviewer_complete"]),
  });
</script>

<section class="sheet-setup" aria-label="Sheet confirmation">
  <div class="section-heading">
    <h2>Project sheets</h2>
    <span>{confirmed.length}/{sheets.length} confirmed</span>
  </div>
  <p class="muted">
    Read the sheet before confirming its label and coverage. Importing a PDF does not review it.
  </p>
  {#if sheets.length === 0}
    <p>Import a drawing PDF to begin. Originals and earlier revisions are retained.</p>
  {:else}
    <ul class="sheet-list" data-testid="sheet-list">
      {#each sheets as sheet (sheet.id)}
        <li>
          <details open={!sheet.confirmed}>
            <summary
              ><ReviewIcon name="file-text" size={15} /><span>{sheetCaption(sheet)}</span><span
                class="state">{sheet.confirmed ? "Confirmed" : "Needs review"}</span
              ></summary
            >
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
              <label
                >How much have you checked?<select name="coverage" value={sheet.coverage}>
                  <option value="unreviewed">Not reviewed yet</option>
                  <option value="partial">Part of the sheet</option>
                  <option value="reviewer_complete">The whole sheet</option>
                </select></label
              >
              <div class="actions">
                <button type="button" disabled={busy} onclick={() => onPreview(sheet)}
                  >View sheet</button
                ><button type="submit" disabled={busy} data-testid={`confirm-sheet-${sheet.id}`}
                  >Confirm sheet</button
                >
              </div>
            </form>
          </details>
        </li>
      {/each}
    </ul>
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
        Choose one object type and a bounded room or area. Moke compares its drawn and scheduled
        counts.
      </p>
      <label
        >Check name<input
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
  .section-heading span,
  .state {
    color: var(--nd-ink-muted);
  }
  .sheet-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  details {
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    min-height: 44px;
    padding: 10px;
  }
  summary span:first-of-type {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .state {
    font-size: 12px;
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
