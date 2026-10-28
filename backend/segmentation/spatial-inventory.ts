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

/** Invalid geometry or duplicate observation identifiers prevents a reliable comparison. */
class InventoryGeometryError extends Schema.TaggedError<InventoryGeometryError>()(
  "InventoryGeometryError",
  { message: Schema.String },
) {}

/** Mutually unique geometric correspondences; ambiguous IDs also remain unmatched. */
type InventoryComparison = {
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
