import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electron } from "./isolated-electron.ts";
import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";

test("count creation focuses its form, source pages navigate, and removed revision decisions survive reopen", async () => {
  test.setTimeout(120000);
  // Revision previews render on demand; a cold PDF worker on macOS CI took longer than 5 s.
  const previewWait = { timeout: 15000 };
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-sheets-"));
  const baseline = join(directory, "five-pages.pdf");
  const revision = join(directory, "four-pages.pdf");
  await writeFile(baseline, buildMinimalPdf(0, 612, 792, 1, 5));
  await writeFile(revision, buildMinimalPdf(0, 612, 792, 1, 4));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Revision removal regression");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, baseline);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(5);
    await page.getByTestId("read-sheet-labels").click();
    const suggestions = page.getByRole("region", { name: "Suggested sheet names", exact: true });
    await expect(suggestions.getByText("No unambiguous name found", { exact: true })).toHaveCount(
      5,
    );
    await expect(page.getByTestId("apply-sheet-labels")).toBeDisabled();
    await suggestions.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByLabel("Find a sheet", { exact: true }).fill("page 4");
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("sheet-list")).toContainText("Page 4");
    await page.getByLabel("Find a sheet", { exact: true }).fill("");
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("1 of 5");
    const sourceImage = page.locator(".viewer img");
    await expect(sourceImage).toBeVisible();
    const fittedWidth = (await sourceImage.boundingBox())?.width ?? 0;
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    const zoomedWidth = (await sourceImage.boundingBox())?.width ?? 0;
    expect(zoomedWidth).toBeGreaterThan(fittedWidth * 1.2);
    await page.getByRole("button", { name: "Next sheet", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("2 of 5");
    await expect(page.locator(".source-provenance")).toContainText("Page 2");
    // Sheet navigation keeps the reviewer's zoom.
    await expect
      .poll(async () => (await sourceImage.boundingBox())?.width ?? 0)
      .toBeGreaterThan(fittedWidth * 1.2);
    await page.getByRole("button", { name: "Previous sheet", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("1 of 5");
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    // Opening a sheet from the inventory is a new context and starts fitted.
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(sourceImage).toBeVisible();
    await expect
      .poll(async () => (await sourceImage.boundingBox())?.width ?? 0)
      .toBeLessThan(fittedWidth * 1.05);
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByTestId("open-create-finding").click();
    await expect(page.getByLabel("Check name", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Check name", { exact: true })).toBeInViewport();
    await page
      .getByTestId("create-finding-form")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, revision);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(2);
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    const mapping = page.getByRole("region", { name: "Sheet revision mapping" });
    const rows = mapping.getByTestId(/^revision-row-/);
    const maps = page.getByTestId(/^revision-map-/);
    await expect(maps).toHaveCount(5);
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("No page selected");
    await expect(
      rows
        .first()
        .getByTestId(/^revision-old-preview-/)
        .locator("img"),
    ).toBeVisible(previewWait);

    for (let index = 0; index < 4; index++) {
      await maps.nth(index).selectOption({ index: index + 2 });
      await page
        .getByTestId(/^revision-content-/)
        .nth(index)
        .selectOption("unchanged");
      await page
        .getByTestId(/^revision-confirm-/)
        .nth(index)
        .check();
    }

    await maps.nth(4).selectOption("removed");
    await page
      .getByTestId(/^revision-confirm-/)
      .nth(4)
      .check();
    await expect(rows.nth(4)).toContainText("No replacement page");
    const firstOldPreview = rows.first().getByTestId(/^revision-old-preview-/);
    const firstNewPreview = rows.first().getByTestId(/^revision-new-preview-/);
    await expect(firstNewPreview.locator("img")).toBeVisible();
    const oldBounds = await firstOldPreview.boundingBox();
    const newBounds = await firstNewPreview.boundingBox();
    const rowBounds = await rows.first().boundingBox();
    expect(oldBounds).not.toBeNull();
    expect(newBounds).not.toBeNull();
    expect(rowBounds).not.toBeNull();

    if (oldBounds && newBounds && rowBounds) {
      expect(newBounds.x).toBeGreaterThan(oldBounds.x + oldBounds.width);
      expect(Math.abs(newBounds.y - oldBounds.y)).toBeLessThan(2);
      expect(rowBounds.height).toBeLessThan(150);
    }

    const selectedReplacement = await maps.first().inputValue();
    await rows
      .first()
      .getByRole("button", { name: "Preview previous Page 1", exact: true })
      .click();
    const comparison = page.getByRole("dialog", { name: "Compare revision pages", exact: true });
    await expect(comparison).toBeVisible();
    await expect(comparison.locator("img")).toHaveCount(2);
    await expect(comparison.getByText("Page 1", { exact: true })).toHaveCount(2);
    // Escape belongs to the modal comparison; the revision panel underneath stays open.
    await page.keyboard.press("Escape");
    await expect(comparison).toBeHidden();
    await expect(mapping).toBeVisible();
    await expect(maps.first()).toHaveValue(selectedReplacement);
    await expect(page.getByTestId(/^revision-content-/).first()).toHaveValue("unchanged");
    await expect(page.getByTestId(/^revision-confirm-/).first()).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("audit-3-paired-revision-draft.png") });
    await page.getByTestId("apply-revision").click();
    await expect(
      mapping.getByText("Saved: Removed from this revision", { exact: true }),
    ).toBeVisible();
    await expect(mapping.getByText(/Saved: Page [1-4] · unchanged · confirmed/)).toHaveCount(4);
    await expect(mapping.getByTestId(/^revision-old-preview-/)).toHaveCount(5);
    await expect(
      rows
        .first()
        .getByTestId(/^revision-new-preview-/)
        .locator("img"),
    ).toBeVisible(previewWait);
    await expect(rows.nth(4)).toContainText("No replacement page");
    await page.screenshot({ path: test.info().outputPath("audit-3-removed-revision.png") });
    await page.reload();
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    await expect(
      page.getByText("Saved: Removed from this revision", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("apply-revision")).toBeDisabled();
    await expect(
      rows
        .first()
        .getByTestId(/^revision-old-preview-/)
        .locator("img"),
    ).toBeVisible(previewWait);
    await expect(
      rows
        .first()
        .getByTestId(/^revision-new-preview-/)
        .locator("img"),
    ).toBeVisible(previewWait);
    await expect(rows.nth(4)).toContainText("No replacement page");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new page is unmatched until every earlier sheet is decided, then shown as added", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-added-sheet-"));
  const baseline = join(directory, "three-pages.pdf");
  const revision = join(directory, "four-pages.pdf");
  await writeFile(baseline, buildMinimalPdf(0, 612, 792, 1, 3));
  await writeFile(revision, buildMinimalPdf(0, 612, 792, 1, 4));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Revision added-page regression");
    await page.getByTestId("create-project-button").click();

    for (const source of [baseline, revision]) {
      await app.evaluate(({ dialog }, filename) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      }, source);
      await page.getByTestId("import-pdf").click();
      await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    }

    await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(2);
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    const mapping = page.getByRole("region", { name: "Sheet revision mapping" });
    const added = mapping.getByRole("region", { name: "New pages in this revision" });
    await expect(added.getByTestId(/^revision-added-/)).toHaveCount(4);

    const maps = page.getByTestId(/^revision-map-/);

    for (let index = 0; index < 3; index++) {
      await maps.nth(index).selectOption({ index: index + 2 });
      await page
        .getByTestId(/^revision-content-/)
        .nth(index)
        .selectOption("unchanged");
      await page
        .getByTestId(/^revision-confirm-/)
        .nth(index)
        .check();
    }

    // Drafts do not settle the new page; it may still be an earlier sheet's replacement.
    await expect(added.getByTestId(/^revision-added-/)).toHaveCount(1);
    await expect(added).toContainText("New or unmatched pages");
    await expect(added).toContainText("Unmatched · requires fresh review");
    await page.getByTestId("apply-revision").click();
    await expect(added).toContainText("Added in this revision");
    await expect(added.getByTestId(/^revision-added-/)).toContainText("Page 4");
    await expect(added).toContainText("Added · requires fresh review");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
