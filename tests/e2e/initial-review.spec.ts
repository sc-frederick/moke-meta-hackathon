import { expect, test } from "@playwright/test";
import { electron } from "./isolated-electron.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { initialReview } from "#lib/review/initial-review.ts";
import { StartPacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { failure, installRpcControl, requests } from "./rpc-control.ts";
import {
  createProject,
  importPdf,
  offlineDesktop,
  openWindow,
  savedMessages,
} from "./workbench-fixture.ts";

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

test("Initial Review sends every first-set sheet once, on Muse Spark 1.3 with no call budget and its preset", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-initial-review-send-"));
  const first = join(directory, "First half.pdf");
  const second = join(directory, "Second half.pdf");
  await writeFile(first, createHeroPdf("A"));
  await writeFile(second, createHeroPdf("B"));
  // Both providers are configured so the composer can choose a different model.
  const app = await electron.launch(await offlineDesktop(directory, ["meta", "baseten"]));
  let submission: typeof StartPacketReview.Type | undefined;

  try {
    const { page } = await openWindow(app);
    await createProject(page, "Initial submittal");
    await importPdf(app, page, first);
    await importPdf(app, page, second);
    await installRpcControl(page);
    await page.reload();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".sheets-trigger .finding-count")).toHaveText("4");

    // The composer's model, scope and call budget differ from the preset's.
    await page.getByRole("button", { name: /^Model:/ }).click();
    await page.getByRole("option", { name: /Muse Spark Open/ }).click();
    await page.getByRole("button", { name: /^Scope:/ }).click();
    await page.getByRole("option", { name: "Selected discipline", exact: true }).click();
    await page.getByRole("button", { name: /^Reviewer:/ }).click();
    await page.getByRole("option", { name: "Electrical", exact: true }).click();
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });
    await settings.getByText("Optional call budget", { exact: true }).click();
    await settings.getByLabel("Maximum provider calls", { exact: true }).fill("7");
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Model:/ })).toContainText("Muse Spark Open");

    const initial = page.getByRole("button", { name: "Initial Review", exact: true });
    await expect(initial).toBeEnabled();

    // The review start is answered offline, so no provider is ever reached.
    await page.evaluate(
      (exit) => window.rpcControl.answer("StartPacketReview", exit),
      failure(
        Schema.encodeSync(Schema.toCodecJson(ExecutionError))(
          new ExecutionError({
            reason: "unavailable",
            message: "Offline proof: the preset request was recorded without a provider.",
          }),
        ),
      ),
    );

    // Two activations in one task, before the button can render as disabled.
    await initial.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Your message was saved. Offline proof: the preset request was recorded without a provider.",
      }),
    ).toBeVisible();

    const posts = (await requests(page, "ReviewCommand")).flatMap((request) => {
      const { command } = Schema.decodeUnknownSync(Schema.Struct({ command: ReviewCommand }))(
        request.payload,
      );

      return Schema.is(ReviewCommand.cases.PostMessage)(command) ? [command] : [];
    });

    const starts = (await requests(page, "StartPacketReview")).map((request) =>
      Schema.decodeUnknownSync(StartPacketReview)(request.payload),
    );

    expect(posts.map((post) => post.text)).toEqual([initialReview.text]);
    expect(starts).toHaveLength(1);
    submission = starts[0];
    expect(submission).toEqual({
      commandId: expect.any(String),
      projectId: posts[0]?.projectId,
      conversationId: posts[0]?.conversationId,
      messageId: expect.any(String),
      model: "muse-spark-1.3",
      discipline: "auto",
      maxCalls: null,
      preset: "initial-review-v1",
    });
    // No sheet selection: the backend reviews every sheet of the first set, from both PDFs.
    expect(submission && "selection" in submission).toBe(false);
    // The preset can run again after a failed start.
    await expect(initial).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  try {
    const saved = savedMessages(directory, initialReview.text);
    expect(saved.map((message) => message.id)).toEqual([submission?.messageId]);
    const database = new DatabaseSync(join(directory, "app.sqlite"));

    try {
      expect(database.prepare("SELECT id FROM packet_reviews").all()).toHaveLength(0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
