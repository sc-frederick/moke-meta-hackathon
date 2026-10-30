<script lang="ts">
  import {
    packetVerdictLabels,
    type PacketFinding,
    type PacketFindingVerdict,
  } from "#lib/review/packet.ts";
  import ReviewSelect from "./ReviewSelect.svelte";

  type Verdict = typeof PacketFindingVerdict.Type;

  let {
    decision,
    disabled = false,
    onSave,
  }: {
    decision: (typeof PacketFinding.Type)["decision"];
    disabled?: boolean;
    onSave: (decision: { verdict: Verdict; reason: string } | null) => Promise<void>;
  } = $props();

  const id = $props.id();

  // Drafts start from the saved decision and reset to it after each save.
  let verdict = $derived<Verdict | "">(decision?.verdict ?? "");
  let reason = $derived(decision?.reason ?? "");

  const changed = $derived(
    verdict !== (decision?.verdict ?? "") || reason.trim() !== (decision?.reason ?? ""),
  );

  const options = [
    { value: "", label: "Not decided" },
    ...Object.entries(packetVerdictLabels).map(([value, label]) => ({ value, label })),
  ];

  function isVerdict(value: string): value is Verdict {
    return Object.hasOwn(packetVerdictLabels, value);
  }
</script>

<fieldset class="finding-decision" data-testid="finding-decision">
  <legend>Your decision</legend>
  <ReviewSelect
    label="Decision"
    value={verdict}
    {options}
    {disabled}
    onChange={(value) => (verdict = isVerdict(value) ? value : "")}
  />
  {#if verdict !== ""}<label class="sr-only" for={`${id}-reason`}>Reason</label><textarea
      id={`${id}-reason`}
      rows="3"
      maxlength="2000"
      placeholder={verdict === "valid"
        ? "Optional note"
        : "Why? Follow-up reviews read this before raising the issue again."}
      {disabled}
      bind:value={reason}></textarea>{/if}
  <div class="decision-actions">
    <button
      type="button"
      class="save"
      disabled={disabled || !changed}
      onclick={() => onSave(verdict === "" ? null : { verdict, reason: reason.trim() })}
      >Save decision</button
    >
    {#if decision && !changed}<span class="muted"
        >Saved {new Date(decision.decidedAt).toLocaleString()}</span
      >{/if}
  </div>
</fieldset>

<style>
  .finding-decision {
    display: grid;
    gap: 8px;
    margin: 14px 0;
    padding: 12px 0 0;
    border: 0;
    border-top: 1px solid var(--nd-hairline);
  }
  legend {
    padding: 0;
    font-size: 12px;
    color: var(--nd-ink-muted);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    background: var(--nd-shell);
    color: var(--nd-ink);
    padding: 8px 10px;
    font-size: 13px;
    line-height: 1.5;
  }
  .decision-actions {
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
