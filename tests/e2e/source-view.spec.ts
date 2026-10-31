import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Struct } from "effect";
import { PacketFinding, PacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { installRpcControl } from "./rpc-control.ts";
import {
  createProject,
  importPdf,
  offlineDesktop,
  openWindow,
  seedPacketReviews,
} from "./workbench-fixture.ts";

const finding = (fields: {
  readonly title: string;
  readonly sheetId: string;
  readonly evidenceIds: ReadonlyArray<string>;
}) =>
  Schema.decodeUnknownSync(PacketFinding)({
    id: crypto.randomUUID(),
    title: fields.title,
    discipline: "general",
    severity: "Minor",
    status: "Needs input",
    classification: "Recommendation",
    locations: [
      {
        sheetId: fields.sheetId,
        detail: `${fields.title} location`,
        region: { x: 80, y: 80, width: 210, height: 180 },
      },
    ],
    observed: `${fields.title} observation.`,
    correction: `${fields.title} correction.`,
    evidenceIds: fields.evidenceIds,
    evidenceNote: "Offline fixture evidence.",
    citationIds: [],
    calculationIds: [],
    priorCommentId: null,
    completed: false,
  });

const urls = (page: Page) => page.evaluate(() => window.rpcControl.urls);
const held = (page: Page) => page.evaluate(() => window.rpcControl.held());

test("late source loads after close, a finding switch or a project switch show nothing and release their images", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-source-view-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const options = await offlineDesktop(directory, ["meta"]);
  let app = await electron.launch(options);

  try {
    let { page } = await openWindow(app);
    await createProject(page, "Elsewhere");
    await importPdf(app, page, source);
    await createProject(page, "Sources");
    await importPdf(app, page, source);
    // Render the first sheet once so a saved image artifact exists.
    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toBeVisible();
    await app.close();

    const seeded = seedPacketReviews(
      directory,
      "Sources",
      ({ conversations, sheets, artifacts, review }) => {
        const [conversation] = conversations;
        const [first, second] = sheets;

        const image = artifacts.find(
          (artifact) => artifact.mediaType === "image/png" && artifact.sheetId === first?.id,
        );

        if (!conversation || !first || !second || !image) throw new Error("Missing source records");

        return [
          new PacketReview(
            Struct.assign(review(conversation, Date.now() - 5000, "Source fixture review"), {
              evidenceIds: [image.id],
              findings: [
                finding({
                  title: "Saved evidence finding",
                  sheetId: first.id,
                  evidenceIds: [image.id],
                }),
                finding({
                  title: "Rendered location finding",
                  sheetId: second.id,
                  evidenceIds: [],
                }),
              ],
            }),
          ),
        ];
      },
    );

    const [first, second] = seeded.sheets;

    if (!first || !second) throw new Error("Missing seeded sheets");
    app = await electron.launch(options);
    ({ page } = await openWindow(app));
    await installRpcControl(page);
    await page.reload();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Sources");
    await expect(page.getByTestId("packet-review-panel")).toContainText("Source fixture review");

    const panel = page.getByTestId("source-panel");
    const image = page.getByRole("region", { name: "Original source render" }).locator("img");
    const provenance = panel.locator(".source-provenance strong");

    const open = async (title: string) => {
      await page.getByRole("button", { name: "Open findings", exact: true }).click();
      await page
        .getByRole("region", { name: "Workspace findings" })
        .getByRole("button", { name: title })
        .click();
    };

    // A saved image that arrives after the panel closed is released, never shown.
    await page.evaluate(() => window.rpcControl.hold("ReadArtifactChunk"));
    await open("Saved evidence finding");
    await expect.poll(() => held(page)).toEqual(["ReadArtifactChunk"]);
    await expect(panel.getByRole("status")).toHaveText("Rendering source…");
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await page.evaluate(() => window.rpcControl.release("ReadArtifactChunk"));
    await expect.poll(async () => (await urls(page)).revoked.length).toBe(1);
    expect((await urls(page)).revoked).toEqual((await urls(page)).created);
    await expect(panel).toHaveCount(0);

    // A finding switch while the first image loads shows only the second finding's render.
    await page.evaluate(() => window.rpcControl.hold("ReadArtifactChunk"));
    await open("Saved evidence finding");
    await expect.poll(() => held(page)).toEqual(["ReadArtifactChunk"]);
    await open("Rendered location finding");
    await expect(image).toBeVisible();
    await expect(provenance).toHaveText(second.label);
    const shown = await image.getAttribute("src");
    await page.evaluate(() => window.rpcControl.release("ReadArtifactChunk"));
    await expect.poll(async () => (await urls(page)).created.length).toBe(3);
    const late = (await urls(page)).created.at(-1);
    await expect.poll(async () => (await urls(page)).revoked).toContain(late);
    expect((await urls(page)).revoked).not.toContain(shown);
    await expect(image).toHaveAttribute("src", shown ?? "");
    await expect(provenance).toHaveText(second.label);
    await expect(panel.getByTestId("selected-packet-finding")).toContainText(
      "Rendered location finding",
    );

    // Switching projects while a render or an image is pending shows nothing afterwards.
    for (const tag of ["RenderSource", "ReadArtifactChunk"] as const) {
      const before = (await urls(page)).created.length;
      await page.evaluate((name) => window.rpcControl.hold(name), tag);
      await open(tag === "RenderSource" ? "Rendered location finding" : "Saved evidence finding");
      await expect.poll(() => held(page)).toEqual([tag]);
      await page.getByRole("button", { name: "Elsewhere", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Elsewhere");
      await expect(panel).toHaveCount(0);
      await page.evaluate((name) => window.rpcControl.release(name), tag);

      if (tag === "ReadArtifactChunk")
        await expect.poll(async () => (await urls(page)).created.length).toBe(before + 1);
      await page.getByRole("button", { name: "Sources", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Sources");
      await expect(panel).toHaveCount(0);
    }

    // The canvas still works, and every image it created was released exactly once.
    await open("Saved evidence finding");
    await expect(image).toBeVisible();
    await expect(provenance).toHaveText(first.label);
    await page.getByRole("button", { name: "Close source panel", exact: true }).click();
    await expect(panel).toHaveCount(0);

    await expect
      .poll(async () => {
        const { created, revoked } = await urls(page);

        return created.toSorted().join() === revoked.toSorted().join();
      })
      .toBe(true);
    const { revoked } = await urls(page);
    expect(new Set(revoked).size).toBe(revoked.length);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
