import { _electron as electron, expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inventoryReport } from "../../backend/segmentation/inventory-report.ts";
import {
  FixtureSchedule,
  InventoryFixture,
  reconcileFixtures,
} from "../../backend/segmentation/reconciliation.ts";

test("offline fixture worksheet supports correction, completion, persistence, and revision isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-reconcile-"));

  const schedule = Schema.decodeUnknownSync(FixtureSchedule)({
    rows: [{ mark: "WC", description: "Water closet", quantity: 1 }],
  });

  const fixture = Schema.decodeUnknownSync(InventoryFixture)({
    id: "wc-1",
    mark: "WC",
    room: "Test restroom",
    scope: "unclear",
    crop: "test",
    pdf: "test.pdf",
    page: 2,
    evidence: "available",
    proposal: { left: 10, top: 20, right: 40, bottom: 60 },
  });

  const rows = await Effect.runPromise(reconcileFixtures(schedule, [fixture], ["WC"]));
  const first = join(directory, "report.html");
  const second = join(directory, "revision.html");

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=",
    "base64",
  );

  const evidence = [
    {
      id: "test",
      caption: "Test evidence",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><title>Mask</title></svg>',
      boxesSvg: '<svg xmlns="http://www.w3.org/2000/svg"><title>Original proposal</title></svg>',
    },
  ];

  await Bun.write(first, inventoryReport(rows, [fixture], evidence, png, "first"));
  await Bun.write(second, inventoryReport(rows, [fixture], evidence, png, "second"));
  const main = join(directory, "main.cjs");
  const exported = join(directory, "decisions.json");
  await Bun.write(
    main,
    `const { app, BrowserWindow } = require("electron"); app.setPath("userData", ${JSON.stringify(join(directory, "profile"))}); app.whenReady().then(() => { const window = new BrowserWindow({ show: false }); window.webContents.session.on("will-download", (_event, item) => item.setSavePath(${JSON.stringify(exported)})); window.loadFile(${JSON.stringify(first)}); });`,
  );
  const app = await electron.launch({ args: [main] });

  try {
    const page = await app.firstWindow();
    const count = page.locator('[data-total="WC"] [data-count]');
    const delta = page.locator('[data-total="WC"] [data-delta]');
    const include = page.getByRole("checkbox", { name: "Include wc-1" });

    const complete = page.getByRole("checkbox", {
      name: "Completed: review WC evidence and schedule reconciliation",
    });

    await expect(count).toHaveText("1");
    const baseline = await page.locator("img[data-evidence]").getAttribute("src");
    await page.getByRole("button", { name: "Show SAM masks" }).click();
    await expect(page.getByRole("button", { name: "Show Muse boxes only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await page.locator("img[data-evidence]").getAttribute("src")).not.toBe(baseline);
    await include.uncheck();
    await expect(count).toHaveText("0");

    await page.getByRole("button", { name: "Export review decisions" }).click();
    await expect.poll(() => Bun.file(exported).exists()).toBe(true);
    const decisions = await Bun.file(exported).text();
    expect(decisions).toContain('"decision": "excluded"');
    expect(decisions).toContain('"proposal":');
    expect(decisions).toContain('"reportRevision": "first"');
    await expect(delta).toHaveText("-1");
    await complete.focus();
    await page.keyboard.press("Space");
    await expect(complete).toBeChecked();
    await page.reload();
    await expect(include).not.toBeChecked();
    await expect(complete).toBeChecked();
    await expect(count).toHaveText("0");

    const pdfSize = await app.evaluate(async ({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();

      if (!window) throw new Error("The report window is missing.");

      return (await window.webContents.printToPDF({})).length;
    });

    expect(pdfSize).toBeGreaterThan(100);
    await expect(complete).toBeChecked();
    await page.goto(pathToFileURL(second).href);
    await expect(include).toBeChecked();
    await expect(complete).not.toBeChecked();
    await page.getByRole("button", { name: "Reset local review selections" }).click();
    await expect(count).toHaveText("1");
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("Storage blocked for test");
        },
      });
    });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText(
      "Storage unavailable. Selections are temporary.",
    );
    await include.uncheck();
    await expect(count).toHaveText("0");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
