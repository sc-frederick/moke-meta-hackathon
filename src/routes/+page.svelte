<script lang="ts">
  import { onMount } from "svelte";
  import { createNotesClient } from "#lib/notes-client.ts";
  import type { Note } from "#lib/notes.ts";

  let notes = $state.raw<ReadonlyArray<Note>>([]);
  let text = $state("");
  let error = $state("");
  let ready = $state(false);
  let saving = $state(false);
  let client: ReturnType<typeof createNotesClient> | undefined;

  onMount(() => {
    const controller = new AbortController();
    const current = createNotesClient();
    client = current;

    void current.list(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      notes = result.notes;
      error = result.error;
      ready = true;
    });

    return () => {
      controller.abort();
      void current.dispose();
    };
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const current = client;

    if (current === undefined || saving) return;

    saving = true;
    const result = await current.add(text.trim());
    error = result.error;

    if (result.note !== undefined) {
      notes = [result.note, ...notes];
      text = "";
    }

    saving = false;
  }
</script>

<svelte:head><title>Notes</title></svelte:head>

<main>
  <h1>Notes</h1>
  <form onsubmit={save}>
    <label for="note">New note</label>
    <input id="note" bind:value={text} maxlength="2000" required />
    <button type="submit" disabled={!ready || saving}>{saving ? "Saving…" : "Save note"}</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if !ready}<p role="status">Loading notes…</p>{/if}
  <ul aria-label="Saved notes">
    {#each notes as note (note.id)}<li>{note.text}</li>{/each}
  </ul>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    color: #202124;
    background: #fafafa;
  }
  main {
    max-width: 44rem;
    margin: 3rem auto;
    padding: 0 1.5rem;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  input,
  button {
    font: inherit;
    padding: 0.6rem;
  }
  input {
    flex: 1;
    min-width: 10rem;
  }
  li {
    margin-block: 0.75rem;
    overflow-wrap: anywhere;
  }
</style>
