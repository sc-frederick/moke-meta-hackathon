import { Match } from "effect";
import type { DrawingCrop } from "./fixtures.ts";
import type { Segmentation, SegmentationCase } from "./sam.ts";

/** A prepared request, a completed inference, or a visible failed case. */
export type CaseResult = {
  readonly test: SegmentationCase;
  readonly crop: DrawingCrop;
  readonly prompt: string;
  readonly inputSha256: string;
  readonly pdfSha256: string;
  readonly elapsedMs: number;
  readonly review: "pending";
} & (
  | { readonly status: "prepared" }
  | { readonly status: "succeeded"; readonly segmentation: Segmentation }
  | { readonly status: "failed"; readonly message: string }
);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Render decoded masks in their box-local raster coordinates over the exact crop. */
export function overlaySvg(
  segmentation: Segmentation,
  crop: DrawingCrop,
  bytes: Uint8Array,
): string {
  const colors = ["#0369a1", "#be123c", "#15803d", "#7e22ce", "#c2410c"];

  const overlays = segmentation.objects
    .map((object, index) => {
      const box = object.pixels;
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      const color = colors[index % colors.length];

      return `<g fill="${color}" stroke="${color}"><path d="${escapeHtml(object.mask.path)}" transform="translate(${box.left} ${box.top}) scale(${width / object.mask.width} ${height / object.mask.height})" fill-opacity="0.3" stroke="none"/><rect x="${box.left}" y="${box.top}" width="${width}" height="${height}" fill="none" stroke-width="4"/><text x="${box.left + 5}" y="${Math.max(24, box.top - 8)}" font-family="sans-serif" font-size="24" stroke="white" stroke-width="3" paint-order="stroke">${escapeHtml(object.id)}${object.confidence === null ? "" : ` · ${object.confidence.toFixed(3)}`}</text></g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width_px}" height="${crop.height_px}" viewBox="0 0 ${crop.width_px} ${crop.height_px}"><image width="${crop.width_px}" height="${crop.height_px}" href="data:image/png;base64,${Buffer.from(bytes).toString("base64")}"/>${overlays}</svg>`;
}

/** Build a local evidence comparison without assuming detections are correct. */
export function reportHtml(
  results: ReadonlyArray<CaseResult>,
  model: string,
  plannedCount: number,
): string {
  const cards = results
    .map((result) => {
      const id = escapeHtml(result.test.id);
      const cropId = escapeHtml(result.crop.id);

      const summary = Match.value(result).pipe(
        Match.when({ status: "failed" }, (failed) => escapeHtml(failed.message)),
        Match.when({ status: "prepared" }, () => "Prepared only. No model call."),
        Match.when(
          { status: "succeeded" },
          (completed) =>
            `${completed.segmentation.objects.length} proposed objects. ${(completed.elapsedMs / 1000).toFixed(2)} seconds.`,
        ),
        Match.exhaustive,
      );

      const geometry =
        result.status === "succeeded"
          ? result.segmentation.objects
              .map(
                (object) =>
                  `<tr><td>${escapeHtml(object.id)}</td><td>${object.confidence?.toFixed(3) ?? "Not returned"}</td><td>${Object.values(object.pixels).join(", ")}</td><td>${Object.values(
                    object.pdfPoints,
                  )
                    .map((value) => value.toFixed(2))
                    .join(", ")}</td></tr>`,
              )
              .join("")
          : "";

      return `<article id="${id}"><h2>${id}</h2><p>${escapeHtml(result.test.purpose)}</p><p><strong>${result.status.toUpperCase()}</strong> · ${summary} · Human review pending.</p><p>${escapeHtml(result.crop.pdf)} · page ${result.crop.page} · sheet ${escapeHtml(result.crop.sheet)} · ${result.crop.dpi} DPI · ${result.crop.width_px} × ${result.crop.height_px} px</p><code>${escapeHtml(result.prompt)}</code><div class="comparison"><figure><a href="inputs/${cropId}.png"><img loading="lazy" src="inputs/${cropId}.png" alt="Original ${cropId}"/></a><figcaption>Same crop without SAM</figcaption></figure>${result.status === "succeeded" ? `<figure><a href="${id}/overlay.svg"><img loading="lazy" src="${id}/overlay.svg" alt="SAM proposed masks for ${id}"/></a><figcaption>SAM masks and boxes, proposed evidence</figcaption></figure>` : ""}</div>${geometry ? `<div class="scroll"><table><thead><tr><th>Object</th><th>Model confidence</th><th>Crop pixels: L, T, R, B</th><th>PDF points: L, T, R, B</th></tr></thead><tbody>${geometry}</tbody></table></div>` : ""}<p><a href="${id}/result.json">Case result</a> · <a href="${id}/request.json">Request metadata</a>${result.status !== "prepared" ? ` · <a href="${id}/response.json">Raw response, when received</a>` : ""}</p></article>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Moke SAM 3.1 experiment</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#172033;background:#f1f4f7;max-width:1500px;margin:auto;padding:32px}h1,h2{line-height:1.2}article{background:white;border:1px solid #ccd5df;border-radius:12px;padding:24px;margin:24px 0}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere}.comparison{display:flex;gap:16px;margin-top:20px}figure{flex:1;min-width:0;margin:0}img{width:100%;border:1px solid #ccd5df}figcaption{font-weight:600}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ccd5df;padding:8px}.scroll{overflow:auto}a{color:#075b9c}@media(max-width:750px){body{padding:12px}.comparison{flex-direction:column}}</style><h1>Moke · SAM 3.1 segmentation experiment</h1><p>Model: ${escapeHtml(model)}. Saved local run. Each comparison uses identical input pixels.</p><p>${results.length} of ${plannedCount} selected cases have saved outcomes. ${plannedCount - results.length} not yet attempted.</p><p>Inspect masks against the drawing. Confidence is the model's score, not measured accuracy. Zero matches is a completed result, not proof of absence. No engineering rule, physical measurement, or revision conclusion is inferred here.</p><p>Human labels, correctness metrics, and cost are not yet available. Request bodies contain image crops; provider preprocessing remains outside our control. PDF coordinates use a top-left origin, 72 points per inch, with half-open right/bottom edges.</p>${cards}</html>`;
}
