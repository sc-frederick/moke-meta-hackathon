import { expect, test } from "bun:test";
import { PacketScope, selectPacketReviewScope } from "#lib/review/packet.ts";

test.each([
  "Review the whole set, especially electrical coordination.",
  "Audit the entire packet and scrutinize structure.",
  "Check all sheets for plumbing issues and broader QA.",
  "Review the entire permit packet, especially electrical coordination.",
  "Audit the full construction document set and scrutinize structure.",
  "Review the whole revised permit drawing packet, including plumbing.",
  "Check all supplied plan sheets for electrical coordination and broader QA.",
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
  expect(selectPacketReviewScope("Review the whole packet", "general")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "general" }),
  );
});
