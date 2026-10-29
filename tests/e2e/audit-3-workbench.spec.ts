import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("conversation scope is restored and invalid restore explains the selection before confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit3-workbench-"));
  const empty = join(directory, "not-a-package");
  await mkdir(empty);

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Scope isolation");
    await page.getByTestId("create-project-button").click();
    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Selected discipline", exact: true }).click();
    await page.getByTestId("new-conversation").click();
    await expect(page.getByRole("button", { name: /^Scope:/ })).toContainText("Whole set");
    await page.getByRole("button", { name: "Drawing coordination", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Scope:/ })).toContainText(
      "Selected discipline",
    );
    await page.setViewportSize({ width: 850, height: 600 });
    await expect(page.locator(".sheets-trigger")).toBeVisible();
    await expect(page.locator(".compact-project")).toContainText("Scope isolation");
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showMessageBox = async () => {
        throw new Error("Invalid packages must not reach replacement confirmation");
      };
    }, empty);
    await page.getByRole("button", { name: "Restore package", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("manifest is missing");
    await expect(page.getByRole("alert")).toContainText("Your workspace has not changed");
    await expect(page.getByRole("alert")).not.toContainText("Reopen");
    await expect(page.locator(".compact-project")).toContainText("Scope isolation");
    await page.screenshot({ path: test.info().outputPath("audit3-compact-invalid-package.png") });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
