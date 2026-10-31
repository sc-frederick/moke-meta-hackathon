import { expect, test } from "bun:test";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { Effect, Schema } from "effect";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Documents } from "../../backend/documents/documents.ts";
import { ProjectId, Region, RevisionId, Sheet, SheetId } from "#lib/review/contracts.ts";
import { canvasNativeFileName, preparePdfAssets } from "../../scripts/prepare-pdf-assets.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

const Licenses = Schema.fromJsonString(Schema.Struct({ pdfjs: Schema.String }));

test("staged PDF.js assets are the runtime allowlist and render rotated text on their own", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-pdf-assets-"));
  const assets = join(root, "pdf-assets");
  const data = join(root, "data");

  try {
    preparePdfAssets(assets);
    const pdfjs = join(assets, "pdfjs");

    const files = (await readdir(pdfjs, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(pdfjs.length + 1));

    expect(files.filter((file) => file.startsWith("legacy/"))).toEqual([
      "legacy/build/pdf.worker.mjs",
    ]);
    expect(files.filter((file) => file.endsWith(".map"))).toEqual([]);
    expect(files).toContain("cmaps/LICENSE");
    expect(files).toContain("standard_fonts/LiberationSans-Regular.ttf");
    expect(files).toContain("standard_fonts/LICENSE_LIBERATION");
    expect(files).toContain("wasm/openjpeg.wasm");
    expect(files).toContain("wasm/jbig2.wasm");
    expect(files).toContain("wasm/LICENSE_OPENJPEG");
    expect(
      Schema.decodeUnknownSync(Licenses)(await readFile(join(assets, "licenses.json"), "utf8"))
        .pdfjs,
    ).toContain("Apache License");

    const original = join(root, "rotated.pdf");
    await writeFile(original, createHeroPdf("A", 90));

    const render = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const documents = yield* Documents;
          const imported = yield* documents.importPdf(original);
          const page = imported.pages[0];

          if (page === undefined) return yield* Effect.die("No fixture page");

          return yield* documents.render(
            imported.sha256,
            new Sheet({
              ...page,
              id: Schema.decodeUnknownSync(SheetId)(crypto.randomUUID()),
              projectId: Schema.decodeUnknownSync(ProjectId)(crypto.randomUUID()),
              revisionId: Schema.decodeUnknownSync(RevisionId)(crypto.randomUUID()),
              confirmed: true,
              coverage: "reviewer_complete",
            }),
            new Region({ x: 0, y: 0, width: 612, height: 792 }),
            72,
          );
        }).pipe(
          Effect.provide(
            Documents.layer({
              dataDirectory: data,
              workerCommand: [
                process.execPath,
                "--no-orphans",
                resolve("backend/documents/pdf-worker-main.ts"),
              ],
              assetsDirectory: pdfjs,
              nativeLibraryPath: join(assets, "native", canvasNativeFileName()),
            }),
          ),
        ),
      ),
    );

    expect([render.width, render.height]).toEqual([792, 612]);

    // The page's standard-font text and marks render as dark pixels on white paper.
    const image = await loadImage(await readFile(join(data, "artifacts", `${render.sha256}.png`)));

    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let dark = 0;

    for (let index = 0; index < pixels.length; index += 4)
      if ((pixels[index] ?? 255) < 96) dark += 1;

    expect(dark).toBeGreaterThan(100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
