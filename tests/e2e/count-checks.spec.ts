import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Artifact, CountFact } from "#lib/review/contracts.ts";
import { transformPoint } from "#lib/review/geometry.ts";
import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";
import { installRpcBoundary } from "./rpc-boundary.ts";

test("accepting a count on a fitted 36x48 source refreshes with the requested integer DPI", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-large-count-"));
  const fixture = join(directory, "36x48.pdf");
  await writeFile(fixture, buildMinimalPdf(0, 2592, 3456, 1, 2));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Large source count regression");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(2);

    for (const row of await page.getByTestId("sheet-list").locator("li").all()) {
      await row.locator("details > summary").click();
      await row.getByTestId(/^confirm-sheet-/).click();
    }

    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByTestId("open-create-finding").click();
    const form = page.getByTestId("create-finding-form");
    await form.locator("input").first().fill("Large-sheet count");
    await form.locator("input").nth(1).fill("Count the vector rectangles on this sheet");
    await form.locator("select").first().selectOption({ index: 1 });
    await form.locator("select").nth(1).selectOption({ index: 2 });
    await form.locator('input[type="checkbox"]').check();
    await page.getByTestId("create-finding-submit").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    const previousImage = await page.locator(".viewer img").getAttribute("src");
    await page.getByTestId("drawn-count-input").fill("2");
    await page
      .getByTestId("drawn-statement-input")
      .fill("Two vector rectangles on the 36x48 source.");
    await page.getByTestId("accept-drawn-count").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    await expect(page.locator(".viewer img")).not.toHaveAttribute("src", previousImage ?? "");
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Drawn evidence");
    expect(
      await page.evaluate(() => window.auditRpc.renderDpis.filter((dpi) => dpi !== 24)),
    ).toEqual([96, 96]);
    await page.getByTestId("detail-drawn").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    await page.getByTestId("drawn-count-input").fill("3");
    await page
      .getByTestId("drawn-statement-input")
      .fill("Three rectangles after correcting the accepted count.");
    await page.getByTestId("accept-drawn-count").click();
    await expect
      .poll(() => page.evaluate(() => window.auditRpc.renderDpis.filter((dpi) => dpi !== 24)))
      .toEqual([96, 96, 300, 300]);
    await expect(page.locator(".viewer img")).toBeVisible();
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Drawn evidence");
    await expect(page.locator(".source-scroll .banner")).toHaveCount(0);
    const database = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

    try {
      const artifacts = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(Artifact) })),
      )(
        database
          .prepare(
            "SELECT payload FROM review_records WHERE kind='artifact' AND json_extract(payload,'$.mediaType')='image/png'",
          )
          .all(),
      );

      expect(artifacts.length).toBeGreaterThan(0);
      expect(artifacts.some(({ payload }) => payload.dpi === 96)).toBe(true);
      expect(
        artifacts.some(({ payload }) => payload.dpi < 300 && !Number.isInteger(payload.dpi)),
      ).toBe(true);

      const saved = Schema.decodeUnknownSync(Schema.fromJsonString(CountFact))(
        database
          .prepare(
            "SELECT payload FROM review_records WHERE kind='fact' AND json_extract(payload,'$.state')='accepted' ORDER BY json_extract(payload,'$.version') DESC LIMIT 1",
          )
          .get()?.payload,
      );

      expect(saved.value).toBe(3);

      for (const { payload: artifact } of artifacts) {
        expect(artifact.dpi).toBeGreaterThan(0);
        expect(artifact.dpi).toBeLessThanOrEqual(300);
        expect(artifact.width * artifact.height).toBeLessThanOrEqual(16000000);
        const point = { x: 240, y: 360 };
        const pixels = transformPoint(artifact.pdfToPixels, point.x, point.y);
        const restored = transformPoint(artifact.pixelsToPdf, pixels.x, pixels.y);
        expect(restored.x).toBeCloseTo(point.x, 6);
        expect(restored.y).toBeCloseTo(point.y, 6);
      }
    } finally {
      database.close();
    }

    await page.screenshot({ path: test.info().outputPath("audit-large-count-saved.png") });
    await page.locator(".source-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: test.info().outputPath("audit-large-count-refresh.png") });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh project can create a count check by verifying its sources in the form", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-fresh-count-"));
  const source = join(directory, "two-pages.pdf");
  await writeFile(source, buildMinimalPdf(0, 612, 792, 1, 2));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Fresh count-check regression");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(2);
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByTestId("open-create-finding").click();

    // No sheet has been verified yet; both remain choosable from the form itself.
    const form = page.getByTestId("create-finding-form");
    await form.locator("input").first().fill("Fresh project count");
    await form.locator("input").nth(1).fill("Light fixtures");
    await form.locator("select").first().selectOption({ label: "Page 1 · label unverified" });
    await form.locator("select").nth(1).selectOption({ label: "Page 2 · label unverified" });
    await expect(form.getByTestId("verify-count-sources")).toBeVisible();
    await form.getByTestId("verify-count-sources").check();
    // Changing a source withdraws the earlier verification; the new sheet needs its own check.
    await form.locator("select").first().selectOption({ label: "Page 2 · label unverified" });
    await expect(form.getByTestId("verify-count-sources")).not.toBeChecked();
    await form.locator("select").first().selectOption({ label: "Page 1 · label unverified" });
    await form.getByTestId("verify-count-sources").check();
    await form.getByLabel("Both sources apply to the same items and area").check();
    await page.getByTestId("create-finding-submit").click();
    await expect(page.getByTestId("drawn-count-input")).toBeVisible();
    await page.locator(".sheets-trigger").click();
    await expect(page.getByTestId("sheet-list")).not.toContainText("label unverified");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
