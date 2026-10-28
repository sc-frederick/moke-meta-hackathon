import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { join } from "node:path";
import { DrawingCrop } from "../backend/segmentation/fixtures.ts";
import {
  compareInventories,
  evaluateCenters,
  InventoryGeometryError,
  NamedBox,
  PixelBox,
} from "../backend/segmentation/spatial-inventory.ts";

const box = (id: string, left: number, top: number, right: number, bottom: number) =>
  Schema.decodeUnknownSync(NamedBox)({ id, box: { left, top, right, bottom } });

test("inventory comparison preserves distinct nearby symbols and fractional source coordinates", async () => {
  const result = await Effect.runPromise(
    compareInventories(
      [box("sam-0", 0, 0, 10, 10), box("sam-1", 12, 0, 22, 10)],
      [box("muse-0", 0.5, 0, 10.5, 10), box("muse-1", 13, 0.25, 23, 10.25)],
    ),
  );

  expect(result.matches.map((match) => [match.leftId, match.rightId])).toEqual([
    ["sam-0", "muse-0"],
    ["sam-1", "muse-1"],
  ]);
  expect(result.leftOnly).toEqual([]);
  expect(result.rightOnly).toEqual([]);
  expect(result.ambiguous).toEqual([]);
});

test("a moderate shift can agree while the observed misplaced GFI box stays unresolved", async () => {
  const shifted = await Effect.runPromise(
    compareInventories([box("a", 0, 0, 10, 10)], [box("b", 6, 2, 16, 12)]),
  );

  expect(shifted.matches).toHaveLength(1);
  expect(shifted.matches[0]?.iou).toBeLessThan(0.2);
  expect(shifted.matches[0]?.distance).toBeCloseTo(Math.hypot(6, 2));

  const gfi = await Effect.runPromise(
    compareInventories(
      [box("source-gfi", 48, 183, 90, 220)],
      [box("misplaced-muse", 23, 219, 65, 268)],
    ),
  );

  expect(gfi.matches).toEqual([]);
  expect(gfi.leftOnly).toEqual(["source-gfi"]);
  expect(gfi.rightOnly).toEqual(["misplaced-muse"]);
});

test("ambiguous overlap is reported without forcing an inventory pair", async () => {
  const result = await Effect.runPromise(
    compareInventories(
      [box("left-0", 0, 0, 10, 10), box("left-1", 3, 0, 13, 10)],
      [box("right-0", 1, 0, 11, 10)],
    ),
  );

  expect(result.matches).toEqual([]);
  expect(result.leftOnly).toEqual(["left-0", "left-1"]);
  expect(result.rightOnly).toEqual(["right-0"]);
  expect(result.ambiguous).toEqual(["left:left-0", "right:right-0", "left:left-1"]);
});

test("geometrically oversized regions cannot agree merely through their center", async () => {
  const result = await Effect.runPromise(
    compareInventories([box("small", 45, 45, 55, 55)], [box("floor", 0, 0, 100, 100)]),
  );

  expect(result.matches).toEqual([]);
});

test("invalid coordinates, empty bounds, unsafe IDs and duplicate IDs fail visibly", async () => {
  for (const geometry of [
    { left: 0, top: 0, right: Number.POSITIVE_INFINITY, bottom: 10 },
    { left: 0, top: Number.NaN, right: 10, bottom: 10 },
    { left: -1, top: 0, right: 10, bottom: 10 },
    { left: 0, top: 0, right: 0, bottom: 10 },
    { left: 10, top: 0, right: 0, bottom: 10 },
  ]) {
    expect(Result.isFailure(Schema.decodeUnknownResult(PixelBox)(geometry))).toBe(true);
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(NamedBox)({
        id: "../escape",
        box: { left: 0, top: 0, right: 1, bottom: 1 },
      }),
    ),
  ).toBe(true);

  const duplicate = box("same", 0, 0, 10, 10);

  const invalidOperations: ReadonlyArray<Effect.Effect<unknown, InventoryGeometryError>> = [
    compareInventories([duplicate, duplicate], []),
    compareInventories([], [duplicate, duplicate]),
    evaluateCenters([{ id: "p", x: 1, y: 1 }], [duplicate, duplicate]),
    evaluateCenters(
      [
        { id: "p", x: 1, y: 1 },
        { id: "p", x: 2, y: 2 },
      ],
      [duplicate],
    ),
  ];

  for (const operation of invalidOperations) {
    const result = await Effect.runPromise(Effect.result(operation));

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(InventoryGeometryError);
  }
});

