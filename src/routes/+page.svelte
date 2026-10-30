<script lang="ts">
  import { onMount } from "svelte";
  import { createReviewClient } from "#lib/review/client.ts";
  import ReviewWorkbench from "#lib/review/components/ReviewWorkbench.svelte";

  let client = $state.raw<ReturnType<typeof createReviewClient> | undefined>();

  onMount(() => {
    const current = createReviewClient();
    client = current;

    return () => {
      void current.dispose();
    };
  });
</script>

<svelte:head><title>MOKE review</title></svelte:head>

{#if client}
  <ReviewWorkbench {client} />
{:else}
  <main class="boot" role="status">Starting review workbench…</main>
{/if}

<style>
  .boot {
    min-height: 100vh;
    display: grid;
    place-items: center;
    color: var(--color-text-muted);
    font-size: var(--text-body-sm);
  }
</style>
