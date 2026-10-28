import { Effect, Schema } from "effect";

const Coordinate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Identifier = Schema.NonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/));

/** Half-open source-pixel bounds with finite coordinates and positive finite area. */
export const PixelBox = Schema.Struct({
  left: Coordinate,
  top: Coordinate,
  right: Coordinate,
  bottom: Coordinate,
}).check(
  Schema.makeFilter((box) => {
    const size = (box.right - box.left) * (box.bottom - box.top);

    return box.right > box.left && box.bottom > box.top && size > 0 && Number.isFinite(size);
  }),
);

/** A parsed source-pixel box; right and bottom edges are exclusive. */
export type PixelBox = typeof PixelBox.Type;

/** One localized observation whose ID is scoped by its caller to the source response. */
export const NamedBox = Schema.Struct({ id: Identifier, box: PixelBox });

/** A localized observation, distinct from an accepted semantic inventory instance. */
export type NamedBox = typeof NamedBox.Type;

const Center = Schema.Struct({ id: Identifier, x: Coordinate, y: Coordinate });

/** Invalid geometry or duplicate observation identifiers prevents a reliable comparison. */
export class InventoryGeometryError extends Schema.TaggedError<InventoryGeometryError>()(
  "InventoryGeometryError",
  { message: Schema.String },
) {}

/** Mutually unique geometric correspondences; ambiguous IDs also remain unmatched. */
export type InventoryComparison = {
  readonly matches: ReadonlyArray<{
    readonly leftId: string;
    readonly rightId: string;
    readonly iou: number;
    readonly distance: number;
  }>;
  readonly leftOnly: ReadonlyArray<string>;
  readonly rightOnly: ReadonlyArray<string>;
  readonly ambiguous: ReadonlyArray<string>;
};

/** Localization-only center-hit counts; neither semantic correctness nor mask accuracy. */
export type CenterEvaluation = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly matches: ReadonlyArray<{ readonly centerId: string; readonly objectId: string }>;
  readonly missedCenterIds: ReadonlyArray<string>;
  readonly unmatchedObjectIds: ReadonlyArray<string>;
  readonly ambiguousCenterIds: ReadonlyArray<string>;
  readonly ambiguousObjectIds: ReadonlyArray<string>;
};

const parseBoxes = Effect.fn("parseInventoryBoxes")(function* (
  input: ReadonlyArray<NamedBox>,
  side: string,
) {
  const boxes = yield* Schema.decodeUnknownEffect(Schema.Array(NamedBox))(input).pipe(
    Effect.mapError(
      () => new InventoryGeometryError({ message: `Invalid box geometry in ${side}.` }),
    ),
  );

  if (new Set(boxes.map((box) => box.id)).size !== boxes.length) {
    return yield* new InventoryGeometryError({ message: `Duplicate observation ID in ${side}.` });
  }

  return boxes;
});

function area(box: PixelBox): number {
  return (box.right - box.left) * (box.bottom - box.top);
}

function geometry(left: PixelBox, right: PixelBox) {
  const leftArea = area(left);
  const rightArea = area(right);

  const overlap =
    Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) *
    Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));

  const largestArea = Math.max(leftArea, rightArea);

  const iou =
    overlap /
    largestArea /
    (1 + Math.min(leftArea, rightArea) / largestArea - overlap / largestArea);

  const distance = Math.hypot(
    left.left + (left.right - left.left) / 2 - right.left - (right.right - right.left) / 2,
    left.top + (left.bottom - left.top) / 2 - right.top - (right.bottom - right.top) / 2,
  );

  const smallerDiagonal = Math.min(
    Math.hypot(left.right - left.left, left.bottom - left.top),
    Math.hypot(right.right - right.left, right.bottom - right.top),
  );

  return {
    iou,
    distance,
    compatible:
      largestArea / Math.min(leftArea, rightArea) <= 4 &&
      (iou >= 0.2 || distance <= smallerDiagonal / 2),
  };
}

/**
 * Compare boxes in the same pixel frame without forcing ambiguous associations.
 * Compatibility requires area ratio ≤4 and either IoU ≥0.2 or center distance
 * ≤half the smaller diagonal. Only mutually unique compatible pairs agree.
 * This geometric heuristic does not verify an object's identity or class.
 */
