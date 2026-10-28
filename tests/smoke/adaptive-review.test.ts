import { afterEach, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdaptiveCase, runAdaptiveReview } from "../../backend/segmentation/adaptive-review.ts";
import { DrawingCrop, pngSize, sha256 } from "../../backend/segmentation/fixtures.ts";
import {
  MetaReviewClient,
  MetaReviewError,
  VisualDevice,
  type ReviewAction,
  type ReviewTurn,
} from "../../backend/segmentation/meta-review.ts";
import { SamClient } from "../../backend/segmentation/sam.ts";

const temporary: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const hiddenQuantity = "hidden expected quantity:999";

const crop = Schema.decodeUnknownSync(DrawingCrop)({
  id: "synthetic-room",
  file: "reference.png",
  pdf: "drawing.pdf",
  page: 1,
  sheet: "TEST",
  pdf_rect_points: [12, 24, 88.8, 104.16],
  dpi: 300,
  width_px: 320,
  height_px: 334,
  pixel_to_pdf: { scale: 0.24, offset_points: [12, 24] },
  purpose: hiddenQuantity,
  sha256: "0".repeat(64),
});

const scenario = Schema.decodeUnknownSync(AdaptiveCase)({
  id: "source-review",
  crop: crop.id,
  pageWidthPoints: 200,
  pageHeightPoints: 200,
  task: "Locate visible receptacles and report unresolved source evidence.",
});

const labels = {
  room: { value: null, quote: "", box: null },
  panel: { value: null, quote: "", box: null },
  circuit: { value: null, quote: "", box: null },
  protection: { value: null, quote: "", box: null },
};

function device(
  box: (typeof VisualDevice.Type)["box"],
  guidance: (typeof VisualDevice.Type)["guidance"] = null,
) {
  return Schema.decodeUnknownSync(VisualDevice)({
    box,
    labels,
    rationale: "Synthetic observer evidence",
    guidance,
  });
}

function action(name: string, args: Schema.JsonObject): ReviewAction {
  return { id: name, name, arguments: JSON.stringify(args) };
}

function turn(actions: ReadonlyArray<ReviewAction>): ReviewTurn {
  return { continuation: "synthetic-continuation", actions, message: "" };
}

function reviewer(ports: Partial<MetaReviewClient["Service"]>) {
  return MetaReviewClient.of({
    inventory: () => Effect.die("Unexpected inventory operation"),
    classify: () => Effect.die("Unexpected classification operation"),
    turn: () => Effect.die("Unexpected reasoning operation"),
    ...ports,
  });
}

// Complete 60x27 mask from Meta's parser conformance example; boxes may scale it.
const conformanceMask =
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function maskResponse(width = 320, height = 334, left = 211, top = 228, boxScale = 1) {
  const text =
    `<0f>7<|box;x1=${left};y1=${top};x2=${left + 60 * boxScale - 1};y2=${top + 27 * boxScale - 1};w=${width};h=${height}|>` +
    conformanceMask;

  return {
    status: 200,
    body: JSON.stringify({
      id: "synthetic-sam",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    }),
  };
}

function syntheticPdf(): string {
  const stream = "0 0 0 RG 20 20 40 40 re S\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: Array<number> = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const start = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;

  return pdf;
}

async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), "moke-adaptive-"));
  temporary.push(directory);
  await Bun.write(join(directory, "drawing.pdf"), syntheticPdf());

  return {
    fixtures: directory,
    output: join(directory, "run"),
    crop,
    scenario,
    live: true,
    maximumTurns: 3,
    maximumSamCalls: 2,
  };
}

const baselines = [
  action("survey_room", { method: "sam-shapes" }),
  action("survey_room", { method: "blind-muse" }),
  action("survey_room", { method: "classify-sam" }),
];

