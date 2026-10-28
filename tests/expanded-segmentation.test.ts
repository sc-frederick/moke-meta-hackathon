import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { readCrops } from "../backend/segmentation/fixtures.ts";
import { casePrompt, SegmentationCase } from "../backend/segmentation/sam.ts";
import { evaluateCenters, PixelBox } from "../backend/segmentation/spatial-inventory.ts";

const Observation = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
});

const Capture = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      annotations: Schema.Array(Observation),
      predictions: Schema.Array(
        Schema.Struct({ id: Schema.String, kind: Schema.String, box: PixelBox }),
      ),
    }),
  ),
});

const Metrics = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    totals: Schema.Struct({
      truePositives: Schema.Int,
      falsePositives: Schema.Int,
      falseNegatives: Schema.Int,
    }),
  }),
);

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

test("captured expanded-set boxes reproduce strict scores within each semantic kind", async () => {
  const capture = Schema.decodeUnknownSync(Schema.fromJsonString(Capture))(
    await Bun.file("experiments/sam/expanded/captured-locations.json").text(),
  );

  const expected = Schema.decodeUnknownSync(Schema.fromJsonString(Metrics))(
    await Bun.file("experiments/sam/expanded/expected-metrics.json").text(),
  );

  expect(new Set(capture.cases.map((item) => item.id)).size).toBe(capture.cases.length);
  expect(capture.cases).toHaveLength(expected.length);

  for (const scenario of capture.cases) {
    const kinds = new Set([
      ...scenario.annotations.map((o) => o.kind),
      ...scenario.predictions.map((p) => p.kind),
    ]);

    const totals = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

    for (const kind of kinds) {
      const result = await Effect.runPromise(
        evaluateCenters(
          scenario.annotations.filter((o) => o.kind === kind),
          scenario.predictions.filter((p) => p.kind === kind),
        ),
      );

      totals.truePositives += result.truePositives;
      totals.falsePositives += result.falsePositives;
      totals.falseNegatives += result.falseNegatives;
    }

    const expectedRow = expected.find((row) => row.id === scenario.id);
    expect(expectedRow).toBeDefined();

    if (expectedRow) expect(totals).toEqual(expectedRow.totals);
  }
});
