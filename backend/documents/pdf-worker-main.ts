/**
 * Standalone PDF worker: schema-validated NDJSON on stdin/stdout.
 * Run under Bun with `MOKE_PDFJS_ASSETS` and `NAPI_RS_NATIVE_LIBRARY_PATH` set.
 */
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { containsRegion, transformRegion, invertTransform } from "#lib/review/geometry.ts";
import { Affine, Region, ReviewInputError } from "#lib/review/contracts.ts";
import { DocumentsLimits } from "./config.ts";
import { suggestedSheetLabel } from "./sheet-label.ts";
import {
  WorkerFailure,
  WorkerInspectResult,
  WorkerRenderResult,
  WorkerRequest,
  WorkerResponse,
  WorkerSuccess,
} from "./worker-messages.ts";

const assetsRoot = process.env.MOKE_PDFJS_ASSETS;

if (!assetsRoot) {
  console.error(JSON.stringify({ fatal: "MOKE_PDFJS_ASSETS is required." }));
  process.exit(2);
}

GlobalWorkerOptions.workerSrc = join(assetsRoot, "legacy/build/pdf.worker.mjs");

const cMapUrl = join(assetsRoot, "cmaps/") + "/";
const standardFontDataUrl = join(assetsRoot, "standard_fonts/") + "/";

function writeResponse(response: typeof WorkerResponse.Type) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function classifyLoadError(cause: unknown): typeof WorkerFailure.Type {
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";

  if (/password|encrypted/i.test(message) || name === "PasswordException") {
    return {
      id: "unknown",
      ok: false,
      reason: "encrypted",
      message: "The PDF requires a password.",
    };
  }

  if (/invalid|corrupt|malformed|format/i.test(message)) {
    return { id: "unknown", ok: false, reason: "invalid", message: "The PDF could not be parsed." };
  }

  return {
    id: "unknown",
    ok: false,
    reason: "unavailable",
    message: "The PDF could not be loaded.",
  };
}

function loadDocument(pdfPath: string) {
  const data = new Uint8Array(readFileSync(pdfPath));

  if (data.byteLength > DocumentsLimits.maxSourceBytes) throw new Error("limit exceeded");

  return getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    wasmUrl: join(assetsRoot ?? "", "wasm/") + "/",
    useSystemFonts: false,
    verbosity: 0,
    maxImageSize: DocumentsLimits.maxOutputPixels,
  });
}

function pageBox(view: number[]) {
  return new Region({
    x: view[0] ?? 0,
    y: view[1] ?? 0,
    width: (view[2] ?? 0) - (view[0] ?? 0),
    height: (view[3] ?? 0) - (view[1] ?? 0),
  });
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const rotated = ((value % 360) + 360) % 360;

  if (rotated === 90) return 90;

  if (rotated === 180) return 180;

  if (rotated === 270) return 270;

  return 0;
}

async function inspectPdf(id: string, pdfPath: string) {
  let loading: ReturnType<typeof loadDocument> | undefined;

  try {
    loading = loadDocument(pdfPath);
    const document = await loading.promise;
    const count = document.numPages;

    if (count > DocumentsLimits.maxPages) {
      writeResponse({
        id,
        ok: false,
        reason: "limit",
        message: "The PDF exceeds the maximum allowed page count.",
      });

      return;
    }

    const pages = [];
    let pageLabels: Array<string> | null = null;

    try {
      pageLabels = await document.getPageLabels();
    } catch {
      // Malformed advisory page labels must not block otherwise valid source pages.
    }

    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      const page = await document.getPage(pageIndex + 1);
      const view = page.view;
      const rotate = normalizeRotation(page.rotate);
      const userUnit = page.userUnit > 0 ? page.userUnit : 1;
      const box = pageBox(view);
      let label = `Page ${pageIndex + 1}`;

      try {
        const content = await page.getTextContent();
        label = suggestedSheetLabel(
          pageIndex,
          pageLabels?.[pageIndex] ?? null,
          content.items.flatMap((item) =>
            "str" in item
              ? [{ text: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0 }]
              : [],
          ),
          box,
        );
      } catch {
        // Text extraction is advisory. Scanned or damaged text must not block source import.
      }

      pages.push({
        pageIndex,
        label,
        box,
        rotation: rotate,
        userUnit,
      });
      page.cleanup();
    }

    const result = Schema.decodeUnknownSync(WorkerInspectResult)({ pages });
    writeResponse(Schema.decodeUnknownSync(WorkerSuccess)({ id, ok: true, result }));
  } catch (error) {
    if (error instanceof Error && /limit exceeded/i.test(error.message)) {
      writeResponse({
        id,
        ok: false,
        reason: "limit",
        message: "The PDF exceeds the maximum allowed size.",
      });

      return;
    }

    const failure = classifyLoadError(error);
    writeResponse({ ...failure, id });
  } finally {
    await loading?.destroy();
  }
}