export const compareInventories = Effect.fn("compareInventories")(function* (
  left: ReadonlyArray<NamedBox>,
  right: ReadonlyArray<NamedBox>,
): Effect.fn.Return<InventoryComparison, InventoryGeometryError> {
  const leftBoxes = yield* parseBoxes(left, "left inventory");
  const rightBoxes = yield* parseBoxes(right, "right inventory");

  const edges = leftBoxes.flatMap((leftBox) =>
    rightBoxes.flatMap((rightBox) => {
      const pair = geometry(leftBox.box, rightBox.box);

      return pair.compatible
        ? [{ leftId: leftBox.id, rightId: rightBox.id, iou: pair.iou, distance: pair.distance }]
        : [];
    }),
  );

  const matches = edges.filter(
    (edge) =>
      edges.filter((candidate) => candidate.leftId === edge.leftId).length === 1 &&
      edges.filter((candidate) => candidate.rightId === edge.rightId).length === 1,
  );

  const ambiguous = edges
    .filter((edge) => !matches.includes(edge))
    .flatMap((edge) => [`left:${edge.leftId}`, `right:${edge.rightId}`]);

  return {
    matches,
    leftOnly: leftBoxes
      .filter((box) => !matches.some((match) => match.leftId === box.id))
      .map((box) => box.id),
    rightOnly: rightBoxes
      .filter((box) => !matches.some((match) => match.rightId === box.id))
      .map((box) => box.id),
    ambiguous: Array.from(new Set(ambiguous)),
  };
});

function contains(box: PixelBox, point: typeof Center.Type): boolean {
  return box.left <= point.x && point.x < box.right && box.top <= point.y && point.y < box.bottom;
}

/**
 * Score frozen annotation centers against boxes using maximum one-to-one matching.
 * A hit is center membership in a half-open box. Duplicate predictions remain
 * false positives; one prediction can match only one center. Counts express
 * localization coverage against the supplied annotations, not semantic accuracy.
 */
export const evaluateCenters = Effect.fn("evaluateInventoryCenters")(function* (
  centers: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
  objects: ReadonlyArray<NamedBox>,
): Effect.fn.Return<CenterEvaluation, InventoryGeometryError> {
  const points = yield* Schema.decodeUnknownEffect(Schema.Array(Center))(centers).pipe(
    Effect.mapError(() => new InventoryGeometryError({ message: "Invalid annotation center." })),
  );

  const boxes = yield* parseBoxes(objects, "evaluation predictions");

  if (new Set(points.map((point) => point.id)).size !== points.length) {
    return yield* new InventoryGeometryError({ message: "Duplicate annotation center ID." });
  }

  const neighbors = new Map(
    points.map((point) => [point.id, boxes.filter((box) => contains(box.box, point))]),
  );

  const owners = new Map<string, typeof Center.Type>();

  // Augmenting paths can move an earlier match, preserving maximum cardinality.
  function assign(point: typeof Center.Type, seen: Set<string>): boolean {
    for (const box of neighbors.get(point.id) ?? []) {
      if (seen.has(box.id)) continue;

      seen.add(box.id);
      const owner = owners.get(box.id);

      if (!owner || assign(owner, seen)) {
        owners.set(box.id, point);

        return true;
      }
    }

    return false;
  }

  for (const point of points) assign(point, new Set());

  const matches = boxes.flatMap((box) => {
    const owner = owners.get(box.id);

    return owner ? [{ centerId: owner.id, objectId: box.id }] : [];
  });

  return {
    truePositives: matches.length,
    falsePositives: boxes.length - matches.length,
    falseNegatives: points.length - matches.length,
    matches,
    missedCenterIds: points
      .filter((point) => !matches.some((match) => match.centerId === point.id))
      .map((point) => point.id),
    unmatchedObjectIds: boxes.filter((box) => !owners.has(box.id)).map((box) => box.id),
    ambiguousCenterIds: points
      .filter((point) => (neighbors.get(point.id)?.length ?? 0) > 1)
      .map((point) => point.id),
    ambiguousObjectIds: boxes
      .filter((box) => points.filter((point) => contains(box.box, point)).length > 1)
      .map((box) => box.id),
  };
});
