import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ReviewStorageError } from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import { PacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { failure, installRpcControl, requests, success } from "./rpc-control.ts";
import {
  createProject,
  importPdf,
  offlineDesktop,
  openWindow,
  running,
  savedMessages,
  seedPacketReviews,
} from "./workbench-fixture.ts";

// Draft checks are soft so each send path reports on its own.
test("text typed while a send is pending stays in the composer for notes, review requests and follow-ups", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "moke-composer-draft-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const options = await offlineDesktop(directory, ["meta"]);
  let app = await electron.launch(options);

  try {
    let { page } = await openWindow(app);
    await createProject(page, "Drafts");
    await importPdf(app, page, source);
    await page.getByTestId("new-conversation").click();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "Drawing review 2",
    );
    await app.close();

    // The first conversation has a review in progress, which takes follow-up instructions.
    const seeded = seedPacketReviews(directory, "Drafts", ({ conversations, review }) => {
      const conversation = conversations[0];

      if (!conversation) throw new Error("Missing conversation");

      return [running(review(conversation, Date.now() - 5000, ""))];
    });

    const [active, other] = seeded.conversations;
    const [review] = seeded.reviews;

    if (!active || !other || !review) throw new Error("Missing seeded records");
    app = await electron.launch(options);
    ({ page } = await openWindow(app));
    await installRpcControl(page);
    await page.reload();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const composer = page.getByLabel("Message", { exact: true });
    const held = () => page.evaluate(() => window.rpcControl.held());
    const release = (tag: string) => page.evaluate((name) => window.rpcControl.release(name), tag);

    // Follow-up: the acknowledgement is held while the reviewer keeps typing.
    await page.getByTestId(`conversation-${active.id}`).click();
    await expect(composer).toHaveAttribute("placeholder", "Steer this review…");
    await page.evaluate(
      (value) => {
        window.rpcControl.answer("SteerPacketReview", value);
        window.rpcControl.hold("SteerPacketReview");
      },
      success(Schema.encodeSync(Schema.toCodecJson(PacketReview))(review)),
    );
    await composer.fill("Steer toward the egress widths");
    await composer.press("Enter");
    await expect.poll(held).toEqual(["SteerPacketReview"]);
    await composer.press("End");
    await composer.pressSequentially(" and exits");
    await release("SteerPacketReview");
    await expect(page.getByRole("status").filter({ hasText: "Follow-up queued" })).toBeVisible();
    await expect.soft(composer).toHaveValue("Steer toward the egress widths and exits");
    expect((await requests(page, "SteerPacketReview")).map((item) => item.payload)).toEqual([
      expect.objectContaining({ reviewId: review.id, text: "Steer toward the egress widths" }),
    ]);

    // Notes in the other conversation.
    await page.getByTestId(`conversation-${other.id}`).click();
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    const saved = page.getByRole("status").filter({ hasText: "Note saved." });

    await composer.fill("First note");
    await page.evaluate(() => window.rpcControl.hold("ReviewCommand"));
    await composer.press("Enter");
    await expect.poll(held).toEqual(["ReviewCommand"]);
    await composer.press("End");
    await composer.pressSequentially(" with more");
    await release("ReviewCommand");
    await expect(saved).toBeVisible();
    await expect.soft(composer).toHaveValue("First note with more");

    // An edit that restores the submitted text is still the reviewer's newer draft.
    await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await composer.fill("Second note");
    await page.evaluate(() => window.rpcControl.hold("ReviewCommand"));
    await composer.press("Enter");
    await expect.poll(held).toEqual(["ReviewCommand"]);
    await composer.press("End");
    await composer.press("x");
    await composer.press("Backspace");
    await expect(composer).toHaveValue("Second note");
    await release("ReviewCommand");
    await expect(saved).toBeVisible();
    await expect.soft(composer).toHaveValue("Second note");

    // A failed save keeps both the submitted and the newer text.
    await composer.fill("Third note");
    await page.evaluate(
      (exit) => {
        window.rpcControl.answer("ReviewCommand", exit);
        window.rpcControl.hold("ReviewCommand");
      },
      failure(
        Schema.encodeSync(Schema.toCodecJson(ReviewStorageError))(
          new ReviewStorageError({ message: "Offline proof: this note was not saved." }),
        ),
      ),
    );
    await composer.press("Enter");
    await expect.poll(held).toEqual(["ReviewCommand"]);
    await composer.press("End");
    await composer.pressSequentially(" kept");
    await release("ReviewCommand");
    await expect(
      page.getByRole("alert").filter({ hasText: "Offline proof: this note was not saved." }),
    ).toBeVisible();
    await expect(composer).toHaveValue("Third note kept");

    // A review request: the message save is held, and the review start is answered offline.
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
    await page.getByRole("button", { name: "Save as note", exact: true }).click();
    await composer.fill("Review the egress widths");
    await page.evaluate(
      (exit) => {
        window.rpcControl.hold("ReviewCommand");
        window.rpcControl.answer("StartPacketReview", exit);
      },
      failure(
        Schema.encodeSync(Schema.toCodecJson(ExecutionError))(
          new ExecutionError({
            reason: "unavailable",
            message: "Offline proof: the review was not started.",
          }),
        ),
      ),
    );
    await composer.press("Enter");
    await expect.poll(held).toEqual(["ReviewCommand"]);
    await composer.press("End");
    await composer.pressSequentially(" please");
    await release("ReviewCommand");
    await expect(
      page.getByRole("alert").filter({
        hasText: "Your message was saved. Offline proof: the review was not started.",
      }),
    ).toBeVisible();
    await expect.soft(composer).toHaveValue("Review the egress widths please");
    expect(await requests(page, "StartPacketReview")).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  try {
    // Each acknowledged message was saved exactly once; the failed note was not saved.
    for (const [text, count] of [
      ["First note", 1],
      ["Second note", 1],
      ["Third note", 0],
      ["Review the egress widths", 1],
    ] as const)
      expect(savedMessages(directory, text)).toHaveLength(count);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
