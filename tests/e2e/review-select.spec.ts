import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { installRpcControl } from "./rpc-control.ts";
import { createProject, importPdf, offlineDesktop, openWindow } from "./workbench-fixture.ts";

test("a selector disabled while its menu is open closes the menu and accepts no choice", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-review-select-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const app = await electron.launch(await offlineDesktop(directory, ["meta"]));

  try {
    const { page } = await openWindow(app);
    await createProject(page, "Selectors");
    await importPdf(app, page, source);
    await installRpcControl(page);
    await page.reload();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const scope = page.getByRole("button", { name: /^Scope:/ });
    const menu = page.getByRole("listbox", { name: "Scope", exact: true });
    const discipline = menu.getByRole("option", { name: "Selected discipline", exact: true });

    // The same option while its menu is closed, which role queries do not reach.
    const hiddenDiscipline = page
      .locator('[role="listbox"][aria-label="Scope"] [role="option"]')
      .filter({ hasText: "Selected discipline" });

    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Lock the selectors while saving");

    // Open the menu from the keyboard; focus rests on the current option.
    await scope.focus();
    await scope.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: "Whole set", exact: true })).toBeFocused();

    // Saving the note makes the workbench busy without touching the menu.
    await page.evaluate(() => window.rpcControl.hold("ReviewCommand"));
    await page.evaluate(() =>
      document.querySelector<HTMLFormElement>("form.composer")?.requestSubmit(),
    );
    await expect
      .poll(() => page.evaluate(() => window.rpcControl.held()))
      .toEqual(["ReviewCommand"]);
    await expect(scope).toBeDisabled();
    await expect(menu).toBeHidden();
    await expect(hiddenDiscipline).toBeDisabled();

    // Neither the keyboard nor a click on the closed menu's option changes the choice.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await hiddenDiscipline.dispatchEvent("click");
    await expect(scope).toHaveAccessibleName("Scope: Whole set");

    await page.evaluate(() => window.rpcControl.release("ReviewCommand"));
    await expect(page.getByRole("status").filter({ hasText: "Note saved." })).toBeVisible();
    await expect(scope).toBeEnabled();
    await expect(scope).toHaveAccessibleName("Scope: Whole set");

    // Once enabled again, the selector works normally.
    await scope.click();
    await expect(menu).toBeVisible();
    await discipline.click();
    await expect(scope).toHaveAccessibleName("Scope: Selected discipline");
    await expect(menu).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
