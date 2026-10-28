import { expect, test } from "bun:test";
import { PacketScope, selectPacketReviewScope } from "#lib/review/packet.ts";

test.each([
  "Review the whole set, especially electrical coordination.",
  "Audit the entire packet and scrutinize structure.",
  "Check all sheets for plumbing issues and broader QA.",
])("Auto retains explicit whole-set scope: %s", (request) => {
  expect(selectPacketReviewScope(request, "auto")._tag).toBe("WholeSet");
});

test("explicit reviewer choice and an individual discipline request remain scoped", () => {
  expect(selectPacketReviewScope("Run a quick QA pass", "auto")._tag).toBe("WholeSet");
  expect(selectPacketReviewScope("Perform an electrical review", "auto")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "electrical" }),
  );
  expect(selectPacketReviewScope("Review the whole packet", "structural")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "structural" }),
  );
});
