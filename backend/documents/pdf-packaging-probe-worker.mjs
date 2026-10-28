/** Minimal overview render used by `scripts/pdf-packaging-probe.ts` without TypeScript compile. */
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const assetsRoot = process.env.MOKE_PDFJS_ASSETS;

if (!assetsRoot) {
  console.error("MOKE_PDFJS_ASSETS required");
  process.exit(2);
}

GlobalWorkerOptions.workerSrc = join(assetsRoot, "legacy/build/pdf.worker.mjs");

const pdfPath = process.argv[2];
const outDir = process.argv[3] ?? "/tmp/out";

mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(readFileSync(pdfPath));

const doc = await getDocument({
  data,
  cMapUrl: join(assetsRoot, "cmaps/") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assetsRoot, "standard_fonts/") + "/",
}).promise;

const page = await doc.getPage(1);
const scale = 512 / page.view[2];
const viewport = page.getViewport({ scale });
const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));

await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

writeFileSync(join(outDir, "overview.png"), canvas.toBuffer("image/png"));

await page.cleanup();

await doc.cleanup();

console.log("ok", canvas.width, canvas.height);
