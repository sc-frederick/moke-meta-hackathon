import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop RPC persists a note across app restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-smoke-"));

  const environment = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || key === "ELECTRON_RUN_AS_NODE" ? [] : [[key, value]],
    ),
  );

  const options: Parameters<typeof electron.launch>[0] = {
    args: ["."],
    env: { ...environment, PROJECT_KIT_DATA_DIRECTORY: directory },
  };

  const executable = process.env.PROJECT_KIT_EXECUTABLE;

  if (executable !== undefined) {
    options.executablePath = executable;
    options.args = [];
  }

  const launch = () => electron.launch(options);

  const app = await launch();

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Save note" })).toBeEnabled();
    await page.getByLabel("New note").fill("Saved through Electron RPC");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByRole("list", { name: "Saved notes" })).toContainText(
      "Saved through Electron RPC",
    );
    await page.screenshot({ path: test.info().outputPath("desktop.png") });
  } finally {
    await app.close();
  }

  const restarted = await launch();

  try {
    const page = await restarted.firstWindow();
    await expect(page.getByRole("list", { name: "Saved notes" })).toContainText(
      "Saved through Electron RPC",
    );
  } finally {
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});
