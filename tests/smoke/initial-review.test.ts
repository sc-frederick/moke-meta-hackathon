import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import { ReviewCommand, RevisionId } from "#lib/review/contracts.ts";
import {
  inInitialReviewPhase,
  initialReview,
  initialReviewRequest,
} from "#lib/review/initial-review.ts";
import { PacketReview, StartPacketReview, selectPacketReviewScope } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { decodeRequest, id, open, outputs, response, until } from "../fixtures/packet-review.ts";

test("the initial-review-v1 text is pinned to its version", () => {
  // Changing the text needs a new preset version so recorded runs stay comparable.
  expect(initialReview.id).toBe("initial-review-v1");
  expect(createHash("sha256").update(initialReview.text).digest("hex")).toBe(
    "1de612f6472bc26b4ef4b476f01a231339d07eaedc8784ca382c8a9b82754f4d",
  );
});

test("the preset is static, saves unchanged and routes to a whole-set review", () => {
  // Only the step numbers are digits: no dates, counts or project values in the cached prefix.
  expect(initialReview.text.match(/\d+/g)).toEqual(["1", "2", "3"]);
  expect(initialReview.text).not.toMatch(/[{}<>]/);

  expect(
    Schema.decodeUnknownSync(ReviewCommand.cases.PostMessage.fields.text)(initialReview.text),
  ).toBe(initialReview.text);
  expect(selectPacketReviewScope(initialReview.text, "auto")._tag).toBe("WholeSet");
});

test("a packet request records only a known preset", () => {
  const request = {
    commandId: randomUUID(),
    projectId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    model: "muse-spark-1.3",
    discipline: "auto",
    maxCalls: null,
  };

  expect(
    Schema.decodeUnknownSync(StartPacketReview)({ ...request, preset: initialReview.id }).preset,
  ).toBe(initialReview.id);
  expect(Schema.decodeUnknownSync(StartPacketReview)(request).preset).toBeUndefined();
  expect(() =>
    Schema.decodeUnknownSync(StartPacketReview)({ ...request, preset: "initial-review-v0" }),
  ).toThrow();
});

const imported = (minute: number) => ({ importedAt: new Date(minute * 60_000).toISOString() });
const started = (minute: number) => ({ startedAt: minute * 60_000 });
const linked = { revisionId: Schema.decodeUnknownSync(RevisionId)(randomUUID()) };

test.each([
  ["no drawings yet", [], [], [], false],
  ["one PDF before any review", [imported(1)], [], [], true],
  ["one PDF after its initial review, so it can run again", [imported(1)], [], [started(5)], true],
  ["a first set split across PDFs", [imported(1), imported(2)], [], [], true],
  ["a split first set already reviewed", [imported(1), imported(2)], [], [started(5)], true],
  ["a PDF imported after the first review", [imported(1), imported(9)], [], [started(5)], false],
  ["sheets linked as a revision", [imported(1), imported(2)], [linked], [], false],
] as const)("initial review phase: %s", (_, revisions, correspondence, reviews, expected) => {
  expect(inInitialReviewPhase({ revisions, correspondence, reviews })).toBe(expected);
});

test("the Initial Review request admits every sheet of a first set split across two PDFs and keeps its identity on reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-initial-review-admission-"));
  const inventories: Array<PacketReview> = [];
  let step = 0;

  // Offline recorded provider: the model asks for the inventory, then the connection drops.
  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    if (step++ === 0) return response([{ name: "inventory_packet", arguments: {} }]);
    inventories.push(...outputs(PacketReview, request));

    throw new Error("Offline proof ends after the inventory");
  };

  let session = await open(directory, transport);

  try {
    const first = await session.snapshot();
    const source = join(directory, "Second half.pdf");
    await writeFile(source, createHeroPdf("B"));
    await session.importPdf({
      commandId: id(),
      projectId: session.projectId,
      expectedVersion: first.project?.version ?? -1,
      source,
      name: "Second half.pdf",
    });

    const state = await session.snapshot();
    const conversation = state.conversations[0];

    if (!conversation) throw new Error("Missing test conversation");
    expect(state.revisions).toHaveLength(2);
    expect(state.sheets).toHaveLength(4);
    expect(
      inInitialReviewPhase({
        revisions: state.revisions,
        correspondence: state.sheetCorrespondence ?? [],
        reviews: [],
      }),
    ).toBe(true);

    const message = await session.command(
      ReviewCommand.cases.PostMessage.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: state.project?.version ?? -1,
        conversationId: conversation.id,
        text: initialReview.text,
      }),
    );

    // The exact request the Initial Review button sends with its saved message.
    expect(initialReviewRequest).toEqual({
      model: "muse-spark-1.3",
      discipline: "auto",
      maxCalls: null,
      preset: "initial-review-v1",
    });

    const request = Schema.decodeUnknownSync(StartPacketReview)({
      commandId: id(),
      projectId: session.projectId,
      conversationId: conversation.id,
      messageId: message.entityId,
      ...initialReviewRequest,
    });

    const started = await session.run(session.packets.start(request));
    const everySheet = state.sheets.map((sheet) => sheet.id).toSorted();

    const identity = (review: PacketReview) => ({
      scope: review.scope._tag,
      sheets: review.sheets.map((sheet) => sheet.id).toSorted(),
      revisions: [...new Set(review.sheets.map((sheet) => sheet.revisionId))].toSorted(),
      model: review.model,
      provider: review.provider,
      maxCalls: review.maxCalls,
      preset: review.preset,
      requestId: review.requestId,
      request: review.request,
      conversationId: review.conversationId,
    });

    expect(identity(started)).toEqual({
      scope: "WholeSet",
      sheets: everySheet,
      revisions: state.revisions.map((revision) => revision.id).toSorted(),
      model: "muse-spark-1.3",
      provider: "meta",
      maxCalls: null,
      preset: "initial-review-v1",
      requestId: message.entityId,
      request: initialReview.text,
      conversationId: conversation.id,
    });

    await until(session, started.id, "uncertain");
    // The reviewer's inventory lists every sheet from both PDFs.
    expect(
      inventories
        .at(-1)
        ?.sheets.map((sheet) => sheet.id)
        .toSorted(),
    ).toEqual(everySheet);
    expect(step).toBe(2);

    await session.dispose();
    session = await open(directory, transport, false);
    const restored = await session.run(session.packets.get(session.projectId, started.id));
    expect(identity(restored)).toEqual(identity(started));

    const saved = (await session.snapshot()).messages.filter(
      (item) => item.text === initialReview.text,
    );

    expect(saved.map((item) => item.id)).toEqual([message.entityId]);
    // Starting the same request again returns the saved review and dispatches nothing.
    expect((await session.run(session.packets.start(request))).id).toBe(started.id);
    expect(step).toBe(2);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
