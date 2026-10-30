import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("Initial Review stays through a split first set and leaves once a revision is linked", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-initial-review-"));
  const fixture = join(directory, "First set.pdf");
  const credentialFile = join(directory, "offline-provider-config.json");
  await writeFile(fixture, createHeroPdf("A"));
  await writeFile(
    credentialFile,
    JSON.stringify({
      providers: [
        {
          provider: "meta",
          apiKey: "offline-ui-test-never-dispatched",
          baseUrl: "https://api.meta.ai/v1",
          model: "muse-spark-1.3",
        },
      ],
    }),
    { mode: 0o600 },
  );

  const environment = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ||
      [
        "ELECTRON_RUN_AS_NODE",
        "MOKE_SESSION_CREDENTIAL_FILE",
        "MODEL_API_KEY",
        "BASETEN_API_KEY",
        "MODAL_TOKEN_ID",
        "MODAL_TOKEN_SECRET",
        "MOKE_MODAL_CONFIG",
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
      MOKE_SESSION_CREDENTIAL_FILE: credentialFile,
    },
  };

  if (process.env.PROJECT_KIT_EXECUTABLE !== undefined) {
    options.executablePath = process.env.PROJECT_KIT_EXECUTABLE;
    options.args = [`--user-data-dir=${join(directory, "profile")}`];
    options.cwd = directory;
  }

  const app = await electron.launch(options);
  const rendererErrors: string[] = [];

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("First submittal proof");
    await page.getByTestId("create-project-button").click();
    const initial = page.getByRole("button", { name: "Initial Review", exact: true });
    await expect(initial).toHaveCount(0);

    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId(/^confirm-sheet-/)).toHaveCount(2);
    const closePanel = page.getByRole("button", { name: "Close source panel", exact: true });
    await closePanel.click();
    await expect(initial).toBeEnabled();
    await expect(initial).toHaveAccessibleDescription(
      "Whole set · all disciplines · four passes · Muse Spark 1.3 · on this computer",
    );

    // A second PDF imported before any review is part of the first set.
    await page.getByTestId("import-pdf").click();
    const second = page.getByRole("dialog", { name: "Import revision", exact: true });
    await second.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(second).toBeHidden();
    await closePanel.click();
    await expect(initial).toBeEnabled();

    // Linking the new PDF's sheets to the earlier ones declares it a revised set.
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    const confirmations = page.getByTestId(/^revision-confirm-/);
    await expect(confirmations).toHaveCount(2);

    for (const confirmation of await confirmations.all()) await confirmation.check();

    await page.getByTestId("apply-revision").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved revision decisions" }),
    ).toBeVisible();
    await closePanel.click();
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await expect(initial).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
