import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("project dialogs, selectors, settings, visual evidence selection, and chat work together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-polish-"));
  const fixture = join(directory, "Revision A.pdf");
  await writeFile(fixture, createHeroPdf("A"));

  const environment = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ||
      [
        "ELECTRON_RUN_AS_NODE",
        "MOKE_SESSION_CREDENTIAL_FILE",
        "BASETEN_API_KEY",
        "MODEL_API_KEY",
      ].includes(key)
        ? []
        : [[key, value]],
    ),
  );

  const options: Parameters<typeof electron.launch>[0] = {
    args: [".", `--user-data-dir=${join(directory, "profile")}`],
    env: {
      ...environment,
      PROJECT_KIT_DATA_DIRECTORY: directory,
      MODEL_API_KEY: "local-ui-test-never-dispatched",
    },
  };

  if (process.env.PROJECT_KIT_EXECUTABLE !== undefined) {
    options.executablePath = process.env.PROJECT_KIT_EXECUTABLE;
    options.args = [`--user-data-dir=${join(directory, "profile")}`];
    options.cwd = directory;
  }

  const app = await electron.launch(options);

  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId("review-workbench")).toBeVisible();
    await expect(page.getByTestId("create-project-form")).not.toBeVisible();
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "New project", exact: true });
    await expect(projectDialog).toBeVisible();
    await expect(page.getByTestId("project-name-input")).toBeFocused();
    await page.getByTestId("project-name-input").fill("   ");
    await expect(page.getByTestId("create-project-button")).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await expect(projectDialog).toBeVisible();
    await page.getByTestId("project-name-input").fill("Audit coordination");
    await page.getByTestId("project-name-input").press("Enter");
    await expect(projectDialog).not.toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "Audit coordination",
    );

    const model = page.getByRole("button", { name: /^Model:/ });
    await model.click();
    await expect(page.getByRole("listbox", { name: "Model", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /SAM/ })).toHaveCount(0);
    const sparkOpen = page.getByRole("option", { name: /Muse Spark Open/ });

    // Packaged launches intentionally ignore development env credentials.
    if (!process.env.PROJECT_KIT_EXECUTABLE) {
      await expect(sparkOpen).toBeDisabled();
      await page.getByRole("option", { name: /Muse Wonder/ }).click();
      await expect(model).toContainText("Muse Wonder");
    } else await page.keyboard.press("Escape");
    const reviewer = page.getByRole("button", { name: /^Reviewer:/ });
    await expect(reviewer).toContainText("Auto");
    await reviewer.click();
    const menu = page.getByRole("listbox", { name: "Reviewer", exact: true });
    const menuBounds = await menu.boundingBox();
    const triggerBounds = await reviewer.boundingBox();
    expect(menuBounds && triggerBounds && menuBounds.y + menuBounds.height <= triggerBounds.y).toBe(
      true,
    );
    expect(
      await menu.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius)),
    ).toBeGreaterThanOrEqual(8);
    await page.getByRole("option", { name: "Electrical", exact: true }).click();
    await expect(reviewer).toContainText("Electrical");
    await reviewer.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(reviewer).toContainText("Auto");

    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await expect(page.getByTestId(/^confirm-sheet-/)).toHaveCount(2);
    await page.locator(".sheets-trigger").click();
    await expect(page.getByTestId("source-panel")).not.toBeVisible();
    await page.locator(".sheets-trigger").click();
    await expect(page.getByTestId("source-panel")).toBeVisible();
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });
    await expect(settings).toBeVisible();
    const bounds = await settings.boundingBox();
    expect(bounds && Math.abs(bounds.x + bounds.width / 2 - 720)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await expect(page.getByTestId("source-panel")).toBeVisible();

    for (let index = 0; index < 2; index++)
      await page
        .getByTestId(/^confirm-sheet-/)
        .nth(index)
        .click();
    await page.getByTestId("open-create-finding").click();
    const form = page.getByTestId("create-finding-form");
    await form.getByLabel("Check name", { exact: true }).fill("Room 101 lights");
    await form.getByLabel("What are you counting?").fill("Type A luminaires in Room 101");
    await form.locator("select").first().selectOption({ index: 1 });
    await form.locator("select").nth(1).selectOption({ index: 2 });
    await form.locator('input[type="checkbox"]').check();
    await page.getByTestId("create-finding-submit").click();
    await expect(page.getByTestId("finding-inspector")).toBeVisible();
    await expect(page.getByTestId("drawn-region-x")).not.toBeVisible();
    await page.getByRole("button", { name: "Select area on drawing", exact: true }).first().click();
    await expect(page.getByText("Drag a box around the area to count.")).toBeVisible();
    const image = page.getByRole("region", { name: "Original source render" }).locator("img");
    await expect(image).toBeVisible();
    const imageBounds = await image.boundingBox();

    if (!imageBounds) throw new Error("Source image has no bounds");
    await page.mouse.move(
      imageBounds.x + imageBounds.width * 0.2,
      imageBounds.y + imageBounds.height * 0.25,
    );
    await page.mouse.down();
    await page.mouse.move(
      imageBounds.x + imageBounds.width * 0.4,
      imageBounds.y + imageBounds.height * 0.5,
    );
    await page.mouse.up();
    const selectedWidth = Number(await page.getByTestId("drawn-region-width").inputValue());
    const selectedHeight = Number(await page.getByTestId("drawn-region-height").inputValue());
    expect(selectedWidth).toBeCloseTo(612 * 0.2, 0);
    expect(selectedHeight).toBeCloseTo(792 * 0.25, 0);
    await page.getByTestId("drawn-count-input").fill("2");
    await page
      .getByTestId("drawn-statement-input")
      .fill("Two type A fixtures in the selected room.");
    await page.getByTestId("drawn-coverage-checkbox").check();
    await page.getByTestId("accept-drawn-count").click();
    await expect(page.getByTestId("evaluate-finding")).toBeEnabled();
    await page.getByRole("button", { name: "Close source panel" }).click();
    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Please confirm the Room 101 lighting count.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator(".reviewer-message")).toContainText(
      "Please confirm the Room 101 lighting count.",
    );
    expect(
      await page
        .locator(".reviewer-message")
        .evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius)),
    ).toBeGreaterThan(10);
    await page.setViewportSize({ width: 760, height: 900 });
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    await expect(settings).toBeVisible();
    const narrowBounds = await settings.boundingBox();
    expect(narrowBounds && narrowBounds.x >= 16 && narrowBounds.x + narrowBounds.width <= 744).toBe(
      true,
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("polished-workbench.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
