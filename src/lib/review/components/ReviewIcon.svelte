<script lang="ts">
  import { reviewIconPaths, type ReviewIconName } from "#lib/review/icons.ts";

  let {
    name,
    size = 16,
    stroke = 1.6,
  }: {
    name: ReviewIconName;
    size?: number;
    stroke?: number;
  } = $props();
</script>

<svg
  class="review-icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  >{#each reviewIconPaths[name] as d (d)}<path {d} />{/each}</svg
>

<style>
  .review-icon {
    display: inline-block;
    flex-shrink: 0;
    vertical-align: middle;
  }
</style>
