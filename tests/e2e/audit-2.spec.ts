import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Artifact, CountFact } from "#lib/review/contracts.ts";
import { transformPoint } from "#lib/review/geometry.ts";
import { buildMinimalPdf } from "../fixtures/generated/minimal-pdf.ts";
import { installRpcBoundary } from "./rpc-boundary.ts";

test("accepting a count on a fitted 36x48 source refreshes with the requested integer DPI", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-large-count-"));
  const fixture = join(directory, "36x48.pdf");
  await writeFile(fixture, buildMinimalPdf(0, 2592, 3456, 1, 2));

  const app = await electron.launch({
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  });

  try {
    const page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Large source count regression");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId("sheet-list").locator("li")).toHaveCount(2);

    for (const row of await page.getByTestId("sheet-list").locator("li").all()) {
      await row.locator("details > summary").click();
      await row.getByTestId(/^confirm-sheet-/).click();
    }

    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByTestId("open-create-finding").click();
    const form = page.getByTestId("create-finding-form");
    await form.locator("input").first().fill("Large-sheet count");
    await form.locator("input").nth(1).fill("Count the vector rectangles on this sheet");
    await form.locator("select").first().selectOption({ index: 1 });
    await form.locator("select").nth(1).selectOption({ index: 2 });
    await form.locator('input[type="checkbox"]').check();
    await page.getByTestId("create-finding-submit").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    const previousImage = await page.locator(".viewer img").getAttribute("src");
    await page.getByTestId("drawn-count-input").fill("2");
    await page
      .getByTestId("drawn-statement-input")
      .fill("Two vector rectangles on the 36x48 source.");
    await page.getByTestId("accept-drawn-count").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    await expect(page.locator(".viewer img")).not.toHaveAttribute("src", previousImage ?? "");
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Drawn evidence");
    expect(
      await page.evaluate(() => window.auditRpc.renderDpis.filter((dpi) => dpi !== 24)),
    ).toEqual([96, 96]);
    await page.getByTestId("detail-drawn").click();
    await expect(page.locator(".viewer img")).toBeVisible();
    await page.getByTestId("drawn-count-input").fill("3");
    await page
      .getByTestId("drawn-statement-input")
      .fill("Three rectangles after correcting the accepted count.");
    await page.getByTestId("accept-drawn-count").click();
    await expect
      .poll(() => page.evaluate(() => window.auditRpc.renderDpis.filter((dpi) => dpi !== 24)))
      .toEqual([96, 96, 300, 300]);
    await expect(page.locator(".viewer img")).toBeVisible();
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Drawn evidence");
    await expect(page.locator(".source-scroll .banner")).toHaveCount(0);
    const database = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

    try {
      const artifacts = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(Artifact) })),
      )(
        database
          .prepare(
            "SELECT payload FROM review_records WHERE kind='artifact' AND json_extract(payload,'$.mediaType')='image/png'",
          )
          .all(),
      );

      expect(artifacts.length).toBeGreaterThan(0);
      expect(artifacts.some(({ payload }) => payload.dpi === 96)).toBe(true);
      expect(
        artifacts.some(({ payload }) => payload.dpi < 300 && !Number.isInteger(payload.dpi)),
      ).toBe(true);

      const saved = Schema.decodeUnknownSync(Schema.fromJsonString(CountFact))(
        database
          .prepare(
            "SELECT payload FROM review_records WHERE kind='fact' AND json_extract(payload,'$.state')='accepted' ORDER BY json_extract(payload,'$.version') DESC LIMIT 1",
          )
          .get()?.payload,
      );

      expect(saved.value).toBe(3);

      for (const { payload: artifact } of artifacts) {
        expect(artifact.dpi).toBeGreaterThan(0);
        expect(artifact.dpi).toBeLessThanOrEqual(300);
        expect(artifact.width * artifact.height).toBeLessThanOrEqual(16000000);
        const point = { x: 240, y: 360 };
        const pixels = transformPoint(artifact.pdfToPixels, point.x, point.y);
        const restored = transformPoint(artifact.pixelsToPdf, pixels.x, pixels.y);
        expect(restored.x).toBeCloseTo(point.x, 6);
        expect(restored.y).toBeCloseTo(point.y, 6);
      }
    } finally {
      database.close();
    }

    await page.screenshot({ path: test.info().outputPath("audit-large-count-saved.png") });
    await page.locator(".source-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: test.info().outputPath("audit-large-count-refresh.png") });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit workbench imports native and dropped revisions, assigns compact sheets, fits drawings and submits with Enter", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-ui-"));
  const fixture = join(directory, "36x48.pdf");
  const droppedDirectory = join(directory, "revisions");
  const droppedFixture = join(droppedDirectory, "36x48.pdf");
  await mkdir(droppedDirectory);
  await writeFile(fixture, buildMinimalPdf(0, 2592, 3456));
  await writeFile(droppedFixture, buildMinimalPdf(0, 2592, 3456));

  const app = await electron.launch({
    args: ["."],
    env: {
      PROJECT_KIT_DATA_DIRECTORY: directory,
      MOKE_SESSION_CREDENTIAL_FILE: "",
      MODEL_API_KEY: "",
      BASETEN_API_KEY: "",
    },
  });

  const diagnostics: string[] = [];

  try {
    const page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning") diagnostics.push(message.text());
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("MOKE audit drawing set");
    await page.getByTestId("create-project-button").click();
    await expect(page.locator(".brand-name")).toHaveText("MOKE");
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });
    await settings.getByText("Optional call budget", { exact: true }).click();
    const budget = settings.getByLabel("Maximum provider calls", { exact: true });
    await budget.fill("12");

    const measured = await budget.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      outline: getComputedStyle(element).outlineStyle,
    }));

    expect(measured.width).toBeGreaterThan(350);
    expect(measured.outline).toBe("none");
    await page.screenshot({ path: test.info().outputPath("audit-settings.png") });
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByTestId("import-pdf").click();
    const importer = page.getByRole("dialog", { name: "Import drawings", exact: true });
    await expect(importer).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("audit-import.png") });
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await importer.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    const sheets = page.getByTestId("sheet-list");
    await expect(sheets.locator("li")).toHaveCount(1);
    await expect(sheets.locator("details")).not.toHaveAttribute("open", "");
    await page.getByLabel("Discipline for Page 1", { exact: true }).selectOption("fire_alarm");
    await expect(page.getByLabel("Discipline for Page 1", { exact: true })).toHaveValue(
      "fire_alarm",
    );
    await page.getByLabel("Select all sheets", { exact: true }).check();
    await page
      .getByLabel("Assign selected sheets to discipline", { exact: true })
      .selectOption("fire_sprinkler");
    await expect(page.getByLabel("Discipline for Page 1", { exact: true })).toHaveValue(
      "fire_sprinkler",
    );
    await expect(
      page.getByLabel("Assign selected sheets to discipline", { exact: true }),
    ).toHaveValue("");
    await page.screenshot({ path: test.info().outputPath("audit-sheets.png") });
    await page.getByRole("button", { name: "View sheet", exact: true }).click();
    const canvas = page.getByRole("region", { name: "Original source render", exact: true });
    await expect(canvas.locator("img")).toBeVisible();
    const bounds = await canvas.boundingBox();
    expect(bounds?.width).toBeGreaterThan(1100);
    expect(bounds?.height).toBeGreaterThan(550);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page
      .getByRole("application", { name: "Pan and zoom source canvas", exact: true })
      .press("ArrowRight");
    await page.screenshot({ path: test.info().outputPath("audit-large-drawing.png") });
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    const message = page.getByLabel("Message", { exact: true });
    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    await message.fill("Composing draft");
    await message.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await expect(message).toHaveValue("Composing draft");
    await message.fill("First line");
    await message.press("Shift+Enter");
    await message.press("x");
    await expect(message).toHaveValue("First line\nx");
    await message.press("Enter");
    await expect(message).toHaveValue("");
    await expect(page.locator(".reviewer-message")).toContainText("First line\nx");
    await page.getByTestId("import-pdf").click();
    const revision = page.getByRole("dialog", { name: "Import revision", exact: true });
    await expect(revision.getByLabel("Revision label", { exact: true })).toHaveValue("Rev 1");
    // Upload an OS-backed File to exercise webUtils.getPathForFile through the real isolated preload.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "audit-drop-file";
      input.hidden = true;
      document.body.append(input);
    });
    await page.locator("#audit-drop-file").setInputFiles(droppedFixture);
    await page.evaluate(() => {
      const input = document.querySelector("#audit-drop-file");

      if (!(input instanceof HTMLInputElement) || !input.files?.[0]) throw new Error("No OS file");
      const transfer = new DataTransfer();
      transfer.items.add(input.files[0]);
      document
        .querySelector(".pdf-drop-zone")
        ?.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
    });
    await expect(revision.locator(".pdf-drop-zone strong")).toHaveText("36x48.pdf");
    await page.screenshot({ path: test.info().outputPath("audit-revision-import.png") });
    await page.evaluate(() => {
      window.auditRpc.loseImportResponse = true;
    });
    await revision.getByRole("button", { name: "Import PDF", exact: true }).click();
    await expect(revision.getByRole("alert")).toContainText("lost import response");
    await expect(revision.getByLabel("Revision label", { exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("audit-import-retry.png") });
    await revision.getByRole("button", { name: "Import PDF", exact: true }).click();
    await expect(revision).not.toBeVisible();
    await expect(page.getByLabel("Revision", { exact: true }).locator("option:checked")).toHaveText(
      "Rev 1",
    );
    const imports = await page.evaluate(() => window.auditRpc.imports);
    expect(imports.at(-1)).toBe(imports.at(-2));
    await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(2);
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    await expect(page.getByRole("button", { name: "Import revision", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Import revision", exact: true }).click();
    await expect(revision.getByLabel("Revision label", { exact: true })).toHaveValue("Rev 2");
    const chooser = await app.evaluateHandle(() => ({ directory: "" }));
    await app.evaluate(({ dialog }, captured) => {
      dialog.showOpenDialog = async (options) => {
        captured.directory = "defaultPath" in options ? (options.defaultPath ?? "") : "";

        return { canceled: true, filePaths: [] };
      };
    }, chooser);
    await revision.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    expect((await chooser.jsonValue()).directory).toBe(droppedDirectory);
    await chooser.dispose();
    await revision.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await expect(page.getByText("Local progress is reconnecting.", { exact: false })).toHaveCount(
      0,
    );
    await page.screenshot({ path: test.info().outputPath("audit-conversation.png") });
    await Bun.write(
      test.info().outputPath("audit-console.json"),
      JSON.stringify(diagnostics, null, 2),
    );
    expect(diagnostics).toEqual([]);
  } finally {
    await test.step("close the workbench and its RPC runtime", () => app.close());
    await rm(directory, { recursive: true, force: true });
  }
});

test("52 sheets stay compact and bulk discipline assignments drive explicit scope counts without confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit-large-set-"));
  const fixture = join(directory, "52-sheet-set.pdf");
  await writeFile(fixture, buildMinimalPdf(0, 612, 792, 1, 52));

  const options: Parameters<typeof electron.launch>[0] = {
    args: ["."],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory },
  };

  let app = await electron.launch(options);
  const errors: string[] = [];

  try {
    let page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("52-sheet assignment proof");
    await page.getByTestId("create-project-button").click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    const rows = page.getByTestId("sheet-list").locator("li");
    await expect(rows).toHaveCount(52);
    expect((await rows.first().boundingBox())?.height).toBeLessThan(90);
    await page.getByLabel("Select all sheets", { exact: true }).check();
    await page
      .getByLabel("Assign selected sheets to discipline", { exact: true })
      .selectOption("fire_alarm");
    await expect(page.getByLabel("Discipline for Page 52", { exact: true })).toHaveValue(
      "fire_alarm",
    );
    await page.screenshot({ path: test.info().outputPath("audit-52-sheets.png") });
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Selected sheets", exact: true }).click();
    await page.getByLabel("Select Page 1", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await expect(page.locator(".review-scope")).toContainText("51 sheets");
    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Selected discipline", exact: true }).click();
    await page.getByRole("button", { name: /^Reviewer:/ }).click();
    await page.getByRole("option", { name: "Fire alarm", exact: true }).click();
    await expect(page.locator(".review-scope")).toContainText("52 sheets");
    await page.getByRole("button", { name: /^Reviewer:/ }).click();
    await page.getByRole("option", { name: "Fire sprinkler", exact: true }).click();
    await expect(page.locator(".review-scope")).toContainText("0 sheets");
    await app.close();
    app = await electron.launch(options);
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".sheets-trigger").click();
    await expect(page.getByLabel("Discipline for Page 52", { exact: true })).toHaveValue(
      "fire_alarm",
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
