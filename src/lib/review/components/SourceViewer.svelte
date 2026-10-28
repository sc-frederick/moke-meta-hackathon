<script lang="ts">
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
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let imageWidth = $state(1);
  let imageHeight = $state(1);

  const transformStyle = $derived(
    `translate(${viewportWidth / 2 + panX}px, ${viewportHeight / 2 + panY}px) rotate(${rotation}deg) scale(${scale}) translate(${-imageWidth / 2}px, ${-imageHeight / 2}px)`,
  );

  const pixelOverlays = $derived(
    overlays.map((overlay) => ({
      title: overlay.title,
      region: transformRegion(pdfToPixels, overlay.region),
    })),
  );

  function zoom(delta: number) {
    scale = Math.min(8, Math.max(0.02, scale * (delta > 0 ? 1.25 : 0.8)));
  }

  function resetView() {
    scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight) * 0.95;
    rotation = 0;
    panX = 0;
    panY = 0;
  }

  function onPointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    dragging = false;
    const element = event.currentTarget;

    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  }
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
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The image canvas supports focusable keyboard pan and zoom.) -->
  <div
    class="viewport"
    role="application"
    aria-label="Pan and zoom source canvas"
    tabindex="0"
    bind:clientWidth={viewportWidth}
    bind:clientHeight={viewportHeight}
    onkeydown={(event) => {
      if (event.key === "+" || event.key === "=") zoom(0.2);
      else if (event.key === "-") zoom(-0.2);
      else if (event.key === "ArrowLeft") panX += 24;
      else if (event.key === "ArrowRight") panX -= 24;
      else if (event.key === "ArrowUp") panY += 24;
      else if (event.key === "ArrowDown") panY -= 24;
      else return;
      event.preventDefault();
    }}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    <div class="transform-layer" style={`transform: ${transformStyle}`}>
      <img
        src={imageUrl}
        alt=""
        draggable="false"
        onload={(event) => {
          if (!(event.currentTarget instanceof HTMLImageElement)) return;
          imageWidth = event.currentTarget.naturalWidth;
          imageHeight = event.currentTarget.naturalHeight;
          resetView();
        }}
      />
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
    flex: 0 0 300px;
    height: 300px;
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
    transform-origin: 0 0;
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
