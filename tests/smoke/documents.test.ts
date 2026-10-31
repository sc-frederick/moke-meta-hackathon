import { afterAll, beforeAll, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Metric, Result } from "effect";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { artifactBytesVerified } from "../../backend/documents/artifact-store.ts";
import { Documents, pdfJobConcurrency } from "../../backend/documents/documents.ts";
import { readSource } from "../../backend/packet-review/sources.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { transformPoint } from "#lib/review/geometry.ts";
import { fileURLToPath } from "node:url";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import { Schema } from "effect";
import {
  DocumentError,
  OperationId,
  Region,
  Sheet,
  ProjectId,
  RevisionId,
  SheetId,
} from "#lib/review/contracts.ts";
import { importProject, openReviewOperations, shiftRegion } from "../fixtures/review-operations.ts";

const sheetId = (value: string) => Schema.decodeUnknownSync(SheetId)(value);
const projectId = (value: string) => Schema.decodeUnknownSync(ProjectId)(value);
const revisionId = (value: string) => Schema.decodeUnknownSync(RevisionId)(value);

import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";

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
}, 120000);

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

test("extracts retrieved PDF text by whole pages, from a requested page, and stores the original", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-text-"));
  const pdf = createHeroPdf("A");

  try {
    const [whole, fromSecond, bounded, notPdf] = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return [
          yield* documents.extractText(pdf, 1, 100_000),
          yield* documents.extractText(pdf, 2, 100_000),
          yield* documents.extractText(pdf, 1, 400),
          yield* Effect.exit(documents.extractText(new TextEncoder().encode("<html>"), 1, 100)),
        ] as const;
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    expect(whole.pageCount).toBe(2);
    expect(whole.text).toContain("[Page 1]\nMOKE COORDINATION LAB");
    expect(whole.text).toContain("[Page 2]");
    expect(whole.truncated).toBe(false);
    expect(fromSecond.text.startsWith("[Page 2]")).toBe(true);
    expect(fromSecond.text).not.toContain("[Page 1]");
    // A limit inside page 2 returns page 1 whole, so a continuation starts at page 2.
    expect(bounded.lastPage).toBe(1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).not.toContain("[Page 2]");
    expect(Exit.isFailure(notPdf)).toBe(true);

    const stored = await readFile(join(dataDirectory, "artifacts", `${whole.sha256}.pdf`));
    expect(Buffer.compare(stored, Buffer.from(pdf))).toBe(0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 60000);

test("a retrieved PDF without embedded text stays unavailable", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-scanned-"));

  try {
    const source = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return yield* readSource("https://county.gov/amendments.pdf", {
          resolve: async () => [{ address: "1.1.1.1", family: 4 }],
          transport: async () => ({
            status: 200,
            headers: { "content-type": "application/pdf" },
            body: buildMinimalPdf(),
          }),
          pdfText: documents.extractText,
        });
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );

    expect(source.status).toBe("unavailable");
    expect(source.text).toContain("may be scanned");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 60000);

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

test("malformed PDFs and mismatched source metadata are rejected", async () => {
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
      expect(String(limited.cause)).toContain("metadata");
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

test("import interruption stops each started worker and releases every PDF job slot", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-documents-cancel-"));
  const started = await mkdtemp(join(tmpdir(), "moke-documents-started-"));
  const source = join(fixtureDirectory, "original.pdf");
  // Workers report each accepted job, then hold it far beyond this test.
  process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY = started;
  process.env.MOKE_PDF_WORKER_DELAY_MS = "600000";

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        // Fill every job slot, so one leaked slot would block the import that follows.
        const fibers = yield* Effect.forEach(Array.from({ length: pdfJobConcurrency }), () =>
          Effect.forkChild(documents.importPdf(source)),
        );

        const pids = yield* Effect.promise(() => startedWorkers(started, pdfJobConcurrency));

        for (const pid of pids) expect(running(pid)).toBe(true);

        for (const fiber of fibers) {
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }

        // Interruption completes only after each owned worker process has exited.
        for (const pid of pids) expect(running(pid)).toBe(false);
        expect(
          yield* Effect.promise(() => readdir(join(dataDirectory, "artifacts", ".staging"))),
        ).toEqual([]);

        delete process.env.MOKE_PDF_WORKER_DELAY_MS;
        const next = yield* documents.importPdf(source).pipe(Effect.timeout("30 seconds"));
        expect(next.pages.length).toBe(1);
        expect(
          yield* Effect.promise(() => startedWorkers(started, pdfJobConcurrency + 1)),
        ).toHaveLength(pdfJobConcurrency + 1);
      }).pipe(Effect.provide(documentsLayer(dataDirectory)), Effect.scoped),
    );
  } finally {
    delete process.env.MOKE_PDF_WORKER_STARTED_DIRECTORY;
    delete process.env.MOKE_PDF_WORKER_DELAY_MS;
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(started, { recursive: true, force: true });
  }
}, 60000);

