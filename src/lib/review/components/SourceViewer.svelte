<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Affine, Region } from "#lib/review/contracts.ts";
  import { transformRegion } from "#lib/review/geometry.ts";
  import ReviewIcon from "./ReviewIcon.svelte";

  let {
    imageUrl,
    pdfToPixels,
    overlays = [],
    label = "Source view",
  }: {
    imageUrl: string;
    pdfToPixels: typeof Affine.Type;
    overlays?: ReadonlyArray<{ region: Region; title: string }>;
    label?: string;
  } = $props();

  let scale = $state(1);
  let rotation = $state(0);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;
  let viewport: HTMLDivElement | undefined = $state();

  const transformStyle = $derived(
    `translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${scale})`,
  );

  const pixelOverlays = $derived(
    overlays.map((overlay) => ({
      title: overlay.title,
      region: transformRegion(pdfToPixels, overlay.region),
    })),
  );

  function zoom(delta: number) {
    scale = Math.min(4, Math.max(0.25, scale + delta));
  }

  function resetView() {
    scale = 1;
    rotation = 0;
    panX = 0;
    panY = 0;
  }

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    // SAFETY: pointer handlers are registered on the viewport div element.
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent) {
    dragging = false;
    // SAFETY: pointer handlers are registered on the viewport div element.
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  onDestroy(() => {
    if (imageUrl.startsWith("blob:")) URL.revokeObjectURL(imageUrl);
  });
</script>

<section class="viewer" aria-label={label}>
  <div class="viewer-toolbar">
    <button type="button" class="icon-button" aria-label="Zoom in" onclick={() => zoom(0.2)}
      ><ReviewIcon name="zoom-in" size={16} /></button
    >
    <button type="button" class="icon-button" aria-label="Zoom out" onclick={() => zoom(-0.2)}
      ><ReviewIcon name="zoom-out" size={16} /></button
    >
    <button
      type="button"
      class="icon-button"
      aria-label="Rotate clockwise"
      onclick={() => {
        rotation = (rotation + 90) % 360;
      }}><ReviewIcon name="rotate-clockwise" size={16} /></button
    >
    <button type="button" class="icon-button" aria-label="Reset view" onclick={resetView}
      ><ReviewIcon name="refresh" size={16} /></button
    >
  </div>
  <div
    class="viewport"
    role="application"
    aria-label="Pan and zoom source canvas"
    bind:this={viewport}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    <div class="transform-layer" style={`transform: ${transformStyle}`}>
      <img src={imageUrl} alt="" draggable="false" />
      {#each pixelOverlays as overlay, index (index)}
        <div
          class="overlay"
          style={`left:${overlay.region.x}px;top:${overlay.region.y}px;width:${overlay.region.width}px;height:${overlay.region.height}px`}
          title={overlay.title}
        ></div>
      {/each}
    </div>
  </div>
</section>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    flex: 1;
  }
  .viewer-toolbar {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: var(--nd-raised);
    color: var(--nd-ink-muted);
    cursor: pointer;
  }
  .icon-button:hover {
    background: var(--nd-raised-hover);
    color: var(--nd-ink);
  }
  .viewport {
    position: relative;
    flex: 1;
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    background: #0d0d0d;
    touch-action: none;
    cursor: grab;
  }
  .viewport:active {
    cursor: grabbing;
  }
  .transform-layer {
    position: relative;
    transform-origin: center center;
    display: inline-block;
  }
  .transform-layer img {
    display: block;
    max-width: none;
    user-select: none;
  }
  .overlay {
    position: absolute;
    border: 2px solid #f5a623;
    background: rgb(245 166 35 / 0.12);
    pointer-events: none;
    box-sizing: border-box;
  }
</style>
