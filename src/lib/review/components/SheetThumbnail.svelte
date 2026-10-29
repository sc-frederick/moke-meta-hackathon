<script lang="ts">
  import type { Sheet } from "#lib/review/contracts.ts";

  let {
    sheet,
    loadThumbnail,
  }: {
    sheet: Sheet;
    loadThumbnail: (sheet: Sheet) => Promise<string | null>;
  } = $props();

  let imageUrl = $state<string | null>(null);

  function observe(element: HTMLElement) {
    let disposed = false;
    let ownedUrl: string | null = null;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void loadThumbnail(sheet).then((url) => {
        if (disposed) {
          if (url?.startsWith("blob:")) URL.revokeObjectURL(url);

          return;
        }

        ownedUrl = url;
        imageUrl = url;
      });
    });

    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();

      if (ownedUrl?.startsWith("blob:")) URL.revokeObjectURL(ownedUrl);
    };
  }
</script>

<span class="thumbnail" {@attach observe}>
  {#if imageUrl}<img src={imageUrl} alt="" loading="lazy" />{:else}<span aria-hidden="true"
      >{sheet.pageIndex + 1}</span
    >{/if}
</span>

<style>
  .thumbnail {
    width: var(--sheet-thumbnail-width, 32px);
    height: var(--sheet-thumbnail-height, 40px);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: 1px solid var(--nd-hairline);
    background: var(--nd-raised);
    color: var(--nd-ink-muted);
    border-radius: 3px;
    overflow: hidden;
    font-size: 11px;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: white;
  }
</style>
