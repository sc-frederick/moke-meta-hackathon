<script lang="ts">
  let { text }: { text: string } = $props();
</script>

{#snippet inline(value: string)}
  {#each value.split(/(\*\*.+?\*\*|`[^`]+`)/g) as part, index (index)}
    {#if part.startsWith("**") && part.endsWith("**")}<strong>{part.slice(2, -2)}</strong>
    {:else if part.startsWith("`") && part.endsWith("`")}<code>{part.slice(1, -1)}</code>
    {:else}{part}{/if}
  {/each}
{/snippet}

<div class="review-text">
  {#each text.split("\n") as line, index (index)}
    {#if /^#{1,6}\s/.test(line)}<h4>{@render inline(line.replace(/^#{1,6}\s+/, ""))}</h4>
    {:else if /^\s*[-*]\s/.test(line)}<p class="list-item">
        <span aria-hidden="true">• </span>{@render inline(line.replace(/^\s*[-*]\s+/, ""))}
      </p>
    {:else if line.trim()}<p>{@render inline(line)}</p>{/if}
  {/each}
</div>

<style>
  .review-text {
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  p {
    margin: 5px 0;
    white-space: pre-wrap;
  }
  h4 {
    font-size: inherit;
    margin: 14px 0 5px;
  }
  .list-item {
    padding-left: 16px;
    text-indent: -12px;
  }
</style>