test.skipIf(Bun.which("pdftoppm") === null)(
  "adaptive review rejects early finish and isolates its no-count blind baseline",
  async () => {
    const options = await prepare();
    let reasoningTurns = 0;
    const blindImages: Array<{ id: string; hash: string }> = [];
    const prompts: Array<string> = [];

    const model = reviewer({
      inventory: (image, inspect) =>
        Effect.sync(() => {
          expect(inspect).toBe(false);
          blindImages.push({ id: image.id, hash: sha256(image.bytes) });

          return { objects: [device({ left: 660, top: 684, right: 846, bottom: 763 })] };
        }),
      classify: (image, proposals) =>
        Effect.sync(() => {
          expect(image.id).toBe("base");
          expect(proposals).toEqual([
            { id: "sam-7", box: { left: 659, top: 682, right: 847, bottom: 764 } },
          ]);

          return {
            decisions: [{ id: "sam-7", kind: "receptacle", labels, rationale: "Visible symbol" }],
          };
        }),
      turn: (input) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          expect(JSON.stringify(input.results)).not.toContain(hiddenQuantity);

          if (reasoningTurns++ === 0) {
            expect(input.results).toEqual([]);

            return turn([action("finish_review", { summary: "Unsupported early finish" })]);
          }

          if (reasoningTurns === 2) {
            expect(input.results[0]?.data).toEqual({
              error: "Complete all three independent baseline operations before finishing.",
            });

            return turn(baselines);
          }

          return turn([
            action("finish_review", { summary: "One proposed association; verification pending." }),
          ]);
        }),
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, { segment: () => Effect.succeed(maskResponse()) }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.review).toBe("pending");
    expect(result.counts).toMatchObject({
      samRaw: 1,
      samClassified: 1,
      blindProposals: 1,
      proposedRows: 1,
      unresolved: 0,
      samCalls: 1,
    });
    expect(result.rows[0]?.status).toBe("agreed");
    expect(prompts).toEqual([scenario.task, scenario.task, scenario.task]);
    expect(blindImages).toEqual([{ id: "base", hash: result.source.inputSha256 }]);
    expect(await Bun.file(join(options.output, "source.json")).text()).toContain(hiddenQuantity);
    expect(await Bun.file(join(options.output, "inputs/base.png")).exists()).toBe(true);
    expect(await Bun.file(join(options.output, "sam/sam-call-1-overlay.png")).exists()).toBe(true);
    expect(await Bun.file(join(options.output, "report.html")).text()).toContain(
      "Agreement does not establish coverage.",
    );
  },
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "fresh inspection segmentation joins observations through PDF coordinates across DPI and offsets",
  async () => {
    const options = { ...(await prepare()), maximumTurns: 4 };
    const guidanceRequests: Array<string> = [];

    const model = reviewer({
      inventory: (image, inspect) =>
        Effect.sync(() => {
          expect(image.id).toBe(inspect ? "inspection-1" : "base");

          return {
            objects: [
              inspect
                ? device(
                    { left: 125, top: 200, right: 200, bottom: 240 },
                    { positive: { x: 175, y: 220 }, negative: { x: 900, y: 900 } },
                  )
                : device({ left: 312, top: 374, right: 407, bottom: 415 }),
            ],
          };
        }),
      classify: () =>
        Effect.succeed({
          decisions: [
            {
              id: "sam-7",
              kind: "receptacle",
              labels,
              rationale: "Proposal needs location correction",
            },
          ],
        }),
      turn: (input) =>
        Effect.sync(() => {
          expect(JSON.stringify(input.results)).not.toContain(hiddenQuantity);

          if (!input.continuation) return turn(baselines);
          const previous = input.results[0];

          if (previous?.actionId === "survey_room") {
            return turn([
              action("inspect_region", {
                targetId: "sam-7",
                marginPixels: 160,
                purpose: "Resolve unmatched source geometry",
              }),
            ]);
          }

          if (previous?.actionId === "inspect_region") {
            return turn([
              action("segment_candidate", {
                targetId: "sam-7",
                inspectionId: "inspection-1",
                objectIndex: 0,
                mode: "points",
              }),
            ]);
          }

          expect(previous?.images.map((image) => image.id)).toEqual([
            "inspection-1",
            "sam-call-2-overlay",
          ]);

          return turn([
            action("finish_review", {
              summary: "Fresh geometry reconciles the proposed location.",
            }),
          ]);
        }),
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, {
          segment: (prompt, image) =>
            prompt === "circle"
              ? Effect.succeed(maskResponse())
              : pngSize(image).pipe(
                  Effect.map((size) => {
                    expect(size).toEqual({ width: 800, height: 750 });
                    guidanceRequests.push(prompt);

                    return maskResponse(size.width, size.height, 100, 150);
                  }),
                  Effect.orDie,
                ),
        }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.counts).toMatchObject({
      proposedRows: 1,
      unresolved: 0,
      corrections: 1,
      samCalls: 2,
    });
    expect(result.comparison.matches).toHaveLength(1);
    expect(result.rows[0]?.status).toBe("revised");
    expect(result.rows[0]?.box.left).toBeCloseTo(100);
    expect(result.rows[0]?.box.top).toBeCloseTo(125);
    expect(result.rows[0]?.box.right).toBeCloseTo(130);
    expect(result.rows[0]?.box.bottom).toBeCloseTo(138.5);
    expect(guidanceRequests).toHaveLength(1);
    expect(guidanceRequests[0]).toContain("x=140;y=165;w=800;h=750");
    expect(guidanceRequests[0]).toContain("-<|point;x=720;y=675;w=800;h=750|>");
    expect(guidanceRequests[0]).not.toContain("<|box;");
    expect(await Bun.file(join(options.output, "inspections/inspection-1.json")).text()).toContain(
      '"dpi": 600',
    );
    expect(await Bun.file(join(options.output, "result.json")).text()).toContain(
      '"status": "revised"',
    );
  },
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "zoom masks outside the original crop retain proposals and return feedback without failing review",
  async () => {
    const options = { ...(await prepare()), maximumTurns: 4 };

    const model = reviewer({
      inventory: (_image, inspect) =>
        Effect.succeed({
          objects: [
            inspect
              ? device(
                  { left: 0, top: 0, right: 100, bottom: 45 },
                  { positive: { x: 50, y: 25 }, negative: null },
                )
              : device({ left: 660, top: 684, right: 846, bottom: 763 }),
          ],
        }),
      classify: () =>
        Effect.succeed({
          decisions: [{ id: "sam-7", kind: "receptacle", labels, rationale: "Unmatched proposal" }],
        }),
      turn: (input) =>
        Effect.sync(() => {
          if (!input.continuation) return turn(baselines);
          const previous = input.results[0];

          if (previous?.actionId === "survey_room") {
            return turn([
              action("inspect_region", {
                targetId: "sam-7",
                marginPixels: 160,
                purpose: "Inspect a candidate near the original crop boundary",
              }),
            ]);
          }

          if (previous?.actionId === "inspect_region") {
            return turn([
              action("segment_candidate", {
                targetId: "sam-7",
                inspectionId: "inspection-1",
                objectIndex: 0,
                mode: "points",
              }),
            ]);
          }

          const feedback = Schema.decodeUnknownSync(
            Schema.Struct({
              observation: Schema.Struct({ targetId: Schema.String, rejected: Schema.String }),
            }),
          )(previous?.data);

          expect(feedback.observation.targetId).toBe("sam-7");
          expect(feedback.observation.rejected).toContain("outside the original study crop");
          expect(previous?.images.map((image) => image.id)).toEqual([
            "inspection-1",
            "sam-call-2-overlay",
          ]);

          return turn([
            action("finish_review", { summary: "Out-of-crop mask rejected; location unresolved." }),
          ]);
        }),
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, {
          segment: (prompt, image) =>
            prompt === "circle"
              ? Effect.succeed(maskResponse(320, 334, 10, 10))
              : pngSize(image).pipe(
                  Effect.map((size) => {
                    expect(size).toEqual({ width: 600, height: 600 });

                    // Valid within the zoom image, but negative on both base-crop axes.
                    return maskResponse(size.width, size.height, 0, 0);
                  }),
                  Effect.orDie,
                ),
        }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.counts).toMatchObject({
      proposedRows: 2,
      unresolved: 2,
      corrections: 0,
      samCalls: 2,
    });
    expect(result.rows.find((row) => row.samId === "sam-7")).toMatchObject({
      status: "unresolved",
      box: { left: 10, top: 10, right: 70, bottom: 37 },
    });
    const report = await Bun.file(join(options.output, "report.html")).text();
    expect(report).toContain("Mask extends outside the original study crop.");
  },
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "source-inspected correspondences merge duplicate observations without changing SAM geometry",
  async () => {
    const options = { ...(await prepare()), maximumTurns: 7 };
    let reasoningTurns = 0;

    const correspondence = (inspectionIds: ReadonlyArray<string>) =>
      action("record_correspondence", {
        samId: "sam-7",
        blindId: "blind-0",
        inspectionIds: [...inspectionIds],
        rationale: "Both source inspections identify the same physical receptacle.",
      });

    const model = reviewer({
      inventory: (_image, inspect) =>
        Effect.succeed({
          objects: [
            inspect
              ? device({ left: 125, top: 200, right: 200, bottom: 240 })
              : device({ left: 312, top: 374, right: 407, bottom: 415 }),
          ],
        }),
      classify: () =>
        Effect.succeed({
          decisions: [
            { id: "sam-7", kind: "receptacle", labels, rationale: "Visible source symbol" },
          ],
        }),
      turn: (input) =>
        Effect.sync(() => {
          reasoningTurns++;

          switch (reasoningTurns) {
            case 1:
              return turn(baselines);
            case 2:
              expect(input.results.at(-1)?.data).toMatchObject({
                state: { counts: { proposedRows: 2, unresolved: 2 } },
              });

              return turn([
                action("inspect_region", {
                  targetId: "sam-7",
                  marginPixels: 160,
                  purpose: "Inspect the SAM-side source symbol",
                }),
              ]);
            case 3:
              return turn([correspondence(["inspection-1"])]);
            case 4:
              expect(input.results[0]?.data).toEqual({
                error:
                  "Inspect both proposal IDs and cite only their source inspections before linking them.",
              });

              return turn([
                action("inspect_region", {
                  targetId: "blind-0",
                  marginPixels: 160,
                  purpose: "Inspect the blind observer's source symbol",
                }),
              ]);
            case 5:
              return turn([correspondence(["inspection-1", "inspection-2"])]);
            case 6:
              expect(input.results[0]?.data).toMatchObject({
                state: {
                  counts: { proposedRows: 1, unresolved: 0 },
                  rows: [{ status: "linked", samId: "sam-7", blindId: "blind-0" }],
                },
              });

              return turn([correspondence(["inspection-1", "inspection-2"])]);
            default:
              expect(input.results[0]?.data).toEqual({
                error: "A proposal already has a recorded correspondence.",
              });

              return turn([
                action("finish_review", {
                  summary: "One source-linked proposal remains pending reviewer verification.",
                }),
              ]);
          }
        }),
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, { segment: () => Effect.succeed(maskResponse()) }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.review).toBe("pending");
    expect(result.counts).toMatchObject({
      proposedRows: 1,
      unresolved: 0,
      corrections: 0,
      samCalls: 1,
    });
    expect(result.rows[0]?.box).toEqual({ left: 211, top: 228, right: 271, bottom: 255 });
    expect(result.rows[0]?.assertions.map((assertion) => assertion.method)).toEqual([
      "sam-classification",
      "blind-inventory",
    ]);
    expect(result.comparison.leftOnly).toEqual([]);
    expect(result.comparison.rightOnly).toEqual([]);
    expect(result.comparison.correspondences).toEqual([
      {
        samId: "sam-7",
        blindId: "blind-0",
        inspectionIds: ["inspection-1", "inspection-2"],
        rationale: "Both source inspections identify the same physical receptacle.",
      },
    ]);

    const originalSurvey = Schema.decodeUnknownSync(
      Schema.Struct({
        state: Schema.Struct({
          comparison: Schema.Struct({ correspondences: Schema.Array(Schema.JsonObject) }),
        }),
      }),
    )(result.trace[0]?.result);

    expect(originalSurvey.state.comparison.correspondences).toEqual([]);
    expect(await Bun.file(join(options.output, "report.html")).text()).toContain(
      "reviewer verification remains pending",
    );
  },
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "an explicit correspondence removes its vertices before matching the residual overlapping inventories",
  async () => {
    const options = { ...(await prepare()), maximumTurns: 4 };
    let reasoningTurns = 0;

    const model = reviewer({
      inventory: (_image, inspect) =>
        Effect.succeed({
          objects: inspect
            ? [device({ left: 100, top: 100, right: 300, bottom: 300 })]
            : [
                device({ left: 0, top: 90, right: 187, bottom: 170 }),
                device({ left: 188, top: 90, right: 375, bottom: 170 }),
              ],
        }),
      classify: (_image, proposals) =>
        Effect.succeed({
          decisions: proposals.map((proposal) => ({
            id: proposal.id,
            kind: "receptacle" as const,
            labels,
            rationale: "Synthetic source symbol",
          })),
        }),
      turn: (input) =>
        Effect.sync(() => {
          reasoningTurns++;

          if (reasoningTurns === 1) return turn(baselines);

          if (reasoningTurns === 2) {
            expect(input.results.at(-1)?.data).toMatchObject({
              state: {
                counts: { proposedRows: 4, unresolved: 4 },
                comparison: { matches: [] },
              },
            });

            return turn([
              action("inspect_region", {
                targetId: "sam-7",
                marginPixels: 24,
                purpose: "Inspect the overlapping SAM observation A",
              }),
              action("inspect_region", {
                targetId: "blind-1",
                marginPixels: 24,
                purpose: "Inspect the independent observation Y",
              }),
            ]);
          }

          if (reasoningTurns === 3) {
            return turn([
              action("record_correspondence", {
                samId: "sam-7",
                blindId: "blind-1",
                inspectionIds: ["inspection-1", "inspection-2"],
                rationale: "Source inspections identify A and Y as the same symbol.",
              }),
            ]);
          }

          expect(input.results[0]?.data).toMatchObject({
            state: { counts: { proposedRows: 2, unresolved: 0 } },
          });

          return turn([
            action("finish_review", {
              summary: "Explicit A-Y resolves the remaining B-X geometry.",
            }),
          ]);
        }),
    });

    // Compatibility is A-X, A-Y, B-X: no mutually unique pair exists initially.
    const text = [
      `<0f>7<|box;x1=30;y1=30;x2=89;y2=56;w=320;h=334|>${conformanceMask}`,
      `8<|box;x1=0;y1=30;x2=59;y2=56;w=320;h=334|>${conformanceMask}`,
    ].join(",");

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, {
          segment: () =>
            Effect.succeed({
              status: 200,
              body: JSON.stringify({
                id: "overlapping-observations",
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text }] }],
              }),
            }),
        }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.review).toBe("pending");
    expect(result.counts).toMatchObject({ proposedRows: 2, unresolved: 0, samCalls: 1 });
    expect(
      result.comparison.matches.map((match) => `${match.leftId}:${match.rightId}`).sort(),
    ).toEqual(["sam-7:blind-1", "sam-8:blind-0"]);
    expect(result.comparison.correspondences).toHaveLength(1);
    expect(result.comparison.correspondences[0]?.inspectionIds).toEqual([
      "inspection-1",
      "inspection-2",
    ]);
    expect(result.comparison.ambiguous).toEqual([]);
    expect(result.comparison.leftOnly).toEqual([]);
    expect(result.comparison.rightOnly).toEqual([]);
    expect(result.rows.find((row) => row.samId === "sam-7")).toMatchObject({
      status: "linked",
      box: { left: 30, top: 30, right: 90, bottom: 57 },
    });
    expect(result.rows.find((row) => row.samId === "sam-8")).toMatchObject({
      status: "agreed",
      box: { left: 0, top: 30, right: 60, bottom: 57 },
    });
  },
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "blind geometry corrections retain original source labels when the zoom labels are unknown",
  async () => {
    const options = { ...(await prepare()), maximumTurns: 4 };

    const model = reviewer({
      inventory: (_image, inspect) =>
        Effect.succeed({
          objects: [
            inspect
              ? device(
                  { left: 746, top: 794, right: 917, bottom: 872 },
                  { positive: { x: 830, y: 830 }, negative: null },
                )
              : {
                  ...device({ left: 312, top: 374, right: 407, bottom: 415 }),
                  labels: {
                    ...labels,
                    panel: {
                      value: "NP-A",
                      quote: "NP-A",
                      box: { left: 10, top: 10, right: 50, bottom: 30 },
                    },
                  },
                },
          ],
        }),
      classify: () =>
        Effect.succeed({
          decisions: [
            { id: "sam-7", kind: "receptacle", labels, rationale: "Visible source symbol" },
          ],
        }),
      turn: (input) =>
        Effect.sync(() => {
          if (!input.continuation) return turn(baselines);
          const previous = input.results[0];

          if (previous?.actionId === "survey_room") {
            return turn([
              action("inspect_region", {
                targetId: "blind-0",
                marginPixels: 160,
                purpose: "Correct blind geometry with a fresh source inspection",
              }),
            ]);
          }

          if (previous?.actionId === "inspect_region") {
            return turn([
              action("segment_candidate", {
                targetId: "blind-0",
                inspectionId: "inspection-1",
                objectIndex: 0,
                mode: "points",
              }),
            ]);
          }

          return turn([
            action("finish_review", {
              summary: "Corrected location retains both source observations.",
            }),
          ]);
        }),
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, {
          segment: (prompt, image) =>
            prompt === "circle"
              ? Effect.succeed(maskResponse())
              : pngSize(image).pipe(
                  Effect.map((size) => {
                    expect(size).toEqual({ width: 700, height: 700 });

                    return maskResponse(size.width, size.height, 522, 556, 2);
                  }),
                  Effect.orDie,
                ),
        }),
      ),
    );

    expect(result.status).toBe("finished");
    expect(result.review).toBe("pending");
    expect(result.counts).toMatchObject({ proposedRows: 1, unresolved: 0, corrections: 1 });
    expect(result.rows[0]?.status).toBe("revised");
    expect(result.rows[0]?.assertions.find((a) => a.method === "blind-inventory")).toMatchObject({
      imageId: "base",
      labels: { panel: { value: "NP-A", quote: "NP-A" } },
    });
    expect(result.rows[0]?.assertions.find((a) => a.method === "zoom-observation")).toMatchObject({
      imageId: "inspection-1",
      labels: { panel: { value: null } },
    });
    expect(await Bun.file(join(options.output, "report.html")).text()).toContain("NP-A");
  },
);