test("center membership includes top-left and excludes right/bottom edges", async () => {
  const result = await Effect.runPromise(
    evaluateCenters(
      [
        { id: "inside", x: 0, y: 0 },
        { id: "right", x: 10, y: 0 },
        { id: "bottom", x: 0, y: 10 },
      ],
      [box("only", 0, 0, 10, 10)],
    ),
  );

  expect(result).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 2 });
  expect(result.matches).toEqual([{ centerId: "inside", objectId: "only" }]);
  expect(result.missedCenterIds).toEqual(["right", "bottom"]);
});

test("maximum one-to-one center matching reassigns an earlier broad prediction", async () => {
  const result = await Effect.runPromise(
    evaluateCenters(
      [
        { id: "a", x: 5, y: 5 },
        { id: "b", x: 15, y: 5 },
      ],
      [box("wide", 0, 0, 20, 10), box("narrow", 0, 0, 10, 10)],
    ),
  );

  expect(result).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 });
  expect(result.matches).toEqual([
    { centerId: "b", objectId: "wide" },
    { centerId: "a", objectId: "narrow" },
  ]);
  expect(result.ambiguousCenterIds).toEqual(["a"]);
  expect(result.ambiguousObjectIds).toEqual(["wide"]);
});

test("duplicate predictions count as false positives and one box cannot cover two truth entries", async () => {
  const duplicate = await Effect.runPromise(
    evaluateCenters(
      [{ id: "truth", x: 5, y: 5 }],
      [box("prediction-a", 0, 0, 10, 10), box("prediction-b", 0, 0, 10, 10)],
    ),
  );

  expect(duplicate).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0 });
  expect(duplicate.ambiguousCenterIds).toEqual(["truth"]);

  const broad = await Effect.runPromise(
    evaluateCenters(
      [
        { id: "truth-a", x: 5, y: 5 },
        { id: "truth-b", x: 15, y: 5 },
      ],
      [box("prediction", 0, 0, 20, 10)],
    ),
  );

  expect(broad).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 1 });
});

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const Captures = Schema.fromJsonString(
  Schema.Struct({
    sourceRun: Schema.String,
    cases: Schema.Array(
      Schema.Struct({
        caseId: Schema.String,
        crop: Schema.String,
        inputSha256: Hash,
        pdfSha256: Hash,
        responseSha256: Hash,
        objects: Schema.Array(NamedBox),
      }),
    ),
  }),
);

const Annotations = Schema.fromJsonString(
  Schema.Struct({
    cases: Schema.Array(
      Schema.Struct({
        crop: Schema.String,
        expected: Schema.Int,
        centers: Schema.optional(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
        recordedBeforeSam: Schema.Boolean,
        annotationTiming: Schema.String,
      }),
    ),
  }),
);

test.each([
  { crop: "c-procedure-power", tp: 10, fp: 2, fn: 0, timing: "post-run-visual-audit" },
  { crop: "c-exam-power", tp: 2, fp: 9, fn: 2, timing: "pre-run-expectation" },
  { crop: "c-pre-recovery-lighting", tp: 10, fp: 0, fn: 0, timing: "pre-run-expectation" },
])("saved source boxes reproduce localization counts for $crop offline", async (expected) => {
  const directory = join(import.meta.dir, "..", "experiments", "sam", "symbols");

  const captures = Schema.decodeUnknownSync(Captures)(
    await Bun.file(join(directory, "captured-locations.json")).text(),
  );

  const annotations = Schema.decodeUnknownSync(Annotations)(
    await Bun.file(join(directory, "holdout-expectations.json")).text(),
  );

  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ crops: Schema.Array(DrawingCrop) })),
  )(await Bun.file(join(directory, "crops.json")).text());

  const captured = captures.cases.find((entry) => entry.crop === expected.crop);
  const annotation = annotations.cases.find((entry) => entry.crop === expected.crop);
  const source = manifest.crops.find((entry) => entry.id === expected.crop);

  if (!captured || !annotation?.centers || !source)
    throw new Error("Missing saved evaluation input.");

  const centers = annotation.centers.map(([x, y], index) => ({ id: `truth-${index}`, x, y }));
  const result = await Effect.runPromise(evaluateCenters(centers, captured.objects));

  expect(captured.inputSha256).toBe(source.sha256);
  expect(annotation.expected).toBe(centers.length);
  expect(annotation.annotationTiming).toBe(expected.timing);
  expect(annotation.recordedBeforeSam).toBe(expected.timing === "pre-run-expectation");
  expect(result).toMatchObject({
    truePositives: expected.tp,
    falsePositives: expected.fp,
    falseNegatives: expected.fn,
  });
});
