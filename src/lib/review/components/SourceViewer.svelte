<script lang="ts">
  import { ReviewInputError, type Affine, type Region, type Sheet } from "#lib/review/contracts.ts";
  import { invertTransform, transformRegion } from "#lib/review/geometry.ts";
  import ReviewIcon from "./ReviewIcon.svelte";

  let {
    imageUrl,
    pdfToPixels,
    overlays = [],
    masks = [],
    label = "Source view",
    selecting = $bindable(false),
    onSelectRegion,
    sheets = [],
    currentSheetId = null,
    onSheet,
    zoomFactor = $bindable(1),
  }: {
    imageUrl: string;
    pdfToPixels: typeof Affine.Type;
    overlays?: ReadonlyArray<{ region: Region; title: string }>;
    /** SAM mask outlines in the displayed image's pixel space. */
    masks?: ReadonlyArray<{ path: string; transform: string }>;
    label?: string;
    selecting?: boolean;
    onSelectRegion?: (region: Region) => void;
    sheets?: ReadonlyArray<Sheet>;
    currentSheetId?: Sheet["id"] | null;
    onSheet?: (sheet: Sheet) => void;
    zoomFactor?: number;
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
  let selection = $state<{ x: number; y: number; width: number; height: number } | null>(null);
  let selectionStart = { x: 0, y: 0 };
  let sheetQuery = $state("");
  const currentIndex = $derived(sheets.findIndex((sheet) => sheet.id === currentSheetId));

  const matchingSheets = $derived(
    sheets.filter((sheet) =>
      `${sheet.label} page ${sheet.pageIndex + 1}`
        .toLowerCase()
        .includes(sheetQuery.trim().toLowerCase()),
    ),
  );

  function moveSheet(direction: -1 | 1) {
    const sheet = sheets[currentIndex + direction];

    if (sheet && currentIndex >= 0) onSheet?.(sheet);
  }

  function imagePoint(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    const bounds = event.currentTarget.getBoundingClientRect();

    const x =
      (event.clientX - bounds.left - event.currentTarget.clientLeft - viewportWidth / 2 - panX) /
      scale;

    const y =
      (event.clientY - bounds.top - event.currentTarget.clientTop - viewportHeight / 2 - panY) /
      scale;

    const angle = (rotation * Math.PI) / 180;

    return {
      x: Math.max(
        0,
        Math.min(imageWidth, x * Math.cos(angle) + y * Math.sin(angle) + imageWidth / 2),
      ),
      y: Math.max(
        0,
        Math.min(imageHeight, -x * Math.sin(angle) + y * Math.cos(angle) + imageHeight / 2),
      ),
    };
  }

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
    const fit = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight) * 0.95;

    if (fit > 0) zoomFactor = scale / fit;
  }

  function resetView() {
    scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight) * 0.95;
    rotation = 0;
    panX = 0;
    panY = 0;
    zoomFactor = 1;
  }

  function onPointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (selecting) {
      selectionStart = imagePoint(event);
      selection = { ...selectionStart, width: 0, height: 0 };
    }
  }

  function onPointerMove(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (!dragging) return;

    if (selecting) {
      const point = imagePoint(event);
      selection = {
        x: Math.min(selectionStart.x, point.x),
        y: Math.min(selectionStart.y, point.y),
        width: Math.abs(point.x - selectionStart.x),
        height: Math.abs(point.y - selectionStart.y),
      };

      return;
    }

    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    dragging = false;
    const element = event.currentTarget;

    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

    if (
      event.type !== "pointercancel" &&
      selecting &&
      selection &&
      selection.width * scale > 3 &&
      selection.height * scale > 3
    ) {
      const inverse = invertTransform(pdfToPixels);

      if (!(inverse instanceof ReviewInputError))
        onSelectRegion?.(transformRegion(inverse, selection));
      selecting = false;
    }

    selection = null;
  }
</script>

