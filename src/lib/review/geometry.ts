import { Schema } from "effect";
import { Affine, Region, ReviewInputError } from "#lib/review/contracts.ts";

/** Apply an affine transform without discarding page rotation, scale, or crop origin. */
export function transformPoint(transform: typeof Affine.Type, x: number, y: number) {
  const [a, b, c, d, e, f] = transform;

  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Invert a nondegenerate coordinate map; invalid maps cannot become evidence. */
export function invertTransform(transform: typeof Affine.Type) {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;

  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return new ReviewInputError({ message: "The source transform cannot be inverted." });
  }

  return Schema.decodeUnknownSync(Affine)([
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]);
}

/** A requested region must fit inside its source page, including a nonzero page origin. */
export function containsRegion(page: Region, region: Region) {
  return (
    region.x >= page.x &&
    region.y >= page.y &&
    region.x + region.width <= page.x + page.width &&
    region.y + region.height <= page.y + page.height
  );
}

/** Map all four corners, retaining a useful enclosing rectangle after rotation. */
export function transformRegion(transform: typeof Affine.Type, region: Region) {
  const corners = [
    transformPoint(transform, region.x, region.y),
    transformPoint(transform, region.x + region.width, region.y),
    transformPoint(transform, region.x, region.y + region.height),
    transformPoint(transform, region.x + region.width, region.y + region.height),
  ];

  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return new Region({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}