async function renderRegion(
  id: string,
  pdfPath: string,
  pageIndex: number,
  region: Region,
  rotation: 0 | 90 | 180 | 270,
  userUnit: number,
  dpi: number,
) {
  let loading: ReturnType<typeof loadDocument> | undefined;

  try {
    loading = loadDocument(pdfPath);
    const document = await loading.promise;

    if (pageIndex >= document.numPages) {
      writeResponse({
        id,
        ok: false,
        reason: "invalid",
        message: "The page index is out of range.",
      });

      return;
    }

    const page = await document.getPage(pageIndex + 1);

    if (
      page.userUnit !== userUnit ||
      normalizeRotation(page.rotate) !== rotation ||
      !containsRegion(pageBox(page.view), region)
    ) {
      writeResponse({
        id,
        ok: false,
        reason: "invalid",
        message: "The source page metadata or region changed.",
      });

      return;
    }

    // PDF.js applies UserUnit exactly once and preserves the page box and rotation.
    const viewport = page.getViewport({ scale: dpi / 72, rotation });
    const baseTransform = Schema.decodeUnknownSync(Affine)(viewport.transform);
    const bounds = transformRegion(baseTransform, region);
    const width = Math.ceil(bounds.width - 1e-9);
    const height = Math.ceil(bounds.height - 1e-9);

    if (width * height > DocumentsLimits.maxOutputPixels) {
      writeResponse({
        id,
        ok: false,
        reason: "limit",
        message: "The requested render exceeds the pixel limit.",
      });

      return;
    }

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");

    const renderTask = page.render({
      canvas: null,
      // @ts-expect-error -- SAFETY: PDF.js supports @napi-rs/canvas in Node, while these declarations require a DOM canvas context.
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, -bounds.x, -bounds.y],
    });

    const [a, b, c, d, e, f] = baseTransform;
    const pdfToPixels = Schema.decodeUnknownSync(Affine)([a, b, c, d, e - bounds.x, f - bounds.y]);

    if (process.env.MOKE_PDF_WORKER_DELAY_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.MOKE_PDF_WORKER_DELAY_MS)),
      );
    }

    await renderTask.promise;
    const pngBase64 = canvas.toBuffer("image/png").toString("base64");
    const inverted = invertTransform(pdfToPixels);

    if (inverted instanceof ReviewInputError) {
      page.cleanup();
      writeResponse({ id, ok: false, reason: "invalid", message: inverted.message });

      return;
    }

    const result = Schema.decodeUnknownSync(WorkerRenderResult)({
      pngBase64,
      width,
      height,
      pdfToPixels,
      pixelsToPdf: inverted,
    });

    writeResponse(Schema.decodeUnknownSync(WorkerSuccess)({ id, ok: true, result }));
    page.cleanup();
  } catch (error) {
    if (error instanceof Error && /abort|cancel/i.test(error.message)) {
      writeResponse({ id, ok: false, reason: "cancelled", message: "The render was cancelled." });

      return;
    }

    const failure = classifyLoadError(error);
    writeResponse({ ...failure, id });
  } finally {
    await loading?.destroy();
  }
}

async function handleRequest(line: string) {
  let decoded: typeof WorkerRequest.Type;

  try {
    decoded = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerRequest))(line);
  } catch {
    writeResponse({
      id: "unknown",
      ok: false,
      reason: "invalid",
      message: "The worker request did not match the expected schema.",
    });

    return;
  }

  if (WorkerRequest.guards.Inspect(decoded)) {
    await inspectPdf(decoded.id, decoded.pdfPath);

    return;
  }

  await renderRegion(
    decoded.id,
    decoded.pdfPath,
    decoded.pageIndex,
    decoded.region,
    decoded.rotation,
    decoded.userUnit,
    decoded.dpi,
  );
}

let pending = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  let index = pending.indexOf("\n");

  while (index >= 0) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);

    if (line.length > 0) {
      void handleRequest(line).catch((error) => {
        writeResponse({
          id: "unknown",
          ok: false,
          reason: "unavailable",
          message: error instanceof Error ? error.message : "The worker request failed.",
        });
      });
    }

    index = pending.indexOf("\n");
  }
});
