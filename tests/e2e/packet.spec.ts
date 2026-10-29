import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Artifact, Project, Revision, ReviewMessage, Sheet } from "#lib/review/contracts.ts";
import { PacketReview, PacketScope, ReviewPass } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("document QA needs no count check and persisted findings support evidence, completion, export, and reopen", async () => {
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
    await expect(page.getByTestId(/^confirm-sheet-/)).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Check:/ })).toHaveCount(0);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Run a quick QA pass on this drawing set.");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await expect(page.getByText("Whole set or selected discipline", { exact: true })).toBeVisible();

    const reviewer = page.getByRole("button", { name: /^Reviewer:/ });
    await reviewer.click();
    await page.getByRole("option", { name: "Electrical", exact: true }).click();
    await expect(reviewer).toContainText("Electrical");
    await reviewer.click();
    await page.getByRole("option", { name: "Auto", exact: false }).click();
    await expect(reviewer).toContainText("Auto");
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
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // The request can start without a check, but this offline UI proof saves a note instead of dispatching a provider.
    const saveNote = page.getByRole("button", { name: "Save as note", exact: true });
    await saveNote.click();
    await expect(saveNote).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note saved." })).toBeVisible();
    await expect(page.getByTestId("packet-review-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await app.close();

    const seeded = seedCompletedReview(directory);
    app = await electron.launch(options);
    page = await app.firstWindow();
    monitor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const panel = page.getByTestId("packet-review-panel");
    await expect(panel).toContainText("Whole-set review");
    await expect(panel).toContainText("Review finished with gaps");
    await expect(panel).toContainText("1 of 2 sheets opened");
    await expect(panel.locator(".progress")).toContainText("1 of 88 review passes recorded");
    await expect(panel).toContainText("Offline desktop fixture");
    await expect(page.getByRole("button", { name: /^Check:/ })).toHaveCount(0);
    await panel.getByText("Sheet coverage and review records", { exact: true }).click();
    await expect(panel).toContainText("unreviewed");
    const finding = page.getByTestId(`packet-finding-${seeded.findingId}`);
    await finding.locator("summary").click();
    await finding.getByRole("button", { name: "Open source evidence", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    const elapsed = await panel.getByLabel("Review elapsed time", { exact: true }).innerText();

    const completed = finding.getByRole("checkbox", {
      name: `Completed: ${seeded.findingTitle}`,
      exact: true,
    });

    await completed.click();
    await expect(completed).toBeChecked();
    await expect(finding.locator(".finding-status")).toHaveText("Needs input");
    await expect(panel.getByLabel("Review elapsed time", { exact: true })).toHaveText(elapsed);
    await page.getByTestId("new-conversation").click();
    await expect(panel).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).fill("Review the electrical discipline.");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await page.getByTestId(`conversation-${seeded.conversationId}`).click();
    await expect(panel).toContainText(seeded.findingTitle);
    const reportFile = test.info().outputPath("packet-review.html");
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, reportFile);
    await panel.getByRole("button", { name: "Export HTML report", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "HTML review report exported." }),
    ).toBeVisible();
    const html = await readFile(reportFile, "utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("Offline desktop fixture");
    expect(html).toContain(seeded.findingTitle);
    expect(html).toContain("unreviewed");
    expect(html).toContain(`data-completion-id="finding:${seeded.findingId}" checked`);
    await page.screenshot({ path: test.info().outputPath("packet-review-workbench.png") });
    await app.close();

    app = await electron.launch(options);
    page = await app.firstWindow();
    monitor();
    await expect(page.getByTestId("packet-review-panel")).toContainText(seeded.findingTitle);
    await page.getByTestId(`packet-finding-${seeded.findingId}`).locator("summary").click();
    await expect(
      page.getByRole("checkbox", { name: `Completed: ${seeded.findingTitle}`, exact: true }),
    ).toBeChecked();
    await expect(page.locator(".reviewer-message")).toContainText(
      "Run a quick QA pass on this drawing set.",
    );
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
          status: sheet.id === firstSheet.id && pass === "completeness" ? "checked" : "unreviewed",
          note: "Offline UI fixture; no model inspection is asserted.",
        })),
      ),
      sources: [],
      citations: [],
      calculations: [],
      findings: [
        {
          id: findingId,
          title: findingTitle,
          discipline: "general",
          severity: "Minor",
          status: "Needs input",
          classification: "Recommendation",
          locations: [
            {
              sheetId: firstSheet.id,
              detail: "Supplied synthetic drawing packet",
              region: image.region,
            },
          ],
          observed: "The source fixture does not establish the jurisdiction or permit stage.",
          correction:
            "Supply jurisdiction and permit-stage information before drawing regulatory conclusions.",
          evidenceIds: [image.id],
          evidenceNote:
            "Rendered imported source; this seeded finding exercises desktop result handling only.",
          citationIds: [],
          calculationIds: [],
          priorCommentId: null,
          completed: false,
        },
      ],
      priorComments: [],
      summary:
        "Offline desktop fixture: persisted packet results and remaining coverage gaps. No model review was performed in this UI fixture.",
      missingInputs: ["Jurisdiction, permit stage, and remaining source inspection."],
      error: null,
      finished: true,
    });

    database
      .prepare(
        `INSERT INTO packet_reviews (id,project_id,conversation_id,command_id,fingerprint,source_version,owner_generation,journal_id,engine,payload) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        review.id,
        review.projectId,
        review.conversationId,
        crypto.randomUUID(),
        "offline-ui-fixture",
        project.sourceVersion,
        crypto.randomUUID(),
        crypto.randomUUID(),
        "offline-fixture-never-resumed",
        JSON.stringify(review),
      );

    return { findingId, findingTitle, conversationId: message.conversationId };
  } finally {
    database.close();
  }
}
