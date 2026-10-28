import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("review workbench creates a project and coordinates a finding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-review-"));
  const fixturePath = join(directory, "rev-a.pdf");
  await writeFile(fixturePath, createHeroPdf("A"));

  const environment = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || key === "ELECTRON_RUN_AS_NODE" ? [] : [[key, value]],
    ),
  );

  const options: Parameters<typeof electron.launch>[0] = {
    args: ["."],
    env: {
      ...environment,
      PROJECT_KIT_DATA_DIRECTORY: directory,
      DISPLAY: environment.DISPLAY ?? ":0",
    },
  };

  const executable = process.env.PROJECT_KIT_EXECUTABLE;

  if (executable !== undefined) {
    options.executablePath = executable;
    options.args = [];
  }

  const app = await electron.launch(options);

  try {
    const page = await app.firstWindow();

    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixturePath);

    await expect(page.getByTestId("review-workbench")).toBeVisible({ timeout: 20000 });

    await page.getByTestId("project-name-input").fill("Hero coordination");
    await page.getByTestId("create-project-button").click();

    await expect(page.getByTestId("import-pdf")).toBeEnabled({ timeout: 20000 });
    await page.getByTestId("import-pdf").click();

    await expect(page.getByTestId("sheet-list").locator("li").first()).toBeVisible({
      timeout: 30000,
    });

    const confirmButtons = page.getByTestId(/^confirm-sheet-/);
    const count = await confirmButtons.count();

    for (let index = 0; index < count; index += 1) {
      await confirmButtons.nth(index).click();
    }

    await page.getByTestId("open-create-finding").click();
    await page
      .getByTestId("create-finding-form")
      .locator("input")
      .first()
      .fill("Room 101 lighting schedule mismatch");
    await page
      .getByTestId("create-finding-form")
      .locator("select")
      .first()
      .selectOption({ index: 1 });
    await page
      .getByTestId("create-finding-form")
      .locator("select")
      .nth(1)
      .selectOption({ index: 2 });
    await page.getByTestId("create-finding-form").locator('input[type="checkbox"]').check();
    await page.getByTestId("create-finding-submit").click();

    await page.getByRole("button", { name: "Open findings" }).click();
    await expect(page.getByTestId(/^finding-row-/).first()).toBeVisible({ timeout: 15000 });
    await page
      .getByTestId(/^finding-row-/)
      .first()
      .click();
    await expect(page.getByTestId("source-panel")).toBeVisible();
    await expect(page.getByTestId("finding-inspector")).toBeVisible();

    await page.getByTestId("drawn-count-input").fill("2");
    await page.getByTestId("drawn-statement-input").fill("Two type A lights on L-101");
    await page.getByTestId("drawn-rationale-input").fill("Counted from plan symbols");
    await page.getByTestId("drawn-coverage-checkbox").check();
    await page.getByTestId("accept-drawn-count").click();

    await page.getByTestId("scheduled-count-input").fill("3");
    await page.getByTestId("scheduled-statement-input").fill("Three required type A lights on L-601");
    await page.getByTestId("scheduled-rationale-input").fill("Schedule table total");
    await page.getByTestId("scheduled-coverage-checkbox").check();
    await page.getByTestId("accept-scheduled-count").click();

    await page.getByTestId("evaluate-finding").click();
    await expect(page.getByTestId("check-history").locator("li")).toHaveCount(1, {
      timeout: 15000,
    });

    await page.screenshot({ path: test.info().outputPath("review-workbench.png") });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