test.skipIf(Bun.which("pdftoppm") === null).each([false, true])(
  "bounded malformed calls and transportFailure=%s preserve partial unresolved evidence",
  async (transportFailure) => {
    const options = { ...(await prepare()), maximumTurns: 2 };
    let turns = 0;

    const model = reviewer({
      inventory: () =>
        Effect.succeed({ objects: [device({ left: 660, top: 684, right: 846, bottom: 763 })] }),
      turn: () => {
        turns++;

        if (turns === 1)
          return Effect.succeed(turn([action("survey_room", { method: "blind-muse" })]));

        return transportFailure
          ? Effect.fail(new MetaReviewError({ message: "Synthetic provider unavailable" }))
          : Effect.succeed(
              turn([{ id: "malformed", name: "inspect_region", arguments: "{broken" }]),
            );
      },
    });

    const result = await Effect.runPromise(
      runAdaptiveReview(options).pipe(
        Effect.provideService(MetaReviewClient, model),
        Effect.provideService(SamClient, {
          segment: () => Effect.die("No SAM operation requested"),
        }),
      ),
    );

    expect(turns).toBe(2);
    expect(result.status).toBe(transportFailure ? "failed" : "budget-exhausted");
    expect(result.counts).toMatchObject({
      samRaw: null,
      blindProposals: 1,
      proposedRows: 1,
      unresolved: 1,
      samCalls: 0,
    });
    expect(result.rows[0]?.status).toBe("unresolved");
    expect(await Bun.file(join(options.output, "result.json")).text()).toContain('"unresolved": 1');
    expect(await Bun.file(join(options.output, "report.html")).text()).toContain(
      "pending reviewer verification",
    );

    if (transportFailure) {
      expect(result.summary).toBe("Synthetic provider unavailable");
    } else {
      expect(result.trace.at(-1)?.result).toEqual({ error: "Invalid inspection arguments." });
    }
  },
);
