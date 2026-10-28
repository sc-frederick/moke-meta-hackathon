import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Documents } from "../backend/documents/documents.ts";
import { createHeroPdf } from "./fixtures/hero-case.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { transformPoint } from "#lib/review/geometry.ts";
import { fileURLToPath } from "node:url";
import { canvasNativeFileName, canvasNativePackage } from "../scripts/prepare-pdf-assets.ts";
import { Schema } from "effect";
import { Region, Sheet, ProjectId, RevisionId, SheetId } from "#lib/review/contracts.ts";

const sheetId = (value: string) => Schema.decodeUnknownSync(SheetId)(value);
const projectId = (value: string) => Schema.decodeUnknownSync(ProjectId)(value);
const revisionId = (value: string) => Schema.decodeUnknownSync(RevisionId)(value);

import { buildMinimalPdf } from "./fixtures/generated/minimal-pdf.ts";

const fixtureDirectory = await mkdtemp(join(tmpdir(), "moke-pdf-fixtures-"));

beforeAll(async () => {
  await writeFile(join(fixtureDirectory, "original.pdf"), buildMinimalPdf());
  await writeFile(join(fixtureDirectory, "malformed.pdf"), "not a pdf");
});

afterAll(() => rm(fixtureDirectory, { recursive: true, force: true }));

const assetsRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

const nativeFile = join(
  dirname(fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`))),
  canvasNativeFileName(),
);

test("direct crops contain the source mark through every rotation, nonzero page box, and UserUnit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-crop-pixels-"));

  try {
    for (const rotation of [0, 90, 180, 270] as const) {
      const original = join(directory, `source-${rotation}.pdf`);
      const userUnit = rotation === 270 ? 2 : 1;
      await writeFile(original, createHeroPdf("A", rotation, userUnit, 20));

      const render = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const documents = yield* Documents;
            const imported = yield* documents.importPdf(original);
            const page = imported.pages[0];

            if (page === undefined) return yield* Effect.die("No fixture page");
            expect(page.box.x).toBe(20);

            const sheet = new Sheet({
              ...page,
              id: sheetId(crypto.randomUUID()),
              projectId: projectId(crypto.randomUUID()),
              revisionId: revisionId(crypto.randomUUID()),
              confirmed: true,
              coverage: "reviewer_complete",
            });

            return yield* documents.render(
              imported.sha256,
              sheet,
              new Region({ x: 60, y: 360, width: 230, height: 300 }),
              72,
            );
          }).pipe(Effect.provide(documentsLayer(directory))),
        ),
      );

      expect(render.width).toBe((rotation === 90 || rotation === 270 ? 300 : 230) * userUnit);
      expect(render.height).toBe((rotation === 90 || rotation === 270 ? 230 : 300) * userUnit);

      const image = await loadImage(
        await readFile(join(directory, "artifacts", `${render.sha256}.png`)),
      );

      const canvas = createCanvas(render.width, render.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const location = transformPoint(render.pdfToPixels, 120, 540);

      const pixels = context.getImageData(
        Math.round(location.x) - 1,
        Math.round(location.y) - 1,
        3,
        3,
      ).data;

      let darkest = 255;

      for (let index = 0; index < pixels.length; index += 4)
        darkest = Math.min(darkest, pixels[index] ?? 255);
      expect(darkest).toBeLessThan(180);
      const restored = transformPoint(render.pixelsToPdf, location.x, location.y);
      expect(restored.x).toBeCloseTo(120, 6);
      expect(restored.y).toBeCloseTo(540, 6);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

function documentsLayer(dataDirectory: string) {
  return Documents.layer({
    dataDirectory,
    workerCommand: [
      process.execPath,
      "--no-orphans",
      resolve("backend/documents/pdf-worker-main.ts"),
    ],
    assetsDirectory: assetsRoot,
    nativeLibraryPath: resolve(nativeFile),
  });
}

test("import stores the original hash and inventories pages", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-"));
  const source = join(fixtureDirectory, "original.pdf");

  try {
    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return yield* documents.importPdf(source);
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    expect(imported.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.pages.length).toBe(1);
    expect(imported.pages[0]?.pageIndex).toBe(0);

    const onDisk = await readFile(join(dataDirectory, "artifacts", `${imported.sha256}.pdf`));
    expect(onDisk.byteLength).toBe(imported.byteLength);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("malformed PDFs and oversize regions are rejected", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-reject-"));
  const badSource = join(fixtureDirectory, "malformed.pdf");
  const goodSource = join(fixtureDirectory, "original.pdf");

  try {
    const malformed = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const documents = yield* Documents;

          return yield* documents.importPdf(badSource);
        }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
      ),
    );

    expect(Exit.isFailure(malformed)).toBe(true);

    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return yield* documents.importPdf(goodSource);
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    const page = imported.pages[0];

    if (!page) {
      throw new Error("missing page");
    }

    const sheet = new Sheet({
      id: sheetId(crypto.randomUUID()),
      projectId: projectId(crypto.randomUUID()),
      revisionId: revisionId(crypto.randomUUID()),
      pageIndex: page.pageIndex,
      label: page.label,
      confirmed: false,
      box: page.box,
      rotation: page.rotation,
      userUnit: 2,
      coverage: "unreviewed",
    });

    const hugeRegion = new Region({
      x: page.box.x,
      y: page.box.y,
      width: page.box.width,
      height: page.box.height,
    });

    const limited = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const documents = yield* Documents;

          return yield* documents.render(imported.sha256, sheet, hugeRegion, 300);
        }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
      ),
    );

    expect(Exit.isFailure(limited)).toBe(true);

    if (Exit.isFailure(limited)) {
      expect(String(limited.cause)).toContain("pixel");
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("read returns bounded chunks for stored artifacts", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-read-"));
  const source = join(fixtureDirectory, "original.pdf");

  try {
    const chunk = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;
        const imported = yield* documents.importPdf(source);

        return yield* documents.read(imported.sha256, "application/pdf", 0, 128);
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    expect(chunk.totalBytes).toBeGreaterThan(128);
    expect(Buffer.from(chunk.base64, "base64").byteLength).toBe(128);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("import interruption cancels in-flight PDF work", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-cancel-"));
  const source = join(fixtureDirectory, "original.pdf");
  process.env.MOKE_PDF_WORKER_DELAY_MS = "500";

  try {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;
        const fiber = yield* Effect.forkScoped(documents.importPdf(source));
        yield* Effect.sleep("50 millis");
        yield* Fiber.interrupt(fiber);

        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  } finally {
    delete process.env.MOKE_PDF_WORKER_DELAY_MS;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