/** Wait for the job-start handshake of `count` workers and return their process IDs. */
async function startedWorkers(directory: string, count: number) {
  const deadline = Date.now() + 30_000;

  for (;;) {
    const names = await readdir(directory);

    if (names.length >= count)
      return Promise.all(
        names.map(async (name) => Number(await readFile(join(directory, name), "utf8"))),
      );

    if (Date.now() > deadline) throw new Error(`Only ${names.length} PDF workers started.`);
    await Bun.sleep(10);
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

test("render refuses an original replaced by another valid PDF and records nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-documents-integrity-"));
  const source = join(directory, "plans.pdf");
  await writeFile(source, createHeroPdf("A"));

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const documents = yield* Documents;
          const { review, artifactRecords } = yield* openReviewOperations(directory, documents);
          const projectId = yield* importProject(review, source);
          const state = yield* review.snapshot(projectId, 0);
          const sheet = state.sheets[0];
          const revision = state.revisions[0];

          if (sheet === undefined || revision === undefined)
            return yield* Effect.die("Missing fixture sheet");

          const request = {
            projectId,
            sheetId: sheet.id,
            operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
            region: new Region({ x: 60, y: 360, width: 230, height: 300 }),
            dpi: 72,
          };

          yield* review.render(request);
          const artifacts = join(directory, "artifacts");
          // Revision B is a valid PDF with the same page geometry and different content.
          yield* Effect.promise(() =>
            writeFile(join(artifacts, `${revision.sha256}.pdf`), createHeroPdf("B")),
          );
          const images = yield* Effect.promise(() => readdir(artifacts));
          const records = yield* artifactRecords(projectId);

          const direct = yield* Effect.flip(
            documents.render(revision.sha256, sheet, shiftRegion(request.region, { x: 1 }), 72),
          );

          const recorded = yield* Effect.flip(
            review.render({
              ...request,
              operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
              region: shiftRegion(request.region, { y: -60 }),
            }),
          );

          for (const failure of [direct, recorded]) {
            expect(Schema.is(DocumentError)(failure)).toBe(true);
            expect(failure.message).toBe("The original PDF does not match its recorded hash.");
          }

          expect(yield* Effect.promise(() => readdir(artifacts))).toEqual(images);
          expect(yield* artifactRecords(projectId)).toBe(records);
        }).pipe(Effect.provide(documentsLayer(directory))),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("chunked artifact reads hash the file once and still reject altered or truncated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-documents-chunks-"));
  const bytes = crypto.getRandomValues(new Uint8Array(1024 * 1024 + 4321));
  const sha256 = Bun.SHA256.hash(bytes, "hex");
  const path = join(directory, "artifacts", `${sha256}.png`);
  const chunk = 256 * 1024;

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;
        yield* Effect.promise(() => mkdir(join(directory, "artifacts")));
        yield* Effect.promise(() => writeFile(path, bytes));

        const verified = Effect.map(Metric.value(artifactBytesVerified), (state) => state.count);

        const readAll = Effect.gen(function* () {
          const parts: Array<Buffer> = [];

          for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
            const part = yield* documents.read(sha256, "image/png", offset, chunk);
            expect(part.totalBytes).toBe(bytes.byteLength);
            parts.push(Buffer.from(part.base64, "base64"));
          }

          return Buffer.concat(parts);
        });

        expect(Buffer.compare(yield* readAll, Buffer.from(bytes))).toBe(0);
        expect(yield* verified).toBe(bytes.byteLength);
        expect(Buffer.compare(yield* readAll, Buffer.from(bytes))).toBe(0);
        expect(yield* verified).toBe(bytes.byteLength);

        const whole = yield* documents.readVerified(sha256, "image/png", 16 * 1024 * 1024);
        expect(Buffer.compare(Buffer.from(whole), Buffer.from(bytes))).toBe(0);
        expect(yield* verified).toBe(2 * bytes.byteLength);

        const bounded = yield* Effect.result(documents.readVerified(sha256, "image/png", 1024));
        expect(
          Result.isFailure(bounded) &&
            Schema.is(DocumentError)(bounded.failure) &&
            bounded.failure.reason === "limit",
        ).toBe(true);

        const altered = Uint8Array.from(bytes);
        altered[chunk + 7] = (altered[chunk + 7] ?? 0) ^ 0xff;

        for (const changed of [altered, bytes.subarray(0, bytes.byteLength - 1)]) {
          yield* Effect.promise(() => writeFile(path, changed));
          const result = yield* Effect.result(documents.read(sha256, "image/png", chunk, chunk));
          expect(Result.isFailure(result)).toBe(true);

          if (Result.isFailure(result))
            expect(result.failure.message).toContain("hash does not match");
        }

        // The restored original is verified again before it is served.
        yield* Effect.promise(() => writeFile(path, bytes));
        expect(Buffer.compare(yield* readAll, Buffer.from(bytes))).toBe(0);
      }).pipe(
        Effect.provide(documentsLayer(directory)),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.scoped,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("drawing-sized sheets and focused boxes fit the hard pixel ceiling with accurate actual-DPI transforms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-large-drawing-"));

  try {
    for (const rotation of [0, 90] as const) {
      const original = join(directory, `36x48-${rotation}.pdf`);
      await writeFile(original, buildMinimalPdf(rotation, 2592, 3456, 2));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const documents = yield* Documents;
            const imported = yield* documents.importPdf(original);
            const page = imported.pages[0];

            if (!page) return yield* Effect.die("Missing real PDF page");

            const sheet = new Sheet({
              id: sheetId(crypto.randomUUID()),
              projectId: projectId(crypto.randomUUID()),
              revisionId: revisionId(crypto.randomUUID()),
              ...page,
              confirmed: false,
              coverage: "unreviewed",
            });

            const full = yield* documents.render(imported.sha256, sheet, sheet.box, 150);
            expect(
              Math.ceil(((2592 * 150) / 72) * 2) * Math.ceil(((3456 * 150) / 72) * 2),
            ).toBeGreaterThan(16000000);
            expect(full.width * full.height).toBeLessThanOrEqual(16000000);
            expect(full.dpi).toBeLessThan(150);
            const detailRegion = new Region({ x: 20, y: 20, width: 220, height: 180 });
            const detail = yield* documents.render(imported.sha256, sheet, detailRegion, 300);
            expect(detail.dpi).toBe(300);
            expect(detail.width * detail.height).toBeLessThan(16000000);

            for (const render of [full, detail]) {
              const point = { x: 64, y: 64 };
              const pixel = transformPoint(render.pdfToPixels, point.x, point.y);
              const back = transformPoint(render.pixelsToPdf, pixel.x, pixel.y);
              expect(back.x).toBeCloseTo(point.x, 8);
              expect(back.y).toBeCloseTo(point.y, 8);
              const bytes = yield* documents.read(render.sha256, "image/png", 0, 256 * 1024);

              const image = yield* Effect.promise(() =>
                loadImage(Buffer.from(bytes.base64, "base64")),
              );

              expect(image.width).toBe(render.width);
              expect(image.height).toBe(render.height);
            }
          }),
        ).pipe(Effect.provide(documentsLayer(directory))),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