<section class="viewer" aria-label={label}>
  {#if onSheet && sheets.length > 0}
    <nav class="sheet-navigation" aria-label="Source sheets">
      <button
        type="button"
        aria-label="Previous sheet"
        disabled={currentIndex <= 0 || selecting}
        onclick={() => moveSheet(-1)}>←</button
      >
      <span>{currentIndex + 1} of {sheets.length}</span>
      <button
        type="button"
        aria-label="Next sheet"
        disabled={currentIndex < 0 || currentIndex >= sheets.length - 1 || selecting}
        onclick={() => moveSheet(1)}>→</button
      >
      <details>
        <summary>Jump to sheet</summary>
        <div class="sheet-picker">
          <input
            aria-label="Find source sheet"
            type="search"
            bind:value={sheetQuery}
            placeholder="Sheet or page…"
          />
          {#each matchingSheets as sheet (sheet.id)}<button
              type="button"
              disabled={selecting}
              aria-current={sheet.id === currentSheetId ? "page" : undefined}
              onclick={(event) => {
                onSheet(sheet);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}>{sheet.label} · page {sheet.pageIndex + 1}</button
            >{/each}
          {#if matchingSheets.length === 0}<p>No matching sheet.</p>{/if}
        </div>
      </details>
    </nav>
  {/if}
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
    <button
      type="button"
      class="icon-button"
      aria-label="Reset view"
      title="Fit sheet"
      onclick={resetView}><ReviewIcon name="refresh" size={16} /></button
    >
  </div>
  {#if selecting}<p class="selection-help" role="status">
      Drag a box around the area to count. <button
        type="button"
        onclick={() => {
          selecting = false;
          selection = null;
        }}>Cancel</button
      >
    </p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The image canvas supports focusable keyboard pan and zoom.) -->
  <div
    class="viewport"
    class:selecting
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
          scale =
            Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight) * 0.95 * zoomFactor;
          rotation = 0;
          panX = 0;
          panY = 0;
        }}
      />
      {#if masks.length}<svg
          class="masks"
          width={imageWidth}
          height={imageHeight}
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          aria-hidden="true"
          >{#each masks as mask, index (index)}<path
              d={mask.path}
              transform={mask.transform}
            />{/each}</svg
        >{/if}
      {#each pixelOverlays as overlay, index (index)}
        <div
          class="overlay"
          style={`left:${overlay.region.x}px;top:${overlay.region.y}px;width:${overlay.region.width}px;height:${overlay.region.height}px`}
          title={overlay.title}
        ></div>
      {/each}
      {#if selection}<div
          class="overlay"
          style={`left:${selection.x}px;top:${selection.y}px;width:${selection.width}px;height:${selection.height}px`}
        ></div>{/if}
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
  .selection-help {
    font-size: 12px;
    margin: 0;
    line-height: 1.5;
    color: var(--nd-ink-muted);
  }
  .selection-help button {
    color: inherit;
    background: transparent;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .viewport.selecting {
    cursor: crosshair;
  }
  .viewer-toolbar {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .sheet-navigation {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
  }
  .sheet-navigation button,
  .sheet-picker input {
    font: inherit;
    color: inherit;
    background: var(--nd-raised);
    border: 1px solid var(--nd-hairline);
    border-radius: 5px;
    padding: 5px 8px;
  }
  .sheet-navigation button {
    cursor: pointer;
  }
  .sheet-navigation button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sheet-navigation details {
    position: relative;
  }
  .sheet-navigation summary {
    cursor: pointer;
  }
  .sheet-picker {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 2;
    display: grid;
    gap: 6px;
    width: min(300px, 60vw);
    max-height: 220px;
    overflow-y: auto;
    padding: 8px;
    background: var(--nd-shell);
    border: 1px solid var(--nd-hairline);
    border-radius: 6px;
    box-shadow: 0 8px 24px #0003;
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
  .masks {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
  }
  .masks path {
    fill: rgb(3 105 161 / 0.35);
  }
  .overlay {
    position: absolute;
    border: 2px solid #f5a623;
    background: rgb(245 166 35 / 0.12);
    pointer-events: none;
    box-sizing: border-box;
  }
</style>
