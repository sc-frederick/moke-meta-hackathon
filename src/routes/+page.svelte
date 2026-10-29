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
  :global(body) {
    margin: 0;
  }
  .boot {
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: system-ui, sans-serif;
    background: #141414;
    color: #ededed;
  }
</style>
