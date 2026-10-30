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
        class="icon-btn"
        aria-label="Previous sheet"
        disabled={currentIndex <= 0 || selecting}
        onclick={() => moveSheet(-1)}><ReviewIcon name="chevron-left" /></button
      >
      <span class="sheet-position">{currentIndex + 1} of {sheets.length}</span>
      <button
        type="button"
        class="icon-btn"
        aria-label="Next sheet"
        disabled={currentIndex < 0 || currentIndex >= sheets.length - 1 || selecting}
        onclick={() => moveSheet(1)}><ReviewIcon name="chevron-right" /></button
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
              class="sheet-option"
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
    <button type="button" class="icon-btn" aria-label="Zoom in" onclick={() => zoom(0.2)}
      ><ReviewIcon name="zoom-in" /></button
    >
    <button type="button" class="icon-btn" aria-label="Zoom out" onclick={() => zoom(-0.2)}
      ><ReviewIcon name="zoom-out" /></button
    >
    <button
      type="button"
      class="icon-btn"
      aria-label="Rotate clockwise"
      onclick={() => {
        rotation = (rotation + 90) % 360;
      }}><ReviewIcon name="rotate-clockwise" /></button
    >
    <button
      type="button"
      class="icon-btn"
      aria-label="Reset view"
      title="Fit sheet"
      onclick={resetView}><ReviewIcon name="zoom-reset" /></button
    >
  </div>
  {#if selecting}<p class="selection-help" role="status">
      Drag a box around the area to count. <button
        type="button"
        class="text-link"
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
    gap: var(--space-xs);
    min-height: 0;
    flex: 0 0 300px;
    height: 300px;
  }
  .selection-help {
    font-size: var(--text-mono-sm);
    margin: 0;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .text-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-accent);
    font-weight: 500;
  }
  .text-link:hover {
    color: var(--color-accent-hover);
  }
  .viewport.selecting {
    cursor: crosshair;
  }
  .viewer-toolbar {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  .sheet-navigation {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-size: var(--text-body-sm);
  }
  .sheet-position {
    min-width: 56px;
    text-align: center;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
  }
  .sheet-navigation details {
    position: relative;
    margin-left: var(--space-xs);
  }
  .sheet-navigation summary {
    height: 32px;
    padding: 0 10px 0 var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-label-sm);
    font-weight: 600;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    transition: border-color var(--duration-fast) var(--ease-out);
  }
  .sheet-navigation summary:hover {
    border-color: var(--color-bone);
  }
  .sheet-navigation summary::before {
    order: 1;
    -webkit-mask-image: var(--icon-chevron-down);
    mask-image: var(--icon-chevron-down);
  }
  .sheet-navigation details[open] > summary::before {
    transform: rotate(180deg);
  }
  .sheet-picker {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 2;
    display: grid;
    gap: 2px;
    width: min(300px, 60vw);
    max-height: 240px;
    overflow-y: auto;
    padding: var(--space-2xs);
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }
  .sheet-picker input {
    margin-bottom: var(--space-2xs);
  }
  .sheet-picker p {
    margin: 0;
    padding: 6px var(--space-xs);
    color: var(--color-text-muted);
  }
  .sheet-option {
    min-height: 32px;
    padding: 0 var(--space-xs);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    text-align: left;
  }
  .sheet-option:hover:not(:disabled) {
    background: var(--color-slate);
  }
  .sheet-option[aria-current="page"] {
    background: var(--color-slate);
    box-shadow: inset 2px 0 0 var(--color-ember);
  }
  .sheet-option[aria-current="page"]:focus-visible {
    box-shadow:
      inset 2px 0 0 var(--color-ember),
      var(--shadow-focus-ring);
  }
  .viewport {
    position: relative;
    flex: 1;
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-ink);
    touch-action: none;
    cursor: grab;
  }
  .viewport:active {
    cursor: grabbing;
  }
  .viewport:focus-visible {
    border-color: var(--color-accent);
    box-shadow: var(--shadow-focus);
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
    border: 2px solid var(--color-ember);
    background: rgb(246 90 26 / 0.06);
    pointer-events: none;
    box-sizing: border-box;
  }
</style>
