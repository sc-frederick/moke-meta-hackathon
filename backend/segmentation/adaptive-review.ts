import { Effect, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { DrawingCrop, renderCrop, sha256 } from "./fixtures.ts";
import {
  MetaReviewClient,
  VisionBox,
  type VisualDevice,
  type ProposalDecision,
  type ReviewImage,
  type ReviewTool,
  type ReviewToolResult,
} from "./meta-review.ts";
import { casePrompt, readSegmentation, SamClient, type SegmentationCase } from "./sam.ts";
import { overlaySvg } from "./report.ts";
import { compareInventories, PixelBox, type NamedBox } from "./spatial-inventory.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/));
const Method = Schema.Literals(["sam-shapes", "blind-muse", "classify-sam"]);
const Survey = Schema.Struct({ method: Method });

const Inspect = Schema.Struct({
  targetId: Identifier,
  marginPixels: Schema.Int.check(Schema.isBetween({ minimum: 24, maximum: 160 })),
  purpose: Schema.NonEmptyString,
});

const Segment = Schema.Struct({
  targetId: Identifier,
  inspectionId: Identifier,
  objectIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mode: Schema.Literals(["points", "box", "guided"]),
});

const Finish = Schema.Struct({ summary: Schema.NonEmptyString });

const Correspondence = Schema.Struct({
  samId: Identifier,
  blindId: Identifier,
  inspectionIds: Schema.NonEmptyArray(Identifier),
  rationale: Schema.NonEmptyString,
});

/** One bounded electrical-room case; quantities and evaluation annotations are not inputs. */
export const AdaptiveCase = Schema.Struct({
  id: Identifier,
  crop: Identifier,
  pageWidthPoints: Schema.Int.check(Schema.isGreaterThan(0)),
  pageHeightPoints: Schema.Int.check(Schema.isGreaterThan(0)),
  task: Schema.NonEmptyString,
});

/** An invalid operation, exhausted allowance or local evidence failure. */
export class AdaptiveReviewError extends Schema.TaggedError<AdaptiveReviewError>()(
  "AdaptiveReviewError",
  { message: Schema.String },
) {}

type LocatedDevice = NamedBox & {
  readonly observation: typeof VisualDevice.Type;
  readonly frame: DrawingCrop;
  readonly imageId: string;
};

type Inspection = {
  readonly id: string;
  readonly targetId: string;
  readonly frame: DrawingCrop;
  readonly image: ReviewImage;
  readonly objects: ReadonlyArray<typeof VisualDevice.Type>;
};

type EvidenceRow = {
  readonly id: string;
  readonly status: "agreed" | "revised" | "linked" | "unresolved";
  readonly box: PixelBox;
  readonly samId: string | null;
  readonly blindId: string | null;
  readonly assertions: ReadonlyArray<{
    readonly method: string;
    readonly imageId: string;
    readonly frame: DrawingCrop;
    readonly labels: (typeof VisualDevice.Type)["labels"];
  }>;
};

const instructions = `You audit drawing evidence, not code compliance. Your tools run locally against original PDF pixels and Meta SAM3.1/Muse Spark1.3. You must use all three survey_room methods: sam-shapes, blind-muse, then classify-sam. The blind observer is isolated from earlier counts/proposals. It can miss or mislocate objects; SAM confidence does not verify class.
Compare the resulting inventories spatially. A semantic proposal is not a correct location. Investigate unmatched or ambiguous candidates from either path with inspect_region. The tool returns a higher-resolution original source crop and an independent observation. Inspect all returned images. Pick the actual matching receptacle by its source strokes, not by proximity alone. If appropriate, call segment_candidate using the fresh inspection object's points, box or guided strategy. Fresh points often work better than retaining an inaccurate box. After segmentation inspect the returned original/overlay feedback. If the association is wrong, request another inspection or try another strategy; each target allows two inspections. A partial visible symbol can support location, but never claim complete geometry or physical clearance.
When an unmatched SAM and blind proposal visibly refer to the same physical symbol despite box offsets, inspect BOTH proposal IDs and use record_correspondence to record the evidence-backed relationship instead of leaving duplicate rows or modifying good SAM geometry just to force overlap. Each relationship remains model-proposed and review-pending. A prose statement alone does not update the worksheet.
Keep room, panel, circuit and visible protection assertions separate, with source evidence; unknowns remain unknown. Adjacent-room devices are not devices in the named room. Never adjust to a desired quantity: none is supplied. Do not invent fixtures from text or furniture. Do not stop solely because two counts agree. Use finish_review after investigating disagreements, or finish with explicit unresolved items when evidence remains ambiguous. This is a proposed inventory pending reviewer verification, not a confirmed permit finding.`;

const tools: ReadonlyArray<ReviewTool> = [
  {
    name: "survey_room",
    description:
      "Run or retrieve one independent baseline: SAM circle discovery, blind Muse inventory, or semantic classification of the existing SAM proposals. Returns current comparison; does not infer completeness.",
    parameters: Schema.toJsonSchemaDocument(Survey, { onExcessProperty: "error" }).schema,
  },
  {
    name: "inspect_region",
    description:
      "Request a fresh source zoom around a sam-* or blind-* proposal ID. Original PDF pixels are rendered at twice the initial DPI; a separate Muse observer supplies source assertions and fresh point guidance. No original proposal count is supplied to that observer. Each target allows two inspections.",
    parameters: Schema.toJsonSchemaDocument(Inspect, { onExcessProperty: "error" }).schema,
  },
  {
    name: "segment_candidate",
    description:
      "Use an object from a requested inspection as fresh SAM guidance for the target. Select points, box or guided strategy. Returns geometry plus original/overlay image feedback. A returned mask does not validate fixture class.",
    parameters: Schema.toJsonSchemaDocument(Segment, { onExcessProperty: "error" }).schema,
  },
  {
    name: "record_correspondence",
    description:
      "Record a proposed one-to-one relationship between a classified SAM receptacle and a blind proposal when their source zooms show the same physical symbol despite differing boxes. Requires inspection IDs covering BOTH targets. Keeps SAM geometry and both observations; no new segmentation or semantic verification is implied. Does not establish complete coverage.",
    parameters: Schema.toJsonSchemaDocument(Correspondence, { onExcessProperty: "error" }).schema,
  },
  {
    name: "finish_review",
    description:
      "Finish the bounded review after all three surveys. Unmatched proposals remain unresolved, not silently accepted. Include a factual summary of supported evidence and remaining uncertainty.",
    parameters: Schema.toJsonSchemaDocument(Finish, { onExcessProperty: "error" }).schema,
  },
];

const write = Effect.fn("writeAdaptiveArtifact")(function* (
  path: string,
  body: string | Uint8Array,
) {
  yield* Effect.tryPromise({
    try: () => Bun.write(path, body),
    catch: () => new AdaptiveReviewError({ message: `Cannot save adaptive evidence: ${path}.` }),
  });
});

function normalize(box: PixelBox, image: ReviewImage): typeof VisionBox.Type {
  return {
    left: Math.max(0, Math.floor((box.left / image.width) * 1000)),
    top: Math.max(0, Math.floor((box.top / image.height) * 1000)),
    right: Math.min(1000, Math.ceil((box.right / image.width) * 1000)),
    bottom: Math.min(1000, Math.ceil((box.bottom / image.height) * 1000)),
  };
}

const pixelBox = Effect.fn("readVisionPixelBox")(function* (
  box: typeof VisionBox.Type,
  image: ReviewImage,
) {
  return yield* Schema.decodeUnknownEffect(PixelBox)({
    left: Math.floor((box.left * image.width) / 1000),
    top: Math.floor((box.top * image.height) / 1000),
    right: Math.ceil((box.right * image.width) / 1000),
    bottom: Math.ceil((box.bottom * image.height) / 1000),
  }).pipe(
    Effect.mapError(() => new AdaptiveReviewError({ message: "Vision box has invalid area." })),
  );
});

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

/** Run a bounded local evidence-seeking review through real Meta tool calls. */
export const runAdaptiveReview = Effect.fn("runAdaptiveReview")(function* (options: {
  readonly fixtures: string;
  readonly crop: DrawingCrop;
  readonly scenario: typeof AdaptiveCase.Type;
  readonly output: string;
  readonly live: boolean;
  readonly maximumTurns: number;
  readonly maximumSamCalls: number;
}) {
  const model = yield* MetaReviewClient;
  const sam = yield* SamClient;
  yield* Effect.tryPromise({
    try: () => mkdir(options.output, { recursive: false }),
    catch: () => new AdaptiveReviewError({ message: "Adaptive run directory must be new." }),
  });

  for (const name of ["inputs", "sam", "inspections"]) {
    yield* Effect.tryPromise({
      try: () => mkdir(resolve(options.output, name)),
      catch: () =>
        new AdaptiveReviewError({ message: `Cannot create ${name} evidence directory.` }),
    });
  }

  const rendered = yield* renderCrop(
    options.fixtures,
    options.crop,
    resolve(options.output, "inputs/base.png"),
  );

  const source: ReviewImage = {
    id: "base",
    bytes: rendered.bytes,
    width: options.crop.width_px,
    height: options.crop.height_px,
  };

  // Manifest prose can contain earlier audit answers; it must never enter model tool results.
  const crop = {
    ...options.crop,
    purpose: "Original electrical drawing source.",
    sha256: sha256(source.bytes),
  };

  yield* write(
    resolve(options.output, "source.json"),
    JSON.stringify(
      {
        crop,
        manifestPurpose: options.crop.purpose,
        scenario: options.scenario,
        inputSha256: sha256(source.bytes),
        pdfSha256: rendered.pdfSha256,
      },
      null,
      2,
    ),
  );
  let discovered: ReadonlyArray<NamedBox> | null = null;
  let blind: ReadonlyArray<LocatedDevice> | null = null;
  let classified: ReadonlyArray<typeof ProposalDecision.Type> | null = null;
  const inspections = new Map<string, Inspection>();
  const corrections = new Map<string, LocatedDevice>();
  const inspectionCounts = new Map<string, number>();
  const correspondences: Array<typeof Correspondence.Type> = [];

  const trace: Array<{
    turn: number;
    action: string;
    arguments: string;
    result: Schema.JsonObject;
  }> = [];

  const images = new Map<string, ReviewImage>([[source.id, source]]);
  let calls = 0;
  let turns = 0;
  let status = options.live ? "running" : "prepared";
  let summary = "No completeness or compliance finding is established.";

  const snapshot = Effect.fn("snapshotAdaptiveReview")(function* () {
    const retained =
      discovered
        ?.values()
        .filter((object) => classified?.some((d) => d.id === object.id && d.kind === "receptacle"))
        .map((object) => corrections.get(object.id) ?? object)
        .toArray() ?? [];

    const independent = blind?.map((object) => corrections.get(object.id) ?? object) ?? [];
    const linkedSam = new Set(correspondences.map((c) => c.samId));
    const linkedBlind = new Set(correspondences.map((c) => c.blindId));

    const automatic = yield* compareInventories(
      retained.filter((object) => !linkedSam.has(object.id)),
      independent.filter((object) => !linkedBlind.has(object.id)),
    );

    const allMatches = [
      ...automatic.matches,
      ...correspondences.map((c) => ({
        leftId: c.samId,
        rightId: c.blindId,
        sourceInspections: c.inspectionIds,
        rationale: c.rationale,
      })),
    ];

    const comparison = {
      matches: allMatches,
      leftOnly: retained.filter((o) => !allMatches.some((m) => m.leftId === o.id)).map((o) => o.id),
      rightOnly: independent
        .filter((o) => !allMatches.some((m) => m.rightId === o.id))
        .map((o) => o.id),
      ambiguous: automatic.ambiguous,
      correspondences: [...correspondences],
    };

    const blindAssertions = (object: LocatedDevice): EvidenceRow["assertions"] => {
      const original = blind?.find((o) => o.id === object.id) ?? object;
      const correction = corrections.get(object.id);

      return [
        {
          method: "blind-inventory",
          imageId: original.imageId,
          frame: original.frame,
          labels: original.observation.labels,
        },
        ...(correction
          ? [
              {
                method: "zoom-observation",
                imageId: correction.imageId,
                frame: correction.frame,
                labels: correction.observation.labels,
              },
            ]
          : []),
      ];
    };

    const rows: Array<EvidenceRow> = retained.map((object) => {
      const match = comparison.matches.find((m) => m.leftId === object.id);
      const observed = independent.find((o) => o.id === match?.rightId);
      const decision = classified?.find((d) => d.id === object.id);
      const correction = corrections.get(object.id);

      return {
        id: object.id,
        box: object.box,
        samId: object.id,
        blindId: observed?.id ?? null,
        status: linkedSam.has(object.id)
          ? "linked"
          : observed
            ? corrections.has(observed.id) || corrections.has(object.id)
              ? "revised"
              : "agreed"
            : "unresolved",
        assertions: [
          ...(correction
            ? [
                {
                  method: "sam-zoom-observation",
                  imageId: correction.imageId,
                  frame: correction.frame,
                  labels: correction.observation.labels,
                },
              ]
            : []),
          ...(decision
            ? [
                {
                  method: "sam-classification",
                  imageId: source.id,
                  frame: crop,
                  labels: decision.labels,
                },
              ]
            : []),
          ...(observed ? blindAssertions(observed) : []),
        ],
      };
    });

    for (const object of independent.filter((o) => comparison.rightOnly.includes(o.id))) {
      rows.push({
        id: object.id,
        box: object.box,
        samId: null,
        blindId: object.id,
        status: corrections.has(object.id) ? "revised" : "unresolved",
        assertions: blindAssertions(object),
      });
    }

    return {
      status,
      summary,
      review: "pending" as const,
      source: { crop, inputSha256: sha256(source.bytes), pdfSha256: rendered.pdfSha256 },
      counts: {
        samRaw: discovered?.length ?? null,
        samClassified: classified ? retained.length : null,
        blindProposals: blind?.length ?? null,
        proposedRows: rows.length,
        unresolved: rows.filter((r) => r.status === "unresolved").length,
        corrections: corrections.size,
        samCalls: calls,
        reasoningTurns: turns,
      },
      comparison,
      rows,
      trace,
    };
  });

  const checkpoint = Effect.fn("checkpointAdaptiveReview")(function* () {
    const data = yield* snapshot();
    yield* write(resolve(options.output, "result.json"), JSON.stringify(data, null, 2));

    const label = (row: EvidenceRow, name: keyof (typeof VisualDevice.Type)["labels"]) => {
      const assertions = row.assertions
        .map((a) => a.labels[name])
        .filter(
          (a) =>
            a.value !== null &&
            a.quote.trim().length > 0 &&
            a.box !== null &&
            a.box.right > a.box.left &&
            a.box.bottom > a.box.top,
        );

      const values = [...new Set(assertions.map((a) => a.value))];

      return values.length ? values.map((v) => html(v ?? "Unknown")).join(" / ") : "Unknown";
    };

    const rowMarkup = data.rows
      .map(
        (row) =>
          `<tr><th>${html(row.id)}</th><td>${html(row.status)}</td><td>${label(row, "room")}</td><td>${label(row, "panel")}</td><td>${label(row, "circuit")}</td><td>${label(row, "protection")}</td><td><details><summary>Source assertions</summary><pre>${html(JSON.stringify(row.assertions, null, 2))}</pre></details></td></tr>`,
      )
      .join("");

    const sourceUrl = `data:image/png;base64,${Buffer.from(source.bytes).toString("base64")}`;

    const marks = data.rows
      .map(
        (row) =>
          `<rect x="${row.box.left}" y="${row.box.top}" width="${row.box.right - row.box.left}" height="${row.box.bottom - row.box.top}" fill="none" stroke="${row.status === "unresolved" ? "#b45309" : "#0072b2"}" stroke-width="3"/>`,
      )
      .join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}"><image href="${sourceUrl}" width="${source.width}" height="${source.height}"/>${marks}</svg>`;

    const extraImages = images
      .values()
      .filter((i) => i.id !== "base")
      .map(
        (i) =>
          `<figure><img src="data:image/png;base64,${Buffer.from(i.bytes).toString("base64")}" alt="${html(i.id)}"/><figcaption>${html(i.id)}</figcaption></figure>`,
      )
      .toArray()
      .join("");

    yield* write(
      resolve(options.output, "report.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adaptive Meta electrical review</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1450px;margin:auto;padding:24px;background:#f4f6f8;color:#172033}table{border-collapse:collapse;width:100%;background:white}td,th{text-align:left;padding:10px;border-bottom:1px solid #ccd5df}img{max-width:100%;max-height:750px;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}figure,details{background:white;padding:16px;border:1px solid #ccd5df}.note{border-left:4px solid #b45309;padding:12px;background:white}</style><h1>Meta · Evidence-seeking electrical review</h1><p>${html(options.scenario.task)}</p><p class="note">Status: ${html(status)}. ${html(summary)} All rows are proposed evidence pending reviewer verification. “GFI” means visible notation, not verified protection or compliance. Agreement does not establish coverage.</p><p>SAM shapes: ${data.counts.samRaw ?? "—"} → classified receptacles: ${data.counts.samClassified ?? "—"}; independent Muse proposals: ${data.counts.blindProposals ?? "—"}; current rows: ${data.counts.proposedRows}; unresolved: ${data.counts.unresolved}; corrections: ${data.counts.corrections}.</p><h2>Source and proposed locations</h2><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" alt="Original source with proposed instance boxes"/><h2>Room, circuit and visible notation</h2><div style="overflow:auto"><table><thead><tr><th>Instance</th><th>Evidence state</th><th>Room</th><th>Panel</th><th>Circuit</th><th>Visible protection</th><th>Evidence</th></tr></thead><tbody>${rowMarkup}</tbody></table></div><h2>Model-requested evidence operations</h2>${trace.map((t) => `<details open><summary>${t.turn}. ${html(t.action)}</summary><pre>${html(t.arguments)}</pre><pre>${html(JSON.stringify(t.result, null, 2))}</pre></details>`).join("")}<h2>Inspections and segmentation feedback</h2><div class="gallery">${extraImages}</div></html>`,
    );

    return data;
  });

  const segment = Effect.fn("segmentAdaptiveEvidence")(function* (
    frame: DrawingCrop,
    image: ReviewImage,
    prompt: SegmentationCase["prompt"],
  ) {
    if (calls >= options.maximumSamCalls)
      return yield* new AdaptiveReviewError({ message: "SAM call budget exhausted." });
    const id = `sam-call-${++calls}`;

    const scenario: SegmentationCase = {
      id,
      crop: frame.id,
      prompt,
      purpose: "Adaptive model-requested evidence; not independent semantic validation.",
    };

    const text = yield* casePrompt(scenario, frame);
    yield* write(
      resolve(options.output, "sam", `${id}-request.json`),
      JSON.stringify({ scenario, frame, inputSha256: sha256(image.bytes), prompt: text }, null, 2),
    );
    const response = yield* sam.segment(text, image.bytes);
    yield* write(resolve(options.output, "sam", `${id}-response.json`), response.body);
    const parsed = yield* readSegmentation(response, frame);
    yield* write(
      resolve(options.output, "sam", `${id}-result.json`),
      JSON.stringify(parsed, null, 2),
    );

    const svg = overlaySvg(parsed, frame, image.bytes).replace(
      /<text\b[^>]*>[\s\S]*?<\/text>/g,
      "",
    );

    yield* write(resolve(options.output, "sam", `${id}-overlay.svg`), svg);

    const feedback = yield* Effect.try({
      try: () => new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng(),
      catch: () => new AdaptiveReviewError({ message: "Cannot render SAM feedback image." }),
    });

    const overlay: ReviewImage = {
      id: `${id}-overlay`,
      bytes: feedback,
      width: image.width,
      height: image.height,
    };

    images.set(overlay.id, overlay);
    yield* write(resolve(options.output, "sam", `${id}-overlay.png`), feedback);

    return { parsed, overlay };
  });

  const current = Effect.fn("currentAdaptiveComparison")(function* (
    data: Schema.JsonObject,
    pictures: ReadonlyArray<ReviewImage> = [],
  ) {
    const state = yield* snapshot();

    return {
      data: {
        observation: data,
        state: {
          status: state.status,
          counts: state.counts,
          comparison: state.comparison,
          rows: state.rows,
        },
      },
      images: pictures,
    };
  });

  const perform = Effect.fn("performAdaptiveOperation")(function* (
    name: string,
    argumentsText: string,
  ) {
    if (name === "survey_room") {
      const args = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Survey))(
        argumentsText,
      ).pipe(
        Effect.mapError(() => new AdaptiveReviewError({ message: "Invalid survey arguments." })),
      );

      if (args.method === "sam-shapes" && discovered === null) {
        const result = yield* segment(crop, source, { kind: "concept", text: "circle" });
        discovered = result.parsed.objects.map((o) => ({ id: `sam-${o.id}`, box: o.pixels }));

        return yield* current({ method: args.method, objects: discovered }, [result.overlay]);
      }

      if (args.method === "blind-muse" && blind === null) {
        const result = yield* model.inventory(source, false);
        const objects: Array<LocatedDevice> = [];

        for (const [index, observation] of result.objects.entries()) {
          objects.push({
            id: `blind-${index}`,
            box: yield* pixelBox(observation.box, source),
            observation,
            frame: crop,
            imageId: source.id,
          });
        }

        blind = objects;
      }

      if (args.method === "classify-sam" && classified === null) {
        if (discovered === null)
          return yield* new AdaptiveReviewError({ message: "Run sam-shapes before classify-sam." });
        classified =
          discovered.length === 0
            ? []
            : (yield* model.classify(
                source,
                discovered.map((o) => ({ id: o.id, box: normalize(o.box, source) })),
              )).decisions;
      }

      return yield* current({ method: args.method, blind, classified });
    }

    if (name === "inspect_region") {
      const args = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Inspect))(
        argumentsText,
      ).pipe(
        Effect.mapError(
          () => new AdaptiveReviewError({ message: "Invalid inspection arguments." }),
        ),
      );

      const target =
        corrections.get(args.targetId) ??
        blind?.find((o) => o.id === args.targetId) ??
        discovered?.find((o) => o.id === args.targetId);

      if (!target)
        return yield* new AdaptiveReviewError({ message: "Unknown inspection target ID." });
      const count = inspectionCounts.get(args.targetId) ?? 0;

      if (count >= 2)
        return yield* new AdaptiveReviewError({
          message: "Two-inspection allowance exhausted for this target.",
        });
      inspectionCounts.set(args.targetId, count + 1);
      const b = target.box;
      const scale = crop.pixel_to_pdf.scale;

      const left = Math.max(
        0,
        Math.floor(
          (crop.pixel_to_pdf.offset_points[0] + (b.left - args.marginPixels) * scale) / 6,
        ) * 6,
      );

      const top = Math.max(
        0,
        Math.floor((crop.pixel_to_pdf.offset_points[1] + (b.top - args.marginPixels) * scale) / 6) *
          6,
      );

      const right = Math.min(
        options.scenario.pageWidthPoints,
        Math.ceil(
          (crop.pixel_to_pdf.offset_points[0] + (b.right + args.marginPixels) * scale) / 6,
        ) * 6,
      );

      const bottom = Math.min(
        options.scenario.pageHeightPoints,
        Math.ceil(
          (crop.pixel_to_pdf.offset_points[1] + (b.bottom + args.marginPixels) * scale) / 6,
        ) * 6,
      );

      const id = `inspection-${inspections.size + 1}`;
      const dpi = crop.dpi * 2;

      const frame = yield* Schema.decodeUnknownEffect(DrawingCrop)({
        ...crop,
        id,
        file: `inspections/${id}.png`,
        pdf_rect_points: [left, top, right, bottom],
        dpi,
        width_px: Math.round(((right - left) * dpi) / 72),
        height_px: Math.round(((bottom - top) * dpi) / 72),
        pixel_to_pdf: { scale: 72 / dpi, offset_points: [left, top] },
        purpose: args.purpose,
      });

      const renderedZoom = yield* renderCrop(
        options.fixtures,
        frame,
        resolve(options.output, "inspections", `${id}.png`),
      );

      const image: ReviewImage = {
        id,
        bytes: renderedZoom.bytes,
        width: frame.width_px,
        height: frame.height_px,
      };

      images.set(id, image);
      const observed = yield* model.inventory(image, true);

      const inspection: Inspection = {
        id,
        targetId: args.targetId,
        frame: { ...frame, sha256: sha256(image.bytes) },
        image,
        objects: observed.objects,
      };

      inspections.set(id, inspection);
      yield* write(
        resolve(options.output, "inspections", `${id}.json`),
        JSON.stringify(
          {
            ...inspection,
            image: { id, sha256: sha256(image.bytes), width: image.width, height: image.height },
          },
          null,
          2,
        ),
      );

      return yield* current(
        {
          inspectionId: id,
          targetId: args.targetId,
          objects: observed.objects,
          coordinateSystem: "normalized0–1000 on the inspection image",
          guidance:
            "Select a visible actual object and fresh segmentation strategy; do not preserve the original target box.",
        },
        [image],
      );
    }

    if (name === "segment_candidate") {
      const args = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Segment))(
        argumentsText,
      ).pipe(
        Effect.mapError(
          () => new AdaptiveReviewError({ message: "Invalid segmentation arguments." }),
        ),
      );

      const inspection = inspections.get(args.inspectionId);

      if (!inspection || inspection.targetId !== args.targetId)
        return yield* new AdaptiveReviewError({
          message: "Inspection does not belong to that target.",
        });
      const object = inspection.objects[args.objectIndex];

      if (!object)
        return yield* new AdaptiveReviewError({ message: "Unknown inspection object index." });
      const box = yield* pixelBox(object.box, inspection.image);
      const guidance = object.guidance;

      if (args.mode !== "box" && !guidance)
        return yield* new AdaptiveReviewError({
          message: "Inspection supplied no fresh point guidance.",
        });

      const point = (p: { readonly x: number; readonly y: number }) => ({
        x: Math.min(inspection.image.width - 1, Math.floor((p.x * inspection.image.width) / 1000)),
        y: Math.min(
          inspection.image.height - 1,
          Math.floor((p.y * inspection.image.height) / 1000),
        ),
      });

      const points = guidance
        ? [
            { ...point(guidance.positive), label: "positive" as const },
            ...(guidance.negative
              ? [{ ...point(guidance.negative), label: "negative" as const }]
              : []),
          ]
        : [];

      let prompt: SegmentationCase["prompt"] = { kind: "box", box };

      if (args.mode !== "box") {
        const [first, ...rest] = points;

        if (!first)
          return yield* new AdaptiveReviewError({ message: "Fresh point guidance is empty." });
        prompt =
          args.mode === "guided"
            ? { kind: "guided", box, points: [first, ...rest] }
            : { kind: "points", points: [first, ...rest] };
      }

      const result = yield* segment(inspection.frame, inspection.image, prompt);
      const [mask] = result.parsed.objects;

      if (result.parsed.objects.length === 1 && mask) {
        const mapped = {
          left:
            (mask.pdfPoints.left - crop.pixel_to_pdf.offset_points[0]) / crop.pixel_to_pdf.scale,
          top: (mask.pdfPoints.top - crop.pixel_to_pdf.offset_points[1]) / crop.pixel_to_pdf.scale,
          right:
            (mask.pdfPoints.right - crop.pixel_to_pdf.offset_points[0]) / crop.pixel_to_pdf.scale,
          bottom:
            (mask.pdfPoints.bottom - crop.pixel_to_pdf.offset_points[1]) / crop.pixel_to_pdf.scale,
        };

        if (
          mapped.left < 0 ||
          mapped.top < 0 ||
          mapped.right > source.width ||
          mapped.bottom > source.height
        ) {
          return yield* current(
            {
              targetId: args.targetId,
              rejected:
                "Mask extends outside the original study crop. Worksheet box unchanged. Inspect the source and overlay, then try fresh guidance or leave unresolved.",
              objects: result.parsed.objects,
            },
            [inspection.image, result.overlay],
          );
        }

        corrections.set(args.targetId, {
          id: args.targetId,
          box: yield* Schema.decodeUnknownEffect(PixelBox)(mapped),
          observation: object,
          frame: inspection.frame,
          imageId: inspection.image.id,
        });
      }

      return yield* current(
        {
          targetId: args.targetId,
          mode: args.mode,
          objects: result.parsed.objects,
          warning: "Inspect association in the overlay; mask success is not semantic verification.",
        },
        [inspection.image, result.overlay],
      );
    }

    if (name === "record_correspondence") {
      const args = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Correspondence))(
        argumentsText,
      ).pipe(
        Effect.mapError(
          () => new AdaptiveReviewError({ message: "Invalid correspondence arguments." }),
        ),
      );

      if (
        !classified?.some((d) => d.id === args.samId && d.kind === "receptacle") ||
        !blind?.some((d) => d.id === args.blindId)
      ) {
        return yield* new AdaptiveReviewError({
          message: "Correspondence requires a classified SAM receptacle and known blind proposal.",
        });
      }

      const evidence = args.inspectionIds.map((id) => inspections.get(id));

      if (
        evidence.some(
          (i) => i === undefined || (i.targetId !== args.samId && i.targetId !== args.blindId),
        ) ||
        !evidence.some((i) => i?.targetId === args.samId) ||
        !evidence.some((i) => i?.targetId === args.blindId)
      ) {
        return yield* new AdaptiveReviewError({
          message:
            "Inspect both proposal IDs and cite only their source inspections before linking them.",
        });
      }

      if (correspondences.some((c) => c.samId === args.samId || c.blindId === args.blindId)) {
        return yield* new AdaptiveReviewError({
          message: "A proposal already has a recorded correspondence.",
        });
      }

      correspondences.push(args);

      return yield* current({
        recorded: args,
        warning: "Model-proposed association; reviewer verification remains pending.",
      });
    }

    if (name === "finish_review") {
      const args = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Finish))(
        argumentsText,
      ).pipe(
        Effect.mapError(() => new AdaptiveReviewError({ message: "Invalid finish arguments." })),
      );

      if (discovered === null || blind === null || classified === null)
        return yield* new AdaptiveReviewError({
          message: "Complete all three independent baseline operations before finishing.",
        });
      status = "finished";
      summary = args.summary;

      return yield* current({
        finished: true,
        warning:
          "Any unmatched entries remain unresolved and every row requires reviewer verification.",
      });
    }

    return yield* new AdaptiveReviewError({ message: "Unknown evidence tool." });
  });

  const loop = Effect.gen(function* () {
    if (!options.live) return yield* checkpoint();
    let continuation: string | undefined;
    let results: ReadonlyArray<ReviewToolResult> = [];

    while (turns < options.maximumTurns && status === "running") {
      turns++;

      const turn = yield* model.turn({
        instructions,
        prompt: options.scenario.task,
        tools,
        image: source,
        continuation,
        results,
      });

      continuation = turn.continuation;

      if (turn.actions.length === 0) {
        status = "model-stopped";
        summary = turn.message || "Model stopped without finishing the bounded review.";
        break;
      }

      const outputs: Array<ReviewToolResult> = [];

      for (const action of turn.actions) {
        const result = yield* perform(action.name, action.arguments).pipe(
          Effect.catchTag("AdaptiveReviewError", (error) =>
            Effect.succeed({ data: { error: error.message }, images: [] }),
          ),
        );

        trace.push({
          turn: turns,
          action: action.name,
          arguments: action.arguments,
          result: result.data,
        });
        outputs.push({ actionId: action.id, ...result });
        yield* checkpoint();
      }

      results = outputs;
    }

    if (status === "running") {
      status = "budget-exhausted";
      summary = "Reasoning-turn allowance exhausted; remaining evidence is unresolved.";
    }

    return yield* checkpoint();
  });

  return yield* loop.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        status = "failed";
        summary = error.message;

        return yield* checkpoint();
      }),
    ),
  );
});
