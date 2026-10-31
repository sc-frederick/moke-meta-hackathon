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
    // Returning to the same bottom position by hand resumes following.
    await page.mouse.wheel(0, 3000);
    await expect.poll(distanceFromLatest).toBeLessThan(4);
    await grow(5);
    await expect.poll(distanceFromLatest).toBeLessThan(4);
    await page.mouse.wheel(0, -600);
    await expect.poll(distanceFromLatest).toBeGreaterThan(400);
    await grow(5);
    await expect.poll(distanceFromLatest).toBeGreaterThan(400);

    // If resizing makes the whole thread visible, shrinking it should keep the latest in view.
    await page.setViewportSize({ width: 1200, height: 7000 });
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight === element.clientHeight))
      .toBe(true);
    // Let the browser deliver the scroll event caused by clamping the old position to zero.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.setViewportSize({ width: 1200, height: 700 });
    await grow(5);
    await expect.poll(distanceFromLatest).toBeLessThan(4);

    // At the exact top, fitting the thread does not need to emit another scroll event.
    await viewport.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await page.setViewportSize({ width: 1200, height: 10000 });
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight === element.clientHeight))
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.setViewportSize({ width: 1200, height: 700 });
    await grow(5);
    await expect.poll(distanceFromLatest).toBeLessThan(4);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
