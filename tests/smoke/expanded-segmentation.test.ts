import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { readCrops } from "../../backend/segmentation/fixtures.ts";
import { casePrompt, SegmentationCase } from "../../backend/segmentation/sam.ts";

test("expanded discipline recipes preflight all prompts without PDFs or inference", async () => {
  const root = resolve("experiments/sam/expanded");

  const crops = await Effect.runPromise(
    readCrops(resolve("Moke-Hackathon-Drawings/expanded"), resolve(root, "crops.json")),
  );

  const ids = new Set<string>();

  for (const name of [
    "provided-cases",
    "shape-cases",
    "structural-cases",
    "structural-correction-cases",
    "civil-cases",
    "guided-cases",
    "manual-cases",
  ]) {
    const cases = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.NonEmptyArray(SegmentationCase)),
    )(await Bun.file(resolve(root, `${name}.json`)).text());

    for (const scenario of cases) {
      expect(ids.has(scenario.id)).toBe(false);
      ids.add(scenario.id);
      const crop = crops.find((candidate) => candidate.id === scenario.crop);

      expect(crop).toBeDefined();

      if (crop) expect(await Effect.runPromise(casePrompt(scenario, crop))).not.toBeEmpty();
    }
  }

  expect(ids.size).toBe(42);
  expect(crops).toHaveLength(18);
});
