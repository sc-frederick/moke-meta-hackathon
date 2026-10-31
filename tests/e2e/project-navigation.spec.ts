import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ProjectId } from "#lib/review/contracts.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { installRpcControl, requests } from "./rpc-control.ts";
import {
  createProject,
  importPdf,
  offlineDesktop,
  openWindow,
  savedMessages,
  seedPacketReviews,
} from "./workbench-fixture.ts";

const SnapshotRequest = Schema.Struct({ projectId: Schema.NullOr(ProjectId) });

/**
 * Three projects: Alpha has twelve saved reviews, Beta has two conversations and one saved
 * review, and Gamma has two PDFs and no reviews. The workbench reopens with RPC control installed.
 */
async function threeProjects(directory: string) {
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const options = await offlineDesktop(directory, ["meta"]);
  let app = await electron.launch(options);
  let { page } = await openWindow(app);

  for (const name of ["Alpha", "Beta", "Gamma"]) {
    await createProject(page, name);
    await importPdf(app, page, source);

    if (name === "Gamma") await importPdf(app, page, source);

    if (name === "Beta") {
      await page.getByTestId("new-conversation").click();
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
        "Drawing review 2",
      );
    }
  }

  await app.close();
  const now = Date.now();

  const alpha = seedPacketReviews(directory, "Alpha", ({ conversations, review }) => {
    const conversation = conversations[0];

    if (!conversation) throw new Error("Missing Alpha conversation");

    return Array.from({ length: 12 }, (_, index) =>
      review(conversation, now - 60_000 + index * 1000, `Alpha saved review ${index + 1}`),
    );
  });

  const beta = seedPacketReviews(directory, "Beta", ({ conversations, review }) => {
    const conversation = conversations[0];

    if (!conversation) throw new Error("Missing Beta conversation");

    return [review(conversation, now - 30_000, "Beta saved review")];
  });

  const gamma = seedPacketReviews(directory, "Gamma", () => []);
  app = await electron.launch(options);
  ({ page } = await openWindow(app));
  await installRpcControl(page);
  await page.reload();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("navigation", { name: "Projects" })).toContainText("Gamma");

  // Every project's conversations are listed, so threads can be chosen directly.
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const heading = page.getByRole("button", { name, exact: true });

    if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
  }

  return { app, page, errors, alpha, beta, gamma };
}

const thread = (page: Page, id: string) => page.getByTestId(`conversation-${id}`);

async function snapshotProjects(page: Page) {
  return (await requests(page, "ReviewSnapshot")).map(
    (request) => Schema.decodeUnknownSync(SnapshotRequest)(request.payload).projectId,
  );
}

