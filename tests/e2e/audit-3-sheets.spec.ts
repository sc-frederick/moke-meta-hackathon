import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema, Struct } from "effect";
import { Sheet } from "#lib/review/contracts.ts";
import { electron } from "./isolated-electron.ts";
import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("count creation focuses its form, source pages navigate, and removed revision decisions survive reopen", async () => {
  test.setTimeout(120000);
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
    ).toBeVisible();

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
    ).toBeVisible();
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
    ).toBeVisible();
    await expect(
      rows
        .first()
        .getByTestId(/^revision-new-preview-/)
        .locator("img"),
    ).toBeVisible();
    await expect(rows.nth(4)).toContainText("No replacement page");
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

test("existing generic names have explicit proposals and preserve prior sheet verification after apply and reopen", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-existing-sheet-names-"));
  const source = join(directory, "lighting.pdf");
  await writeFile(source, createHeroPdf("A"));

  const options = { args: ["."], env: { PROJECT_KIT_DATA_DIRECTORY: directory } };
  let app: Awaited<ReturnType<typeof electron.launch>> | null = await electron.launch(options);

  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Existing sheet-name regression");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, source);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(2);
    await app.close();
    app = null;

    const database = new DatabaseSync(join(directory, "app.sqlite"));
    let legacySheets: Array<Sheet> = [];

    try {
      // This is the former importer's persisted inventory, before any new UI opens it.
      legacySheets = readSheetRows(database).map(
        (sheet, index) =>
          new Sheet(
            Struct.assign(sheet, {
              label: `Page ${sheet.pageIndex + 1}`,
              confirmed: index === 0,
              coverage: index === 0 ? ("reviewer_complete" as const) : ("unreviewed" as const),
            }),
          ),
      );

      for (const sheet of legacySheets)
        database
          .prepare(
            "UPDATE review_records SET payload=? WHERE project_id=? AND id=? AND kind='sheet'",
          )
          .run(JSON.stringify(sheet), sheet.projectId, sheet.id);
    } finally {
      database.close();
    }

    await rm(source);
    app = await electron.launch(options);
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator(".sheets-trigger").click();
    const rows = page.getByTestId("sheet-list").locator("li");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Page 1");
    await expect(rows.first()).not.toContainText("label unverified");
    await expect(rows.nth(1)).toContainText("label unverified");
    await page.getByTestId("read-sheet-labels").click();
    const suggestions = page.getByRole("region", { name: "Suggested sheet names", exact: true });
    await expect(suggestions).toContainText("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
    await expect(suggestions).toContainText("L-601 · FIXTURE SCHEDULE AND CONTROL DETAIL · Page 2");
    await expect(rows.first()).toContainText("Page 1");
    await expect(rows.first()).not.toContainText("L-101");
    await page.screenshot({ path: test.info().outputPath("audit-3-existing-name-proposals.png") });
    await page.getByTestId("apply-sheet-labels").click();
    await expect(suggestions).not.toBeVisible();
    await expect(rows.first()).toContainText("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
    await expect(rows.nth(1)).toContainText("L-601 · FIXTURE SCHEDULE AND CONTROL DETAIL · Page 2");
    await expect(rows.first()).not.toContainText("label unverified");
    await expect(rows.nth(1)).toContainText("label unverified");
    await rows.first().getByText("Label & count-check verification", { exact: true }).click();
    await rows.nth(1).getByText("Label & count-check verification", { exact: true }).click();

    const confirmedCoverage = rows
      .first()
      .getByRole("combobox", { name: "Count-check coverage", exact: true });

    const unconfirmedCoverage = rows
      .nth(1)
      .getByRole("combobox", { name: "Count-check coverage", exact: true });

    await expect(confirmedCoverage).toBeVisible();
    await expect(confirmedCoverage).toHaveValue("reviewer_complete");
    await expect(unconfirmedCoverage).toBeVisible();
    await expect(unconfirmedCoverage).toHaveValue("unreviewed");
    await page.screenshot({ path: test.info().outputPath("audit-3-existing-names-applied.png") });

    const saved = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

    try {
      expect(readSheetRows(saved).map((sheet) => Struct.assign(sheet, { label: "" }))).toEqual(
        legacySheets.map((sheet) => Struct.assign(sheet, { label: "" })),
      );
    } finally {
      saved.close();
    }

    await page.reload();
    await page.locator(".sheets-trigger").click();
    await expect(rows.first()).toContainText("L-101 · FLOOR 1 LIGHTING PLAN | REV A · Page 1");
    await expect(rows.nth(1)).toContainText("label unverified");
    await expect(page.getByTestId("read-sheet-labels")).toBeDisabled();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function readSheetRows(database: DatabaseSync): Array<Sheet> {
  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload: Schema.String })))(
    database
      .prepare(
        "SELECT payload FROM review_records WHERE kind='sheet' ORDER BY json_extract(payload,'$.pageIndex')",
      )
      .all(),
  ).map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(Sheet))(row.payload));
}

test("a thread keeps following rapid updates until the reader scrolls up", async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-3-follow-latest-"));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Follow-latest regression");
    await page.getByTestId("create-project-button").click();
    const viewport = page.locator(".chat-scroll");
    await expect(viewport).toBeVisible();

    // Stand in for streamed review progress: the thread grows in quick successive tasks, so it
    // can grow again between an automatic scroll and the scroll event that write queues.
    const grow = (blocks: number) =>
      viewport.evaluate(async (element, count) => {
        const content = element.querySelector(".conversation-content");

        if (content === null) throw new Error("Missing conversation content");

        for (let index = 0; index < count; index++) {
          const block = document.createElement("div");
          block.style.height = "80px";
          content.append(block);
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
      }, blocks);

    const distanceFromLatest = () =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      );

    await grow(60);
    await expect.poll(distanceFromLatest).toBeLessThan(4);

    await viewport.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(distanceFromLatest).toBeGreaterThan(400);
    await grow(5);
    await expect.poll(distanceFromLatest).toBeGreaterThan(400);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
