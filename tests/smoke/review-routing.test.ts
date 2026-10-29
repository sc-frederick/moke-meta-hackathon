import { expect, test } from "bun:test";
import { routeReviewDiscipline } from "#lib/review/execution.ts";

test.each([
  ["count the conductors", "electrical"],
  ["count the electrical conductors", "electrical"],
  ["count the lights", "electrical"],
  ["check the ductwork", "mechanical"],
  ["product introduction and reduction", "general"],
  ["electrical and mechanical coordination", "general"],
] as const)("Auto routes whole words in %s", (text, expected) => {
  expect(routeReviewDiscipline(text)).toBe(expected);
});

test("Auto resolves object scope before sheet hints and preserves an ambiguous request", () => {
  const scope = "Type A luminaires in Room 101";
  const sheets = "A-101 Floor Plan E-601";
  expect(routeReviewDiscipline("Check these quantities", [scope, sheets])).toBe("electrical");
  expect(routeReviewDiscipline("Check these quantities", ["Room 101 count", "E-601"])).toBe(
    "electrical",
  );
  expect(routeReviewDiscipline("electrical and mechanical coordination", [scope, sheets])).toBe(
    "general",
  );
  expect(routeReviewDiscipline("Check these quantities", ["Room 101 count", sheets])).toBe(
    "general",
  );
});
