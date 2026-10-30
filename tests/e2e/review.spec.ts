import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { ResponseReceipt } from "../../backend/inference/response.ts";
import { PacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("desktop proves supported, corrected, unchanged-control, revision, media, and reopen outcomes", async () => {
  const live = process.env.MOKE_E2E_LIVE === "1";
  const screenshots = test.info().project.name === "screenshots";

  if (screenshots && live) throw new Error("Documentation screenshots use the offline fixture.");
  test.setTimeout(live ? 360000 : 90000);
  const directory = await mkdtemp(join(tmpdir(), "desktop-review-"));
  const fixtureA = join(directory, "Revision A.pdf");
  const fixtureB = join(directory, "Revision B.pdf");
  await writeFile(fixtureA, createHeroPdf("A"));
  await writeFile(fixtureB, createHeroPdf("B"));

  const environment = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ||
      key === "ELECTRON_RUN_AS_NODE" ||
      (!live &&
        [
          "MODEL_API_KEY",
          "BASETEN_API_KEY",
          "MOKE_SESSION_CREDENTIAL_FILE",
          "MODAL_TOKEN_ID",
          "MODAL_TOKEN_SECRET",
          "MOKE_MODAL_CONFIG",
        ].includes(key))
        ? []
        : [[key, value]],
    ),
  );

  const options: Parameters<typeof electron.launch>[0] = {
    args: [".", `--user-data-dir=${join(directory, "profile")}`],
    env: {
      ...environment,
      PROJECT_KIT_DATA_DIRECTORY: directory,
    },
  };

  if (process.env.PROJECT_KIT_EXECUTABLE !== undefined) {
    options.executablePath = process.env.PROJECT_KIT_EXECUTABLE;
    options.args = [`--user-data-dir=${join(directory, "profile")}`];
    options.cwd = directory;
  }

  let app = await electron.launch(options);
  let liveObservedState: PacketReview["state"] | null = null;

  try {
    let page = await app.firstWindow();
    const rendererErrors: string[] = [];
    const monitor = () => page.on("pageerror", (error) => rendererErrors.push(error.message));
    monitor();

    if (screenshots) await page.setViewportSize({ width: 1440, height: 1000 });

    const capture = async (name: string, history = false) => {
      if (!screenshots) return;
      await expect(
        page.getByRole("region", { name: "Original source render" }).locator("img"),
      ).toHaveJSProperty("complete", true);
      const notice = page.getByRole("button", { name: "Dismiss notification" });

      if (await notice.isVisible()) await notice.click();

      if (history) await page.getByTestId("check-history").scrollIntoViewIfNeeded();
      else
        await page.locator(".source-scroll").evaluate((element) => {
          element.scrollTop = 0;
        });

      if (name.startsWith("workbench")) {
        const findings = page.getByRole("region", { name: "Workspace findings" });

        if (!(await findings.isVisible()))
          await page.getByRole("button", { name: "Open findings" }).click();
        await expect(findings).toBeVisible();
      }

      await page.evaluate(() => document.fonts.ready);
      await mkdir(resolve("docs/screenshots"), { recursive: true });
      await page.screenshot({
        path: resolve("docs/screenshots", `${name}.png`),
        animations: "disabled",
      });
    };

    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixtureA);
    await expect(page.getByTestId("review-workbench")).toBeVisible();
    await page.getByRole("button", { name: "Create a project", exact: true }).click();
    await page.getByTestId("project-name-input").fill("Lighting coordination");
    await page.getByTestId("create-project-button").click();
    await expect(page.getByTestId("import-pdf")).toBeEnabled();

    await page.getByRole("button", { name: "Review settings" }).click();
    await page.getByText("Optional call budget", { exact: true }).click();
    const callLimit = page.getByLabel("Maximum provider calls", { exact: true });
    await expect(callLimit).toHaveValue("");
    await callLimit.fill("12");
    await expect(callLimit).toHaveValue("12");
    await expect(page.getByRole("heading", { name: "Cloud reviews" })).toBeVisible();

    if (!live) await callLimit.fill("");

    await page.getByRole("button", { name: "Close review settings" }).click();
    await page.getByRole("button", { name: "Execution location: On this computer" }).click();
    await expect(page.getByRole("option", { name: "Push to cloud" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await expect(page.getByTestId(/^confirm-sheet-/)).toHaveCount(2);

    await page.getByTestId("sheet-list").locator("details > summary").first().click();
    await page.getByTestId("sheet-list").locator("details > summary").nth(1).click();

    for (let index = 0; index < 2; index++)
      await page
        .getByTestId(/^confirm-sheet-/)
        .nth(index)
        .click();

    const openFinding = async (title: string) => {
      await page.getByRole("button", { name: "Open findings" }).click();
      await page
        .getByTestId(/^finding-row-/)
        .filter({ hasText: title })
        .click();
      await expect(page.getByTestId("finding-inspector")).toContainText(title);
      await expect(page.getByTestId("evaluate-finding")).toBeEnabled();
    };

    const createFinding = async (title: string, control = false) => {
      if (await page.getByRole("button", { name: "Close source panel" }).isVisible())
        await page.getByRole("button", { name: "Close source panel" }).click();
      await page.getByTestId("open-create-finding").click();
      const form = page.getByTestId("create-finding-form");
      await form.locator("input").first().fill(title);
      await form
        .locator("input")
        .nth(1)
        .fill(
          control
            ? "Type C luminaires in the independent control detail"
            : title === "Room 101 type A"
              ? "Type A luminaires within Room 101 only, compared with the Room 101 A schedule quantity"
              : "Type B luminaires within Room 102 only, compared with its schedule quantity",
        );
      await form
        .locator("select")
        .first()
        .selectOption({ index: control ? 2 : 1 });
      await form.locator("select").nth(1).selectOption({ index: 2 });
      await form.locator('input[type="checkbox"]').check();
      await page.getByTestId("create-finding-submit").click();
      await expect(page.getByTestId("finding-inspector")).toContainText(title);
      await expect(page.getByTestId("evaluate-finding")).toBeEnabled();
    };

    const accept = async (side: "drawn" | "scheduled", count: number, rationale: string) => {
      await page.getByTestId(`${side}-count-input`).fill(String(count));
      await page
        .getByTestId(`${side}-statement-input`)
        .fill(`${count} fixtures in this source scope.`);
      const details = page.getByTestId(`${side}-advanced`);

      if ((await details.getAttribute("open")) === null)
        await details.locator("summary").first().click();
      await page.getByTestId(`${side}-rationale-input`).fill(rationale);
      await details.locator("summary").first().click();
      await page.getByTestId(`${side}-coverage-checkbox`).check();
      await page.getByTestId(`accept-${side}-count`).click();
      await expect(page.getByTestId("evaluate-finding")).toBeEnabled();
    };

    const evaluate = async (outcome: string) => {
      const before = await page.getByTestId("check-history").locator("li").count();
      await page.getByTestId("evaluate-finding").click();
      await expect(page.getByTestId("check-history").locator("li")).toHaveCount(before + 1);
      await expect(page.getByTestId("check-history").locator("li").last()).toContainText(outcome);
    };

    const saveNote = async (text: string) => {
      const inspector = page.getByTestId("finding-inspector");
      const title = await inspector.getByRole("heading", { level: 2 }).textContent();
      await page.getByRole("button", { name: "Close source panel", exact: true }).click();
      const note = page.getByRole("button", { name: "Save as note", exact: true });

      if ((await note.getAttribute("aria-pressed")) !== "true") await note.click();
      await page.getByLabel("Message", { exact: true }).fill(text);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByRole("region", { name: "Conversation", exact: true })).toContainText(
        text,
      );

      if (title) await openFinding(title);
    };

    await createFinding("Room 101 type A");

    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    const otherSheet = page.getByTestId("sheet-list").locator("li").nth(1);
    await otherSheet.getByRole("button", { name: "View sheet" }).click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await expect(page.locator(".source-provenance")).toContainText("page 2");
    await openFinding("Room 101 type A");
    await expect(page.locator(".source-provenance")).toContainText("page 1");

    if (live) {
      await page
        .getByLabel("Message", { exact: true })
        .fill(
          "Run an electrical QA pass on the two supplied drawing sheets. Open both pages and render a focused original-PDF detail to read the Room 101 label or schedule quantity. Record actual findings, coverage, and missing inputs, then finish with what the evidence supports. Do not accept count facts or claim a completed permit review.",
        );
      await page.getByRole("button", { name: "Send message" }).click();
      const reviewPanel = page.getByTestId("packet-review-panel");
      await expect(reviewPanel).toBeVisible();
      await expect(reviewPanel.getByLabel("Review elapsed time", { exact: true })).not.toHaveText(
        "0:00",
        { timeout: 15000 },
      );
      await page.screenshot({ path: test.info().outputPath("packaged-live-running.png") });
      await expect(reviewPanel.getByRole("heading", { level: 2 })).not.toHaveText(
        "Review in progress",
        { timeout: 300000 },
      );
      const database = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

      const review = Schema.decodeUnknownSync(Schema.fromJsonString(PacketReview))(
        database.prepare("SELECT payload FROM packet_reviews ORDER BY rowid DESC LIMIT 1").get()
          ?.payload,
      );

      const accepted = database
        .prepare(
          "SELECT id FROM review_records WHERE kind='fact' AND json_extract(payload,'$.state')='accepted'",
        )
        .all();

      database.close();
      liveObservedState = review.state;
      expect(["completed", "paused"]).toContain(review.state);
      expect(review.maxCalls).toBe(12);
      expect(review.admittedCalls).toBeGreaterThan(0);
      expect(review.admittedCalls).toBeLessThanOrEqual(12);
      expect(review.inspectedSheetIds.length).toBeGreaterThan(0);
      expect(accepted).toHaveLength(0);

      if (review.state === "completed") {
        await expect(page.locator(".application-message").first()).toBeVisible();
        expect(review.summary.trim().length).toBeGreaterThan(0);
      } else {
        await expect(reviewPanel).toContainText("Review paused");
        await reviewPanel.getByRole("button", { name: "Cancel review", exact: true }).click();
        await expect(reviewPanel).toContainText("Review cancelled");
      }

      await page.screenshot({ path: test.info().outputPath("packaged-live-moke.png") });
    }

    await accept("drawn", 2, "Counted the two type A symbols within Room 101 on L-101.");
    await accept("scheduled", 3, "Read the Room 101 row on L-601.");
    await expect(page.getByRole("region", { name: "Proposed observations" })).toHaveCount(0);
    await evaluate("Count mismatch");
    await expect(page.getByTestId("check-history")).toContainText("2 drawn");
    await expect(page.getByTestId("check-history")).toContainText("3 scheduled");

    if (screenshots)
      await saveNote(
        "Room 101: two type A luminaires drawn, three scheduled. Keep this mismatch open for the next revision.",
      );

    await createFinding("Room 102 type B");
    await accept("drawn", 1, "Deliberate initial misread for the correction acceptance case.");
    await accept("scheduled", 2, "Read the Room 102 row on L-601.");
    await evaluate("Count mismatch");

    await createFinding("Independent type C detail", true);
    await accept("drawn", 2, "Reviewed the two C symbols in the independent L-601 control detail.");
    await accept("scheduled", 2, "Read the independent control quantity on the same sheet.");
    await evaluate("Counts match");

    const controlId = await page
      .getByTestId("check-history")
      .locator("li")
      .first()
      .getAttribute("data-check-id");

    await openFinding("Room 102 type B");
    await accept("drawn", 2, "Corrected the initial misread after inspecting both B symbols.");
    await evaluate("Counts match");
    await expect(page.getByTestId("check-history").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("check-history").locator("li").first()).toContainText(
      "Count mismatch",
    );

    if (screenshots)
      await saveNote(
        "Room 102: corrected my initial count from one to two type B luminaires. The counts agree; the earlier false alarm remains in the check history.",
      );
    await capture("correction", true);
    await page.getByTestId("detail-drawn").click();
    const sourceImage = page.getByRole("region", { name: "Original source render" }).locator("img");
    await expect(sourceImage).toHaveJSProperty("naturalWidth", 2550);

    const imageBytes = await sourceImage.evaluate(async (image) => {
      const source = image.getAttribute("src");

      if (source === null) throw new Error("No source image");

      return (await (await fetch(source)).arrayBuffer()).byteLength;
    });

    expect(imageBytes).toBeGreaterThan(65536);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Rotate clockwise" }).click();
    await page.getByRole("button", { name: "Reset view" }).click();
    await openFinding("Independent type C detail");
    await expect(page.getByTestId("check-history").locator("li").first()).toHaveAttribute(
      "data-check-id",
      controlId ?? "missing",
    );

    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixtureB);
    await page.getByTestId("import-pdf").click();
    await page.getByRole("button", { name: "Choose PDF…", exact: true }).click();
    await page.getByRole("button", { name: "Revision", exact: true }).click();
    const maps = page.getByTestId(/^revision-map-/);
    await expect(maps).toHaveCount(2);

    for (let index = 0; index < 2; index++) {
      await maps.nth(index).selectOption({ index: index + 2 });
      await page
        .getByTestId(/^revision-content-/)
        .nth(index)
        .selectOption(index === 0 ? "changed" : "unchanged");
      await page
        .getByTestId(/^revision-confirm-/)
        .nth(index)
        .check();
    }

    await page.getByTestId("apply-revision").click();
    await openFinding("Room 101 type A");
    await evaluate("Needs evidence");
    await accept(
      "drawn",
      3,
      "Accepted fresh Revision B source showing the added third type A fixture.",
    );
    await evaluate("Counts match");
    await expect(page.getByTestId("check-history")).toContainText("3 drawn");

    if (screenshots)
      await saveNote(
        "Revision B adds the third type A luminaire in Room 101. Accepted fresh drawing evidence and reran the check: three drawn, three scheduled.",
      );
    await capture("revision", true);
    await openFinding("Independent type C detail");
    await expect(page.getByTestId("check-history").locator("li").first()).toHaveAttribute(
      "data-check-id",
      controlId ?? "missing",
    );

    await saveNote("Rechecked Revision B; keep the original issue and correction history.");
    await page.locator(".source-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(sourceImage).toBeVisible();

    if (screenshots) {
      await openFinding("Room 101 type A");
    }

    await capture("workbench");

    if (screenshots) await page.keyboard.press("Escape");

    await page.screenshot({ path: test.info().outputPath("review-workbench.png") });
    const packageParent = test.info().outputPath("packages");
    await mkdir(packageParent, { recursive: true });
    await app.evaluate(({ dialog }, parent) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
    }, packageParent);

    const exportPackage = page.getByRole("button", {
      name: "Export complete package",
      exact: true,
    });

    if (!(await exportPackage.isVisible()))
      await page.getByRole("button", { name: "Toggle conversation sidebar" }).click();
    await exportPackage.click();
    await expect
      .poll(
        async () =>
          (await readdir(packageParent)).filter((name) => name.startsWith("MOKE-review-")).length,
      )
      .toBe(1);
    await expect(
      page.getByRole("button", { name: "Export complete package", exact: true }),
    ).toBeEnabled();
    await app.close();

    if (live) {
      const db = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

      const review = Schema.decodeUnknownSync(Schema.fromJsonString(PacketReview))(
        db.prepare("SELECT payload FROM packet_reviews ORDER BY rowid DESC LIMIT 1").get()?.payload,
      );

      const receipts = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ response_json: Schema.String })),
      )(
        db
          .prepare(
            "SELECT response_json FROM packet_review_attempts WHERE kind='model' AND status='completed' ORDER BY task_id",
          )
          .all(),
      ).map((row) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(ResponseReceipt))(row.response_json),
      );

      const attempts = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({ kind: Schema.String, status: Schema.String, sent: Schema.Int }),
        ),
      )(
        db
          .prepare("SELECT kind,status,sent FROM packet_review_attempts ORDER BY task_id,attempt")
          .all(),
      );

      db.close();

      const tools = receipts.flatMap((receipt) =>
        receipt.content.flatMap((part) => (part.type === "toolCall" ? [part] : [])),
      );

      expect(tools.some((tool) => tool.name === "render_sheet")).toBe(true);
      expect(
        tools.some((tool) => tool.name === "render_sheet" && tool.arguments.region !== undefined),
      ).toBe(true);
      expect(review.admittedCalls).toBeLessThanOrEqual(12);
      await writeFile(
        test.info().outputPath("packaged-live-evidence.json"),
        JSON.stringify(
          {
            observedState: liveObservedState,
            persistedState: review.state,
            finished: review.finished,
            admittedCalls: review.admittedCalls,
            maxCalls: review.maxCalls,
            scope: review.scope,
            inspectedSheetIds: review.inspectedSheetIds,
            coverage: review.coverage,
            missingInputs: review.missingInputs,
            summary: review.summary,
            tools: tools.map((tool) => tool.name),
            attempts,
            receipts: receipts.map((receipt) => ({
              responseId: receipt.responseId,
              provider: receipt.provider,
              model: receipt.model,
              usage: {
                input: receipt.usage.input,
                output: receipt.usage.output,
                totalTokens: receipt.usage.totalTokens,
              },
              stopReason: receipt.stopReason,
            })),
          },
          null,
          2,
        ),
      );
    }

    app = await electron.launch(options);
    page = await app.firstWindow();
    monitor();
    await expect(page.getByRole("region", { name: "Conversation", exact: true })).toContainText(
      "Rechecked Revision B",
    );
    await openFinding("Room 101 type A");
    await expect(page.getByTestId("check-history").locator("li")).toHaveCount(3);
    await expect(page.getByTestId("check-history").locator("li").last()).toContainText(
      "Counts match",
    );
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();

    if (live) await cp(directory, test.info().outputPath("live-data"), { recursive: true });
    await rm(directory, { recursive: true, force: true });
  }
});
