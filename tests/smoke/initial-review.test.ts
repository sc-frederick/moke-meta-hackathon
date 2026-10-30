import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ReviewCommand, RevisionId } from "#lib/review/contracts.ts";
import { inInitialReviewPhase, initialReview } from "#lib/review/initial-review.ts";
import { StartPacketReview, selectPacketReviewScope } from "#lib/review/packet.ts";

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
