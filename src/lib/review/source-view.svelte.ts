import type { ReviewClient } from "./client.ts";
import type { Artifact, ProjectId, Region, Sheet } from "./contracts.ts";

/** An outline drawn over the displayed source, in PDF coordinates. */
export interface SourceOverlay {
  readonly region: Region;
  readonly title: string;
}

/** The workbench operations a source view uses to render a sheet region and load its pixels. */
export interface SourceViewPorts {
  readonly render: (request: {
    readonly projectId: typeof ProjectId.Type;
    readonly sheetId: Sheet["id"];
    readonly region: Region;
    readonly dpi: number;
  }) => ReturnType<ReviewClient["renderSource"]>;
  readonly loadImage: ReviewClient["loadArtifactBlobUrl"];
  /** The selected project; a render for another project shows nothing. */
  readonly selectedProject: () => typeof ProjectId.Type | null;
  readonly releaseImage: (url: string) => void;
}

/** A sheet render: the whole page box unless a region is given. */
export interface SheetRender {
  readonly projectId: typeof ProjectId.Type;
  readonly dpi: number;
  readonly region?: Region | undefined;
  /** Outlines to show once the render arrives. */
  readonly overlays: () => ReadonlyArray<SourceOverlay>;
  /** Previous/next sheet navigation keeps the reviewer's zoom; a new context starts fitted. */
  readonly keepZoom?: boolean;
  /** A request claimed before earlier work, such as a snapshot refresh. */
  readonly request?: number;
}

/**
 * Owns the source canvas: the displayed render, its loading state and its one blob URL. Each
 * request has a generation; a newer request, close or disposal discards anything still loading
 * for an earlier one and releases every image it does not show.
 */
export class SourceView {
  /** True while the current request renders or loads its image. */
  loading = $state(false);
  /** The sheet whose source is displayed or loading. */
  sheet = $state.raw<Sheet | null>(null);
  /** The owned blob URL of the displayed image, or empty. */
  imageUrl = $state("");
  /** The artifact whose pixels are displayed. */
  artifact = $state.raw<Artifact | null>(null);
  overlays = $state.raw<ReadonlyArray<SourceOverlay>>([]);
  /** Zoom relative to the fitted view; the viewer binds it. */
  zoom = $state(1);
  /** The DPI of the last completed sheet render. */
  dpi = 96;

  #request = 0;
  readonly #ports: SourceViewPorts;

  constructor(ports: SourceViewPorts) {
    this.#ports = ports;
  }

  /** Claim the canvas for a new request, invalidating anything still loading. */
  begin() {
    return ++this.#request;
  }

  /** Whether a request still owns the canvas. */
  current(request: number) {
    return request === this.#request;
  }

  /** Show a saved artifact of a sheet. Resolves to an error to present, or null. */
  async openArtifact(
    request: number,
    artifact: Artifact,
    sheet: Sheet,
    overlays: ReadonlyArray<SourceOverlay>,
  ) {
    this.loading = true;
    this.sheet = sheet;
    this.zoom = 1;
    this.#clearImage();
    this.overlays = [];
    const image = await this.#ports.loadImage(artifact.projectId, artifact);

    return this.#show(request, image, artifact, () => overlays);
  }

  /** Render a sheet region and show it. Resolves to an error to present, or null. */
  async renderSheet(sheet: Sheet, render: SheetRender) {
    const request = render.request ?? this.begin();
    this.#clearImage();
    this.overlays = [];
    this.sheet = sheet;
    this.loading = true;

    if (!render.keepZoom) this.zoom = 1;

    const rendered = await this.#ports.render({
      projectId: render.projectId,
      sheetId: sheet.id,
      region: render.region ?? {
        x: sheet.box.x,
        y: sheet.box.y,
        width: sheet.box.width,
        height: sheet.box.height,
      },
      dpi: render.dpi,
    });

    if (!rendered.ok) {
      if (!this.current(request)) return null;
      this.loading = false;

      return rendered.error.message;
    }

    if (!this.current(request) || render.projectId !== this.#ports.selectedProject()) return null;
    const image = await this.#ports.loadImage(render.projectId, rendered.value);
    const failure = this.#show(request, image, rendered.value, render.overlays);

    if (failure === null && this.current(request)) this.dpi = render.dpi;

    return failure;
  }

  /** Stop loading and release the displayed image. The sheet and its outlines stay. */
  close() {
    this.#request++;
    this.loading = false;
    this.#clearImage();
  }

  /** Close, and forget the sheet and its outlines. */
  clear() {
    this.close();
    this.sheet = null;
    this.overlays = [];
  }

  /** Invalidate pending work and release the displayed image when the workbench unmounts. */
  dispose() {
    this.#request++;

    if (this.imageUrl.startsWith("blob:")) this.#ports.releaseImage(this.imageUrl);
  }

  #clearImage() {
    if (this.imageUrl.startsWith("blob:")) this.#ports.releaseImage(this.imageUrl);
    this.imageUrl = "";
    this.artifact = null;
  }

  #show(
    request: number,
    image: Awaited<ReturnType<ReviewClient["loadArtifactBlobUrl"]>>,
    artifact: Artifact,
    overlays: () => ReadonlyArray<SourceOverlay>,
  ) {
    if (!this.current(request)) {
      if (image.ok) this.#ports.releaseImage(image.value);

      return null;
    }

    this.loading = false;

    if (!image.ok) return image.error.message;
    this.#clearImage();
    this.imageUrl = image.value;
    this.artifact = artifact;
    this.overlays = overlays();

    return null;
  }
}
