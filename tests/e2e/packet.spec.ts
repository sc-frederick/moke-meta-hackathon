import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema, Struct } from "effect";
import { CloudReviewRecord } from "../../backend/cloud/contracts.ts";
import { writeCloudState } from "../../backend/cloud/files.ts";
import { Artifact, Project, Revision, ReviewMessage, Sheet } from "#lib/review/contracts.ts";
import { PacketReview, PacketScope, ReviewPass, PacketFindingSummary } from "#lib/review/packet.ts";
import { transformRegion } from "#lib/review/geometry.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { installRpcBoundary } from "./rpc-boundary.ts";

test("document QA needs no count check and persisted findings support evidence, completion, and reopen", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-desktop-"));
  const fixture = join(directory, "Drawing packet.pdf");
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
        {
          provider: "baseten",
          apiKey: "offline-ui-test-never-dispatched",
          baseUrl: "https://inference.baseten.co/v1",
          model: "meta-models/muse-spark-open-1026",
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

  let app = await electron.launch(options);
  const rendererErrors: string[] = [];

  try {
    let page = await app.firstWindow();
    const monitor = () => page.on("pageerror", (error) => rendererErrors.push(error.message));
    monitor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId("review-workbench")).toBeVisible();
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Packet QA desktop proof");
    await page.getByTestId("create-project-button").click();
    await expect(page.getByTestId("import-pdf")).toBeEnabled();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId(/^confirm-sheet-/)).toHaveCount(2);
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Check:/ })).toHaveCount(0);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Run a quick QA pass on this drawing set.");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Scope:/ })).toContainText("Whole set");

    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Selected discipline", exact: true }).click();
    const reviewer = page.getByRole("button", { name: /^Reviewer:/ });
    await reviewer.click();
    await page.getByRole("option", { name: "Electrical", exact: true }).click();
    await expect(reviewer).toContainText("Electrical");
    await reviewer.click();
    await page.getByRole("option", { name: "Choose discipline…", exact: false }).click();
    await expect(reviewer).toContainText("Choose discipline…");
    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Whole set", exact: true }).click();
    await expect(reviewer).toContainText("All disciplines");
    const model = page.getByRole("button", { name: /^Model:/ });
    await model.click();
    await expect(page.getByRole("option", { name: /SAM/ })).toHaveCount(0);
    await page.getByRole("option", { name: /Muse Spark Open/ }).click();
    await expect(model).toContainText("Muse Spark Open");
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });
    await expect(settings).toContainText("Baseten Connected");
    await expect(
      settings.getByRole("button", { name: /^Maximum calls per inspection:/ }),
    ).toHaveCount(0);
    await expect(settings).not.toContainText("64,000");
    await expect(settings).not.toContainText("two SAM");
    await settings.getByText("Optional call budget", { exact: true }).click();
    const budget = settings.getByLabel("Maximum provider calls", { exact: true });
    await expect(budget).toHaveValue("");
    await budget.fill("7");
    await expect(budget).toHaveValue("7");
    await budget.fill("");
    const checklist = settings.getByTestId("firm-checklist");
    await checklist
      .getByLabel("Firm checklist", { exact: true })
      .fill("- Every sheet carries the firm's seal block.");
    await checklist.getByRole("button", { name: "Save checklist", exact: true }).click();
    await expect(checklist).toContainText("Revision 1");
    await expect(checklist).toContainText("Saved. New reviews will use this revision.");
    await expect(
      checklist.getByRole("button", { name: "Save checklist", exact: true }),
    ).toBeDisabled();
    await settings.screenshot({ path: test.info().outputPath("firm-checklist-settings.png") });
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // The request can start without a check, but this offline UI proof saves a note instead of dispatching a provider.
    const saveNote = page.getByRole("button", { name: "Save as note", exact: true });
    await saveNote.click();
    await expect(saveNote).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note saved." })).toBeVisible();
    await expect(page.getByTestId("packet-review-panel")).toHaveCount(0);
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await app.close();

    const seeded = seedCompletedReview(directory);
    await Effect.runPromise(
      writeCloudState(join(`${directory}.cloud`, "state.json"), [seeded.cloud]),
    );
    app = await electron.launch(options);
    page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    monitor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const cloud = page.getByTestId("cloud-review-controls");
    await expect(cloud).toContainText("Results synced");
    await expect(cloud.locator(".receipt-details")).toHaveCount(0);
    await cloud
      .getByRole("button", { name: "Show transfer and review details", exact: true })
      .click();
    await expect(cloud.locator(".receipt-details")).toBeVisible();
    await cloud
      .getByRole("button", { name: "Hide transfer and review details", exact: true })
      .click();
    await expect(cloud.locator(".receipt-details")).toHaveCount(0);
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable();
    const panel = page.getByTestId("packet-review-panel");
    await expect(panel).toContainText("Whole-set review");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
      "Review finished with coverage gaps",
    );
    await expect(panel).toContainText("1 of 2 sheets opened");
    await expect(panel.locator(".progress")).toContainText("4 of 88 review passes recorded");
    // The gap headline names the recorded pass that is still unsettled.
    await expect(panel.locator(".progress")).toContainText("1 still needs input or a reason");
    await expect(panel).toContainText("Offline desktop fixture");
    await expect(panel.locator(".summary strong")).toHaveText("Offline desktop fixture");
    await expect(panel.locator(".summary code")).toHaveText("saved evidence");
    await expect(panel.locator(".summary")).not.toContainText("**");
    const reportPath = join(directory, "exported-review.html");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, reportPath);
    await page.getByRole("button", { name: "Export review report", exact: true }).click();
    await expect
      .poll(async () => readFile(reportPath, "utf8").catch(() => ""))
      .toContain(seeded.findingTitle);
    const exportedReport = await readFile(reportPath, "utf8");
    expect(exportedReport).toContain("Review finished with coverage gaps.");
    expect(exportedReport).toContain("1 of 2 requested sheets opened");
    expect(exportedReport).toContain("4 of 88 requested review passes recorded");
    expect(exportedReport).toContain("1 unopened sheet; 84 unreviewed passes");
    await panel.getByText("Governing sources and citations", { exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Open source in browser", exact: true }),
    ).toBeVisible();
    await panel.getByText("Saved retrieved text", { exact: true }).click();
    await expect(
      panel.getByText("Stored source text remains inspectable offline.", { exact: true }),
    ).toBeVisible();
    await panel.getByText("Governing sources and citations", { exact: true }).click();
    await page.getByText("Previous reviews in this conversation", { exact: true }).click();
    await page.getByRole("button", { name: "Open saved review", exact: true }).first().click();
    await expect(page.getByTestId("historical-review-panel")).toContainText(seeded.previousSummary);
    const historyPanel = page.getByTestId("historical-review-panel");
    await expect(historyPanel).toContainText("Synthetic saved provider failure");
    await expect(historyPanel).not.toContainText("Cancel this review before starting");
    await historyPanel
      .getByRole("button", { name: "Copy review diagnostics", exact: true })
      .click();
    await expect(historyPanel).toContainText("Review diagnostics copied.");
    const diagnostics = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(JSON.parse(diagnostics)).toMatchObject({
      reviewId: seeded.previousReviewId,
      state: "cancelled",
      model: "meta-models/muse-spark-open-1026",
      error:
        "Synthetic saved provider failure. Cancel this review before starting a separate review.",
    });
    await expect(panel).toContainText(seeded.currentSummary);
    await page.getByRole("button", { name: "Back to latest review", exact: true }).click();
    await expect(panel).toContainText(seeded.currentSummary);

    await expect(page.locator(".application-message")).toContainText(seeded.previousSummary);
    await expect(page.locator(".application-message")).not.toContainText(seeded.currentSummary);
    await expect(page.getByRole("button", { name: /^Check:/ })).toHaveCount(0);
    await panel.getByText("Sheet coverage and review records", { exact: true }).click();
    const coverage = panel.locator(".coverage");
    const filters = coverage.getByRole("group", { name: "Find review records", exact: true });
    const statusFilter = filters.getByLabel("Status", { exact: true });
    const disciplineFilter = filters.getByLabel("Discipline", { exact: true });
    await expect(statusFilter).toHaveValue("attention");
    await expect(panel.getByTestId("coverage-matches")).toContainText(
      "86 matching records across 2 sheets",
    );
    await expect(
      panel
        .getByTestId("discipline-coverage")
        .getByRole("row", { name: /^General / })
        .getByRole("cell"),
    ).toHaveText(["8", "1", "1", "1", "4", "1"]);
    await expect(panel.getByTestId("coverage-record")).toHaveCount(0);
    // Saved configuration keys read as labels, and values keep their original casing.
    await expect(panel.locator(".configuration")).toContainText("Permit stage");
    await expect(panel.locator(".configuration")).not.toContainText("permitStage");
    await expect(panel.locator(".configuration dd").first()).toHaveCSS("text-transform", "none");
    await page.screenshot({ path: test.info().outputPath("audit-coverage-summary.png") });
    await panel.locator(".sheet-coverage > summary").first().click();
    await expect(panel.getByTestId("coverage-record")).toHaveCount(20);
    await expect(coverage).toContainText("Page 1 of 3");
    await coverage.getByRole("button", { name: "Next records", exact: true }).click();
    await expect(panel.getByTestId("coverage-record")).toHaveCount(20);
    await expect(coverage).toContainText("Page 2 of 3");
    await coverage.getByRole("button", { name: "Next records", exact: true }).click();
    await expect(panel.getByTestId("coverage-record")).toHaveCount(2);
    await expect(
      coverage.getByRole("button", { name: "Next records", exact: true }),
    ).toBeDisabled();
    await statusFilter.selectOption("checked");
    await expect(panel.getByTestId("coverage-record")).toHaveCount(1);
    await expect(panel.getByTestId("coverage-record")).toContainText("Checked");
    await statusFilter.selectOption("not_applicable");
    await expect(panel.getByTestId("coverage-record")).toHaveCount(1);
    await expect(panel.getByTestId("coverage-record")).toContainText("Not applicable");
    await expect(panel.getByTestId("coverage-record")).toContainText(
      "This synthetic fixture has no prior comments.",
    );
    await statusFilter.selectOption("unreviewed");
    await disciplineFilter.selectOption("civil");
    await expect(panel.getByTestId("coverage-matches")).toContainText(
      "8 matching records across 2 sheets",
    );
    await expect(panel.getByTestId("coverage-record")).toHaveCount(4);
    await filters.getByRole("searchbox", { name: "Sheet", exact: true }).fill("page 2");
    await expect(panel.locator(".sheet-coverage")).toHaveCount(1);
    await expect(panel.getByTestId("coverage-matches")).toContainText(
      "4 matching records across 1 sheet",
    );
    await expect(panel.locator(".progress")).toContainText("4 of 88 review passes recorded");
    await filters.getByRole("searchbox", { name: "Sheet", exact: true }).fill("");
    await panel.getByText("Sheet coverage and review records", { exact: true }).click();
    const finding = page.getByTestId(`packet-finding-${seeded.findingId}`);
    await finding.click();
    const detail = page.getByTestId("selected-packet-finding");
    await expect(
      detail.getByRole("heading", { name: seeded.findingTitle, exact: true }),
    ).toBeVisible();
    await expect(detail.getByText(seeded.shortObservation, { exact: true })).toBeVisible();
    await expect(detail.getByText(seeded.technicalObservation, { exact: true })).not.toBeVisible();
    await detail.getByText("Full technical finding", { exact: true }).click();
    await expect(detail.getByText(seeded.technicalObservation, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("concise-finding-full-details.png") });
    await detail.getByText("Full technical finding", { exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await expect(page.locator(".viewer .overlay")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("audit-finding-canvas.png") });

    await page.evaluate(() => {
      window.auditRpc.holdRender = true;
    });
    await page
      .getByRole("button", {
        name: "Supplied synthetic drawing packet · Focus detail",
        exact: true,
      })
      .click();
    await expect.poll(() => page.evaluate(() => window.auditRpc.held)).toBe(true);
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: "Second source finding", exact: false })
      .click();
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Second sheet source");
    const secondImage = await page.locator(".viewer img").getAttribute("src");
    const secondOverlay = await page.locator(".viewer .overlay").getAttribute("style");
    await page.evaluate(() => window.auditRpc.release());
    await expect.poll(() => page.evaluate(() => window.auditRpc.held)).toBe(false);
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Second sheet source");
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("style", secondOverlay ?? "");
    await expect(page.locator(".viewer img")).toHaveAttribute("src", secondImage ?? "");
    await page.screenshot({ path: test.info().outputPath("audit-source-race.png") });
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: seeded.findingTitle, exact: false })
      .click();
    await expect(page.locator(".viewer img")).toBeVisible();

    // Exercise the no-artifact fallback with the opposite ordering too.
    await page.evaluate(() => {
      window.auditRpc.holdRender = true;
    });
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: "Second source finding", exact: false })
      .click();
    await expect.poll(() => page.evaluate(() => window.auditRpc.held)).toBe(true);
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: seeded.findingTitle, exact: false })
      .click();
    await expect(page.locator(".viewer .overlay")).toHaveAttribute(
      "title",
      "Supplied synthetic drawing packet",
    );
    const firstImage = await page.locator(".viewer img").getAttribute("src");
    await page.evaluate(async () => {
      window.auditRpc.release();
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator(".viewer .overlay")).toHaveAttribute(
      "title",
      "Supplied synthetic drawing packet",
    );
    await expect(page.locator(".viewer img")).toHaveAttribute("src", firstImage ?? "");

    const completed = page.getByTestId("selected-packet-finding").getByRole("checkbox");

    await completed.click();
    await expect(completed).toBeChecked();
    await expect(page.getByTestId("selected-packet-finding")).toContainText("Needs input");
    const decision = page.getByTestId("finding-decision");
    await decision.getByRole("button", { name: /^Decision:/ }).click();
    await page.getByRole("option", { name: "False alarm", exact: true }).click();
    await decision
      .getByLabel("Reason", { exact: true })
      .fill("The second sheet's schedule already lists these inputs.");
    await decision.getByRole("button", { name: "Save decision", exact: true }).click();
    await expect(decision).toContainText("Saved");
    await expect(page.getByTestId(`packet-finding-${seeded.findingId}`)).toContainText(
      "False alarm",
    );
    await page.screenshot({ path: test.info().outputPath("packet-finding-decision.png") });
    await page.evaluate(() => {
      window.auditRpc.holdRender = true;
    });
    await page
      .getByRole("button", {
        name: "Supplied synthetic drawing packet · Focus detail",
        exact: true,
      })
      .click();
    await expect.poll(() => page.evaluate(() => window.auditRpc.held)).toBe(true);
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.evaluate(async () => {
      window.auditRpc.release();
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator(".viewer")).toHaveCount(0);
    await page.getByTestId("new-conversation").click();
    await expect(panel).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).fill("Review the electrical discipline.");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await page.getByTestId(`conversation-${seeded.conversationId}`).click();
    await expect(panel).toContainText(seeded.findingTitle);
    await expect(
      panel.getByRole("button", { name: "Export HTML report", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("packet-review-workbench.png") });
    await app.close();

    app = await electron.launch(options);
    page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    monitor();
    await expect(page.getByTestId("packet-review-panel")).toContainText(seeded.findingTitle);
    await expect(page.getByTestId(`packet-finding-${seeded.findingId}`)).toContainText(
      "False alarm",
    );
    await page.getByTestId(`packet-finding-${seeded.findingId}`).click();
    await expect(page.getByTestId("selected-packet-finding").getByRole("checkbox")).toBeChecked();
    await expect(
      page.getByTestId("finding-decision").getByLabel("Reason", { exact: true }),
    ).toHaveValue("The second sheet's schedule already lists these inputs.");
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await expect(page.locator(".reviewer-message")).toContainText(
      "Run a quick QA pass on this drawing set.",
    );
    await page.locator(".sheets-trigger").click();

    for (const row of await page.getByTestId("sheet-list").locator("li").all()) {
      await row.locator("details > summary").click();
      await row.getByTestId(/^confirm-sheet-/).click();
    }

    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.getByTestId("open-create-finding").click();
    const form = page.getByTestId("create-finding-form");
    await form.locator("input").first().fill("Count comparison selection");
    await form.locator("input").nth(1).fill("Light fixtures");
    await form.locator("select").first().selectOption({ index: 1 });
    await form.locator("select").nth(1).selectOption({ index: 2 });
    await form.locator('input[type="checkbox"]').check();
    await page.getByTestId("create-finding-submit").click();
    await expect(page.getByTestId("drawn-count-input")).toBeVisible();
    await page.evaluate(() => {
      window.auditRpc.holdSnapshot = true;
    });
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: seeded.findingTitle, exact: false })
      .click();
    await expect(page.getByTestId("selected-packet-finding")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.auditRpc.held)).toBe(true);
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page.evaluate(() => window.auditRpc.release());
    await expect(page.locator(".viewer img")).toBeVisible();
    await expect(page.locator(".findings-bubble")).toBeVisible();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: "Count comparison selection", exact: false })
      .click();
    await expect(page.getByTestId("drawn-count-input")).toBeVisible();
    await expect(page.getByTestId("selected-packet-finding")).toHaveCount(0);
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: "Missing project inputs", exact: false })
      .click();
    await expect(page.getByTestId("selected-packet-finding")).toContainText(
      "No source drawing applies to this missing input.",
    );
    await expect(page.getByTestId("drawn-count-input")).toHaveCount(0);
    await expect(page.locator(".viewer")).toHaveCount(0);
    await expect(page.locator(".source-scroll .banner")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("audit-missing-source-finding.png") });

    // A finding with a SAM zoom opens on it, with the masks drawn over the source.
    await page.getByRole("button", { name: "Open findings", exact: true }).click();
    await page
      .locator(".findings-bubble")
      .getByRole("button", { name: "SAM focus finding", exact: false })
      .click();
    await expect(page.getByTestId("sam-focus-caption")).toContainText(
      "SAM 3.1 focus · 1 segmented object",
    );
    await expect(page.locator(".viewer svg.masks path")).toHaveCount(1);
    await expect(page.locator(".viewer .overlay")).toHaveAttribute("title", "Finding region");
    await expect(
      page.getByRole("button", { name: "SAM focus · 1 segment", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("sam-focus-finding.png") });

    // History is independent of the latest run's controls and composer admission.
    await app.close();
    const controlDatabase = new DatabaseSync(join(directory, "app.sqlite"));

    try {
      const row = controlDatabase
        .prepare("SELECT payload FROM packet_reviews ORDER BY rowid DESC LIMIT 1")
        .get();

      const savedReview = Schema.decodeUnknownSync(Schema.fromJsonString(PacketReview))(
        row?.payload,
      );

      const pausedReview = new PacketReview(
        Struct.assign(savedReview, { state: "paused" as const, maxCalls: null }),
      );

      controlDatabase
        .prepare("UPDATE packet_reviews SET payload=? WHERE id=?")
        .run(JSON.stringify(pausedReview), pausedReview.id);
    } finally {
      controlDatabase.close();
    }

    app = await electron.launch(options);
    page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    monitor();
    const livePanel = page.getByTestId("packet-review-panel");
    await expect(livePanel).toContainText("Review paused");
    await page.getByText("Previous reviews in this conversation", { exact: true }).click();
    await page.getByRole("button", { name: "Open saved review", exact: true }).first().click();
    await expect(page.getByTestId("historical-review-panel")).toContainText(seeded.previousSummary);
    await expect(
      livePanel.getByRole("button", { name: "Resume review", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill("This must remain blocked while the latest run is paused.");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect(
      page
        .getByTestId("historical-review-panel")
        .getByRole("button", { name: "Resume review", exact: true }),
    ).toHaveCount(0);

    // Reopen with a persisted remote owner and no configured cloud transport. No live calls occur.
    await app.close();
    await Effect.runPromise(
      writeCloudState(join(`${directory}.cloud`, "state.json"), [
        { ...seeded.cloud, revision: 5, phase: "running" },
      ]),
    );
    app = await electron.launch(options);
    page = await app.firstWindow();
    await installRpcBoundary(page);
    await page.reload();
    monitor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId("cloud-review-controls")).toContainText("Local edits are paused");
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save as note", exact: true })).toBeDisabled();
    await expect(page.getByTestId("import-pdf")).toBeDisabled();
    await expect(page.getByTestId("open-create-finding")).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Scope:/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("integration-cloud-owner.png") });
    await page.getByTestId(`packet-finding-${seeded.findingId}`).click();
    const mirroredFinding = page.getByTestId("selected-packet-finding");
    await expect(mirroredFinding.getByRole("checkbox")).toBeDisabled();
    await expect(mirroredFinding.getByRole("button", { name: /Focus detail/ })).toBeDisabled();
    await expect(page.locator(".viewer img")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("integration-cloud-mirrored-finding.png"),
    });
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(`${directory}.cloud`, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

// This fixture exercises persisted result RPCs; separate integration tests prove real Pi generation/tool work.
function seedCompletedReview(directory: string) {
  const database = new DatabaseSync(join(directory, "app.sqlite"));

  try {
    const project = Schema.decodeUnknownSync(Schema.fromJsonString(Project))(
      database.prepare("SELECT payload FROM review_projects").get()?.payload,
    );

    const sheets = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(Sheet) })),
    )(
      database
        .prepare(
          "SELECT payload FROM review_records WHERE kind='sheet' ORDER BY json_extract(payload,'$.pageIndex')",
        )
        .all(),
    ).map((row) => row.payload);

    const revisions = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(Revision) })),
    )(database.prepare("SELECT payload FROM review_records WHERE kind='revision'").all()).map(
      (row) => row.payload,
    );

    const artifacts = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(Artifact) })),
    )(database.prepare("SELECT payload FROM review_records WHERE kind='artifact'").all()).map(
      (row) => row.payload,
    );

    const message = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewMessage))(
      database
        .prepare(
          "SELECT payload FROM review_records WHERE kind='message' AND json_extract(payload,'$.role')='reviewer'",
        )
        .get()?.payload,
    );

    const firstSheet = sheets[0];

    const image = artifacts.find(
      (artifact) => artifact.mediaType === "image/png" && artifact.sheetId === firstSheet?.id,
    );

    if (!firstSheet || !image)
      throw new Error("The desktop must render a real imported source before seeding a review.");
    expect(database.prepare("SELECT id FROM packet_reviews").all()).toHaveLength(0);
    expect(
      database.prepare("SELECT id FROM review_records WHERE kind='finding'").all(),
    ).toHaveLength(0);
    const findingId = crypto.randomUUID();
    const findingTitle = "Governing source information is missing";

    const shortObservation =
      "The source fixture does not establish the jurisdiction or permit stage.";

    const technicalObservation =
      `${shortObservation} ${"Full technical context, assumptions and source qualifications remain available for review. ".repeat(8)}`.trim();

    const now = Date.now();

    const review = Schema.decodeUnknownSync(PacketReview)({
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      conversationId: message.conversationId,
      requestId: message.id,
      request: message.text,
      scope: PacketScope.cases.WholeSet.make({}),
      model: "meta-models/muse-spark-open-1026",
      provider: "baseten",
      state: "completed",
      version: 0,
      startedAt: now - 5000,
      changedAt: now - 3000,
      maxCalls: null,
      admittedCalls: 0,
      promptVersion: "offline-desktop-fixture",
      instructionRevision: "offline-fixture-no-model-call",
      sheets: sheets.map((sheet) => {
        const revision = revisions.find((item) => item.id === sheet.revisionId);

        if (!revision) throw new Error("Missing source revision");

        return {
          id: sheet.id,
          revisionId: sheet.revisionId,
          label: sheet.label,
          pageIndex: sheet.pageIndex,
          box: sheet.box,
          sha256: revision.sha256,
          documentName: revision.name,
        };
      }),
      inspectedSheetIds: [firstSheet.id],
      evidenceIds: [image.id],
      projectConfiguration: {
        jurisdiction: "Needs input — synthetic source",
        permitStage: "Needs input",
      },
      coverage: sheets.flatMap((sheet) =>
        ReviewPass.literals.map((pass) => ({
          sheetId: sheet.id,
          pass,
          discipline: "general",
          status:
            sheet.id === firstSheet.id
              ? {
                  completeness: "checked",
                  requirements: "issue",
                  coordination: "needs_input",
                  prior_comments: "not_applicable",
                }[pass]
              : "unreviewed",
          note:
            sheet.id === firstSheet.id && pass === "prior_comments"
              ? "This synthetic fixture has no prior comments."
              : "Offline UI fixture; no model inspection is asserted.",
        })),
      ),
      sources: [
        {
          id: crypto.randomUUID(),
          url: "https://example.com/governing-source",
          title: "Saved source fixture",
          retrievedAt: new Date(now).toISOString(),
          status: "available",
          official: false,
          sha256: null,
          text: "Stored source text remains inspectable offline.",
        },
      ],
      citations: [],
      calculations: [],
      findings: [
        {
          id: findingId,
          title: `${findingTitle}: complete source context and permit-stage assumptions retained for review`,
          discipline: "general",
          severity: "Minor",
          status: "Needs input",
          classification: "Recommendation",
          locations: [
            {
              sheetId: firstSheet.id,
              detail: "Supplied synthetic drawing packet",
              region: { x: 80, y: 80, width: 210, height: 180 },
            },
          ],
          observed: technicalObservation,
          correction:
            "Supply jurisdiction and permit-stage information before drawing regulatory conclusions.",
          evidenceIds: [image.id],
          evidenceNote:
            "Rendered imported source; this seeded finding exercises desktop result handling only.",
          citationIds: [],
          calculationIds: [],
          priorCommentId: null,
          completed: false,
          summary: PacketFindingSummary.cases.Ready.make({
            revision: crypto.randomUUID(),
            sheetId: null,
            title: findingTitle,
            observed: shortObservation,
            correction:
              "Supply jurisdiction and permit-stage information before drawing regulatory conclusions.",
          }),
        },
      ],
      priorComments: [],
      summary:
        "**Offline desktop fixture**: persisted packet results and remaining coverage gaps with `saved evidence`. No model review was performed in this UI fixture.",
      missingInputs: ["Jurisdiction, permit stage, and remaining source inspection."],
      error: null,
      finished: true,
    });

    const secondSheet = sheets[1];
    const firstFinding = review.findings[0];

    const request = {
      commandId: crypto.randomUUID(),
      projectId: project.id,
      conversationId: message.conversationId,
      messageId: message.id,
      model: review.model,
      discipline: "auto",
      maxCalls: null,
      kind: "packet",
      transferScope: "whole-application",
    };

    const cloud = Schema.decodeUnknownSync(CloudReviewRecord)({
      id: crypto.randomUUID(),
      revision: 4,
      syncFailure: null,
      request,
      fingerprint: JSON.stringify(request),
      phase: "imported",
      createdAt: now - 5000,
      expiresAt: now + 60_000,
      sandboxId: "offline-fixture-confirmed-stopped",
      inputSnapshotId: null,
      resultSnapshotId: null,
      sandboxName: "offline-fixture",
      appName: "offline-fixture",
      environment: "main",
      sourceVersion: project.sourceVersion,
      factVersion: project.factVersion,
      projectVersion: project.version,
      execution: null,
      packet: {
        id: review.id,
        projectId: project.id,
        conversationId: message.conversationId,
        model: review.model,
        state: review.state,
        version: review.version,
        admittedCalls: 0,
      },
      message:
        "Offline desktop proof: returned packet results are local. No cloud or model calls were made.",
    });

    if (!secondSheet || !firstFinding) throw new Error("Missing distinct source fixtures");
    const secondFindingId = crypto.randomUUID();
    const focusRegion = { x: 80, y: 80, width: 210, height: 180 };
    const focusPixels = transformRegion(image.pdfToPixels, focusRegion);

    const focusBox = {
      left: Math.floor(focusPixels.x),
      top: Math.floor(focusPixels.y),
      right: Math.ceil(focusPixels.x + focusPixels.width),
      bottom: Math.ceil(focusPixels.y + focusPixels.height),
    };

    const withSecondFinding = new PacketReview(
      Struct.assign(review, {
        findings: [
          firstFinding,
          {
            ...Struct.omit(firstFinding, ["summary"]),
            id: secondFindingId,
            title: "Second source finding",
            evidenceIds: [],
            locations: [
              {
                sheetId: secondSheet.id,
                detail: "Second sheet source",
                region: { x: 320, y: 190, width: 90, height: 110 },
              },
            ],
          },
          {
            ...Struct.omit(firstFinding, ["summary"]),
            id: crypto.randomUUID(),
            title: "Missing project inputs",
            evidenceIds: [],
            locations: [],
            evidenceNote: "No source drawing applies to this missing input.",
          },
          {
            ...Struct.omit(firstFinding, ["summary"]),
            id: crypto.randomUUID(),
            title: "SAM focus finding",
            focus: {
              artifactId: image.id,
              sheetId: firstSheet.id,
              region: focusRegion,
              width: image.width,
              height: image.height,
              box: focusBox,
              model: "sam-3.1" as const,
              responseId: "offline-sam-focus",
              segments: [
                {
                  confidence: 0.8,
                  bounds: focusBox,
                  mask: {
                    encoding: "one_bit" as const,
                    payload: "!!!!!&O.lVP",
                    width: 1,
                    height: 1,
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const previousSummary = "Earlier saved answer remains available after another review.";

    const previousReview = new PacketReview(
      Struct.assign(review, {
        id: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        startedAt: now - 10000,
        changedAt: now - 8000,
        summary: previousSummary,
        findings: [],
        state: "cancelled" as const,
        error:
          "Synthetic saved provider failure. Cancel this review before starting a separate review.",
      }),
    );

    for (const persistedReview of [previousReview, withSecondFinding]) {
      database
        .prepare(
          `INSERT INTO packet_reviews (id,project_id,conversation_id,command_id,fingerprint,source_version,owner_generation,journal_id,engine,payload) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          persistedReview.id,
          persistedReview.projectId,
          persistedReview.conversationId,
          crypto.randomUUID(),
          "offline-ui-fixture",
          project.sourceVersion,
          crypto.randomUUID(),
          crypto.randomUUID(),
          "offline-fixture-never-resumed",
          JSON.stringify(persistedReview),
        );

      const answer = new ReviewMessage({
        id: crypto.randomUUID(),
        projectId: project.id,
        conversationId: message.conversationId,
        role: "application",
        text: persistedReview.summary,
        createdAt: new Date(persistedReview.changedAt).toISOString(),
      });

      database
        .prepare("INSERT INTO review_records(project_id,id,kind,payload) VALUES (?,?,?,?)")
        .run(project.id, answer.id, "message", JSON.stringify(answer));
    }

    return {
      findingId,
      secondFindingId,
      findingTitle,
      shortObservation,
      technicalObservation,
      conversationId: message.conversationId,
      cloud,
      previousSummary,
      currentSummary: "persisted packet results and remaining coverage gaps with",
      previousReviewId: previousReview.id,
    };
  } finally {
    database.close();
  }
}
