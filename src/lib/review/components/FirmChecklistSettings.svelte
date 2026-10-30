<script lang="ts">
  import type { FirmChecklist } from "#lib/review/packet.ts";

  let {
    checklist,
    loaded,
    message = "",
    disabled = false,
    onSave,
  }: {
    checklist: typeof FirmChecklist.Type | null;
    /** False until the saved checklist has been read, so an empty draft cannot replace it. */
    loaded: boolean;
    /** Result of the latest save or load. */
    message?: string;
    disabled?: boolean;
    onSave: (text: string) => Promise<void>;
  } = $props();

  const id = $props.id();

  // The draft starts from the saved checklist and resets to it after each save.
  let draft = $derived(checklist?.text ?? "");
  const changed = $derived(draft.trim() !== (checklist?.text ?? ""));

  const placeholder = [
    "- Every detail callout references a sheet in this set",
    "- Stamp and seal block on every sheet",
    "- General notes match the firm's standard notes, revision 4",
  ].join("\n");
</script>

<section class="settings-section" data-testid="firm-checklist">
  <h3>Firm checklist</h3>
  <p class="muted">
    Checks your firm wants on every review, one per line. New reviews follow them as firm practice:
    a deviation is a recommendation unless a governing source makes it a code issue. Running reviews
    keep the revision they started with.
  </p>
  <label class="sr-only" for={`${id}-text`}>Firm checklist</label><textarea
    id={`${id}-text`}
    rows="7"
    maxlength="12000"
    {placeholder}
    disabled={disabled || !loaded}
    bind:value={draft}></textarea>
  <div class="checklist-actions">
    <button
      type="button"
      class="save"
      disabled={disabled || !loaded || !changed}
      onclick={() => onSave(draft.trim())}>Save checklist</button
    >
    {#if checklist}<span class="muted"
        >Revision {checklist.revision} · saved {new Date(checklist.savedAt).toLocaleString()}</span
      >{/if}
  </div>
  <p class="muted" role="status">{message}</p>
</section>

<style>
  .settings-section {
    display: grid;
    gap: 12px;
    padding: 20px 0;
    border-bottom: 1px solid var(--nd-hairline);
  }
  h3 {
    font-size: 14px;
    margin: 0;
  }
  p {
    font-size: 13px;
    line-height: 1.65;
    margin: 6px 0;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    background: var(--nd-shell);
    color: var(--nd-ink);
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.5;
  }
  .checklist-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
  }
  .save {
    display: inline-flex;
    align-items: center;
    padding: 7px 10px;
    border-radius: 7px;
    border: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
    color: inherit;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .save:not(:disabled):hover {
    background: var(--nd-raised-hover);
  }
  .muted {
    color: var(--nd-ink-muted);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
