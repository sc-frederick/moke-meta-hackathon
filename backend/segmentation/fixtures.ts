import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/** A crop in the supplied drawing manifest, using top-left PDF points. */
export const DrawingCrop = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
  file: Schema.NonEmptyString,
  pdf: Schema.NonEmptyString,
  page: Positive,
  sheet: Schema.NonEmptyString,
  pdf_rect_points: Schema.Tuple([NonNegative, NonNegative, NonNegative, NonNegative]),
  dpi: Positive,
  width_px: Positive,
  height_px: Positive,
  pixel_to_pdf: Schema.Struct({
    scale: Schema.Number.check(Schema.isGreaterThan(0)),
    offset_points: Schema.Tuple([NonNegative, NonNegative]),
  }),
  purpose: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

/** Parsed crop metadata from the local fixture pack. */
export type DrawingCrop = typeof DrawingCrop.Type;

/** An unreadable, inconsistent, or failed PDF rendering input. */
export class DrawingInputError extends Schema.TaggedError<DrawingInputError>()(
  "DrawingInputError",
  {
    message: Schema.String,
  },
) {}

/** Read and validate the supplied crop manifest before touching the PDFs. */
export const readCrops = Effect.fn("readCrops")(function* (
  directory: string,
  manifestFile = resolve(directory, "drawing-manifest.json"),
) {
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(manifestFile).text(),
    catch: () => new DrawingInputError({ message: `Cannot read ${manifestFile}.` }),
  });

  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ crops: Schema.NonEmptyArray(DrawingCrop) })),
  )(text).pipe(
    Effect.mapError(() => new DrawingInputError({ message: "Invalid drawing crop manifest." })),
  );

  if (new Set(manifest.crops.map((crop) => crop.id)).size !== manifest.crops.length) {
    return yield* new DrawingInputError({ message: "The manifest has duplicate crop IDs." });
  }

  for (const crop of manifest.crops) {
    const [left, top, right, bottom] = crop.pdf_rect_points;
    const scale = 72 / crop.dpi;

    if (
      Math.abs((right - left) / scale - crop.width_px) > 0.001 ||
      Math.abs((bottom - top) / scale - crop.height_px) > 0.001 ||
      Math.abs(crop.pixel_to_pdf.scale - scale) > 0.000001 ||
      crop.pixel_to_pdf.offset_points[0] !== left ||
      crop.pixel_to_pdf.offset_points[1] !== top ||
      !Number.isInteger(left / scale) ||
      !Number.isInteger(top / scale)
    ) {
      return yield* new DrawingInputError({ message: `Inconsistent crop transform: ${crop.id}.` });
    }
  }

  return manifest.crops;
});

/** Resolve fixture paths without allowing the manifest to escape its directory. */
const fixturePath = Effect.fn("fixturePath")(function* (directory: string, file: string) {
  const path = resolve(directory, file);
  const inside = relative(resolve(directory), path);

  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
    return yield* new DrawingInputError({
      message: "A fixture path escapes the drawing directory.",
    });
  }

  return path;
});

/** Hash exact source bytes so every saved result identifies its actual input. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read PNG dimensions from its signature and IHDR header. */
export const pngSize = Effect.fn("pngSize")(function* (bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  if (
    bytes.length < 24 ||
    !signature.every((value, index) => bytes[index] === value) ||
    Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR"
  ) {
    return yield* new DrawingInputError({ message: "The rendered crop is not a PNG." });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return { width: view.getUint32(16), height: view.getUint32(20) };
});

/** Render the crop directly from its PDF with Poppler, never from a resized overview. */
export const renderCrop = Effect.fn("renderCrop")(function* (
  directory: string,
  crop: DrawingCrop,
  destination: string,
) {
  const source = yield* fixturePath(directory, crop.pdf);
  const [left, top] = crop.pdf_rect_points;
  const scale = 72 / crop.dpi;

  const bytes = yield* Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn(
        [
          "pdftoppm",
          "-f",
          String(crop.page),
          "-l",
          String(crop.page),
          "-r",
          String(crop.dpi),
          "-x",
          String(left / scale),
          "-y",
          String(top / scale),
          "-W",
          String(crop.width_px),
          "-H",
          String(crop.height_px),
          "-singlefile",
          "-png",
          source,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });

      try {
        const [output, , code] = await Promise.all([
          new Response(child.stdout).bytes(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        if (code !== 0) throw new Error("PDF renderer failed");

        return output;
      } finally {
        signal.removeEventListener("abort", abort);
        child.kill();
        await child.exited;
      }
    },
    catch: () =>
      new DrawingInputError({
        message: `Cannot render ${crop.id}; install Poppler and check the PDF/page.`,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(new DrawingInputError({ message: `PDF rendering timed out: ${crop.id}.` })),
    }),
  );

  const size = yield* pngSize(bytes);

  if (size.width !== crop.width_px || size.height !== crop.height_px) {
    return yield* new DrawingInputError({
      message: `Rendered dimensions differ from the manifest: ${crop.id}.`,
    });
  }

  const pdfHash = yield* Effect.tryPromise({
    try: async () => sha256(await Bun.file(source).bytes()),
    catch: () => new DrawingInputError({ message: `Cannot hash the source PDF: ${crop.id}.` }),
  });

  yield* Effect.tryPromise({
    try: () => Bun.write(destination, bytes),
    catch: () => new DrawingInputError({ message: `Cannot save rendered crop: ${crop.id}.` }),
  });

  return { bytes, sha256: sha256(bytes), pdfSha256: pdfHash };
});
