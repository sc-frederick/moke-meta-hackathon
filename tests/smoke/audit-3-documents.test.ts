import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Documents } from "../../backend/documents/documents.ts";
import { suggestedSheetLabel } from "../../backend/documents/sheet-label.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { Region } from "#lib/review/contracts.ts";

test("PDF import proposes printed sheet identities and retains original page references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-labels-"));
  const source = join(directory, "lighting.pdf");
  await writeFile(source, createHeroPdf("A"));

  const native = dirname(
    fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`)),
  );

  try {
    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        const documents = yield* Documents;

        return yield* documents.importPdf(source);
      }).pipe(
        Effect.provide(
          Documents.layer({
            dataDirectory: directory,
            workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
            assetsDirectory: resolve("node_modules/pdfjs-dist"),
            nativeLibraryPath: join(native, canvasNativeFileName()),
          }),
        ),
      ),
    );

    expect(imported.pages[0]?.label).toBe("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
    expect(imported.pages[1]?.label).toBe("L-601 · FIXTURE SCHEDULE AND CONTROL DETAIL · Page 2");
    expect(imported.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous title-block text stays a generic page label", () => {
  const box = new Region({ x: 0, y: 0, width: 100, height: 100 });
  expect(
    suggestedSheetLabel(
      2,
      null,
      [
        { text: "S-2", x: 90, y: 10 },
        { text: "A-1", x: 90, y: 20 },
      ],
      box,
    ),
  ).toBe("Page 3");
  expect(suggestedSheetLabel(2, "FA-2", [], box)).toBe("FA-2 · Page 3");
});
