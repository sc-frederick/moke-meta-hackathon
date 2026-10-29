import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electron } from "./isolated-electron.ts";
import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";

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
    await page.getByLabel("Find a sheet", { exact: true }).fill("page 4");
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("sheet-list")).toContainText("Page 4");
    await page.getByLabel("Find a sheet", { exact: true }).fill("");
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("1 of 5");
    await page.getByRole("button", { name: "Next sheet", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("2 of 5");
    await expect(page.locator(".source-provenance")).toContainText("Page 2");
    await page.getByRole("button", { name: "Previous sheet", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Source sheets" })).toContainText("1 of 5");
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
    const maps = page.getByTestId(/^revision-map-/);
    await expect(maps).toHaveCount(5);

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
    await page.getByTestId("apply-revision").click();
    const mapping = page.getByRole("region", { name: "Sheet revision mapping" });
    await expect(
      mapping.getByText("Saved: Removed from this revision", { exact: true }),
    ).toBeVisible();
    await expect(mapping.getByText(/Saved: Page [1-4] · unchanged · confirmed/)).toHaveCount(4);
    await page.screenshot({ path: test.info().outputPath("audit-3-removed-revision.png") });
    await page.reload();
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    await expect(
      page.getByText("Saved: Removed from this revision", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("apply-revision")).toBeDisabled();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