test("navigation stays on the most recently selected project when earlier progress and snapshots arrive late", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-project-navigation-"));
  const { app, page, errors, alpha, beta, gamma } = await threeProjects(directory);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const [alphaThread] = alpha.conversations;
  const [, betaSecond] = beta.conversations;
  const [gammaThread] = gamma.conversations;

  if (!alphaThread || !betaSecond || !gammaThread) throw new Error("Missing seeded conversations");

  const held = () => page.evaluate(() => window.rpcControl.held().toSorted());
  const sheetCount = page.locator(".sheets-trigger .finding-count");

  try {
    // Gamma has no saved reviews, so nothing of its own would refresh it after a late snapshot.
    for (const releaseSnapshotFirst of [false, true]) {
      await thread(page, gammaThread.id).click();
      await expect(breadcrumb).toContainText("Gamma");
      await expect(sheetCount).toHaveText("4");

      // Alpha's subscription replays its saved reviews; hold that progress.
      await page.evaluate(() => window.rpcControl.hold("ObservePacketReviews", "Chunk"));
      await thread(page, alphaThread.id).click();
      await expect(breadcrumb).toContainText("Alpha");
      await expect.poll(held).toEqual(["ObservePacketReviews"]);

      // Gamma is selected again while its snapshot is held, then Alpha's progress arrives.
      await page.evaluate(() => window.rpcControl.hold("ReviewSnapshot"));
      const selected = (await snapshotProjects(page)).length;
      await thread(page, gammaThread.id).click();
      await expect.poll(held).toEqual(["ObservePacketReviews", "ReviewSnapshot"]);

      const order = releaseSnapshotFirst
        ? (["ReviewSnapshot", "ObservePacketReviews"] as const)
        : (["ObservePacketReviews", "ReviewSnapshot"] as const);

      for (const tag of order) await page.evaluate((name) => window.rpcControl.release(name), tag);

      await expect(breadcrumb).toContainText("Gamma");
      await expect(sheetCount).toHaveText("4");
      await expect(thread(page, gammaThread.id)).toHaveAttribute("aria-current", "page");
      // Nothing after the selection asked for Alpha's snapshot.
      expect((await snapshotProjects(page)).slice(selected)).not.toContain(alpha.project.id);
      const observed = await requests(page, "ObservePacketReviews");
      expect(observed.at(-1)?.payload).toEqual({ projectId: gamma.project.id });
    }

    // The composer saves to the selected project.
    const composer = page.getByLabel("Message", { exact: true });
    const send = page.getByRole("button", { name: "Send message", exact: true });
    const saved = page.getByRole("status").filter({ hasText: "Note saved." });
    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    await composer.fill("Note for the selected project");
    await send.click();
    await expect(saved).toBeVisible();

    // Rapid Beta → Gamma navigation with explicit conversations: Beta's late snapshot cannot
    // apply its conversation choice to Gamma. Alpha's held replay keeps it from refreshing.
    await page.evaluate(() => window.rpcControl.hold("ObservePacketReviews", "Chunk"));
    await thread(page, alphaThread.id).click();
    await expect(breadcrumb).toContainText("Alpha");
    await expect.poll(held).toEqual(["ObservePacketReviews"]);
    await page.evaluate(() => {
      window.rpcControl.hold("ReviewSnapshot");
      window.rpcControl.hold("ReviewSnapshot");
    });
    await thread(page, betaSecond.id).click();
    await expect.poll(held).toEqual(["ObservePacketReviews", "ReviewSnapshot"]);
    await thread(page, gammaThread.id).click();
    await expect.poll(held).toEqual(["ObservePacketReviews", "ReviewSnapshot", "ReviewSnapshot"]);
    await page.evaluate(() => window.rpcControl.release("ReviewSnapshot", true));
    await expect(breadcrumb).toContainText("Gamma");
    await expect(thread(page, gammaThread.id)).toHaveAttribute("aria-current", "page");
    await page.evaluate(() => window.rpcControl.release("ReviewSnapshot"));

    // A round trip after the late snapshot: by now any stale continuation has run.
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });

    if (await dismiss.isVisible()) await dismiss.click();
    await expect(saved).toBeHidden();
    await composer.fill("Note after rapid navigation");
    await send.click();
    await expect(saved).toBeVisible();
    await expect(thread(page, gammaThread.id)).toHaveAttribute("aria-current", "page");
    await expect(thread(page, betaSecond.id)).not.toHaveAttribute("aria-current", "page");
    await expect(breadcrumb).toContainText("Gamma");
    await expect(sheetCount).toHaveText("4");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  try {
    for (const text of ["Note for the selected project", "Note after rapid navigation"])
      expect(
        savedMessages(directory, text).map((message) => [
          message.projectId,
          message.conversationId,
        ]),
      ).toEqual([[gamma.project.id, gammaThread.id]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replayed reviews and a progress burst share bounded snapshot refreshes", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-snapshot-coalescing-"));
  const { app, page, errors, alpha, beta } = await threeProjects(directory);
  const [alphaThread] = alpha.conversations;
  const [betaThread] = beta.conversations;

  if (!alphaThread || !betaThread) throw new Error("Missing seeded conversations");

  try {
    await thread(page, betaThread.id).click();
    await expect(page.getByTestId("packet-review-panel")).toContainText("Beta saved review");
    const before = (await snapshotProjects(page)).length;

    // Hold Alpha's replay at its first review, then the snapshot that review asks for.
    await page.evaluate(() => window.rpcControl.hold("ObservePacketReviews", "Chunk"));
    await thread(page, alphaThread.id).click();
    await expect
      .poll(() => page.evaluate(() => window.rpcControl.held()))
      .toEqual(["ObservePacketReviews"]);
    await page.evaluate(() => {
      window.rpcControl.hold("ReviewSnapshot");
      window.rpcControl.release("ObservePacketReviews");
    });

    // All twelve reviews arrive while the first refresh is still held.
    const panel = page.getByTestId("packet-review-panel");
    await expect(panel).toContainText("Alpha saved review 12");
    await expect(page.locator(".previous-reviews > div")).toHaveCount(11);
    expect(await page.evaluate(() => window.rpcControl.held())).toEqual(["ReviewSnapshot"]);
    // The selection's snapshot plus one refresh for the whole replay.
    expect((await snapshotProjects(page)).slice(before)).toEqual([
      alpha.project.id,
      alpha.project.id,
    ]);

    await page.evaluate(() => window.rpcControl.release("ReviewSnapshot"));
    // One more refresh, queued behind the held one, covers everything that arrived meanwhile.
    await expect.poll(async () => (await snapshotProjects(page)).length - before).toBe(3);
    await expect(page.getByRole("article").filter({ hasText: "Seeded request" })).toHaveCount(12);
    await expect(panel).toContainText("Alpha saved review 12");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Alpha");
    expect((await snapshotProjects(page)).slice(before)).toEqual([
      alpha.project.id,
      alpha.project.id,
      alpha.project.id,
    ]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
