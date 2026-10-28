import { afterEach, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrawingCrop, fixturePath, readCrops } from "../backend/segmentation/fixtures.ts";
import { casePrompt, readSegmentation, SegmentationCase } from "../backend/segmentation/sam.ts";

const crop = Schema.decodeUnknownSync(DrawingCrop)({
  id: "synthetic-crop",
  file: "reference.png",
  pdf: "drawing.pdf",
  page: 1,
  sheet: "TEST",
  pdf_rect_points: [12, 24, 88.8, 104.16],
  dpi: 300,
  width_px: 320,
  height_px: 334,
  pixel_to_pdf: { scale: 0.24, offset_points: [12, 24] },
  purpose: "Contract fixture",
  sha256: "0".repeat(64),
});

// Complete protocol example from Meta's parser README, not a mocked module.
const output =
  "<0f>7<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.9|>" +
  "<|mask;x=0;y=0;c=0.9;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function response(text: string, status = "completed") {
  return {
    status: 200,
    body: JSON.stringify({
      id: "contract-response",
      status,
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    }),
  };
}

test("SAM parser decodes a mask and maps inclusive wire edges to PDF points", async () => {
  const result = await Effect.runPromise(readSegmentation(response(output), crop));
  const [object] = result.objects;

  expect(object?.id).toBe("7");
  expect(object?.pixels).toEqual({ left: 211, top: 228, right: 271, bottom: 255 });
  expect(object?.pdfPoints.left).toBeCloseTo(62.64);
  expect(object?.pdfPoints.top).toBeCloseTo(78.72);
  expect(object?.pdfPoints.right).toBeCloseTo(77.04);
  expect(object?.pdfPoints.bottom).toBeCloseTo(85.2);
  expect(object?.mask.path.length).toBeGreaterThan(0);
});

test("completed empty output is a valid zero-match result", async () => {
  const result = await Effect.runPromise(readSegmentation(response(""), crop));
  expect(result.objects).toEqual([]);
});

test("valid reordered box fields and harmless parser warnings preserve geometry", async () => {
  const result = await Effect.runPromise(
    readSegmentation(response(output.replace("w=320;h=334", "h=334;future=1;w=320")), crop),
  );

  expect(result.objects[0]?.pdfPoints.left).toBeCloseTo(62.64);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.severity).toBe("warning");
  expect(result.diagnostics[0]?.code).toBe("ignored_field");
});

test.each([
  ["incomplete response", response(output, "incomplete")],
  ["invalid text", response("no objects found")],
  ["malformed geometry", response("<0f>7<|box;x1=2|>")],
  ["changed source dimensions", response(output.replace("w=320", "w=640"))],
  ["reordered source dimensions", response(output.replace("w=320;h=334", "h=668;w=640"))],
  ["separated source dimensions", response(output.replace("w=320;h=334", "w=640;future=1;h=668"))],
  [
    "truncated mask",
    response(output.replace("!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(", "!")),
  ],
  ["HTTP access failure", { status: 403, body: "private provider details" }],
  [
    "missing output lane",
    { status: 200, body: JSON.stringify({ id: "missing", status: "completed", output: [] }) },
  ],
])("rejects %s without accepting partial evidence", async (_name, raw) => {
  const result = await Effect.runPromise(Effect.result(readSegmentation(raw, crop)));
  expect(Result.isFailure(result)).toBe(true);
});

test("box and negative-point prompts use actual image pixels and half-open box input", async () => {
  const box = Schema.decodeUnknownSync(SegmentationCase)({
    id: "box",
    crop: crop.id,
    purpose: "Box",
    prompt: { kind: "box", box: { left: 10, top: 20, right: 40, bottom: 60 } },
  });

  const points = Schema.decodeUnknownSync(SegmentationCase)({
    id: "points",
    crop: crop.id,
    purpose: "Points",
    prompt: {
      kind: "points",
      points: [
        { x: 20, y: 40, label: "positive" },
        { x: 30, y: 50, label: "negative" },
      ],
    },
  });

  expect(await Effect.runPromise(casePrompt(box, crop))).toBe(
    "<0f>1<|box;x1=10;y1=20;x2=39;y2=59;w=320;h=334|>",
  );
  expect(await Effect.runPromise(casePrompt(points, crop))).toBe(
    "<0f>1<|point;x=20;y=40;w=320;h=334|>-<|point;x=30;y=50;w=320;h=334|>",
  );
  expect(
    Result.isFailure(
      await Effect.runPromise(
        Effect.result(
          casePrompt(
            { ...box, prompt: { kind: "box", box: { left: 0, top: 0, right: 321, bottom: 10 } } },
            crop,
          ),
        ),
      ),
    ),
  ).toBe(true);
});

test("guided refinement combines one box with positive and negative points", async () => {
  const guided = Schema.decodeUnknownSync(SegmentationCase)({
    id: "guided",
    crop: crop.id,
    purpose: "Exclude a neighboring label",
    prompt: {
      kind: "guided",
      box: { left: 10, top: 20, right: 40, bottom: 60 },
      points: [
        { x: 20, y: 40, label: "positive" },
        { x: 30, y: 50, label: "negative" },
      ],
    },
  });

  expect(await Effect.runPromise(casePrompt(guided, crop))).toBe(
    "<0f>1<|box;x1=10;y1=20;x2=39;y2=59;w=320;h=334|><|point;x=20;y=40;w=320;h=334|>-<|point;x=30;y=50;w=320;h=334|>",
  );
});

test("room prompts preserve separate IDs and reject a duplicated object ID", async () => {
  const room = Schema.decodeUnknownSync(SegmentationCase)({
    id: "room",
    crop: crop.id,
    purpose: "Room inventory roster",
    prompt: {
      kind: "objects",
      objects: [
        { id: 3, prompt: { kind: "box", box: { left: 10, top: 20, right: 40, bottom: 60 } } },
        { id: 7, prompt: { kind: "points", points: [{ x: 70, y: 80, label: "positive" }] } },
      ],
    },
  });

  expect(await Effect.runPromise(casePrompt(room, crop))).toBe(
    "<0f>3<|box;x1=10;y1=20;x2=39;y2=59;w=320;h=334|>,7<|point;x=70;y=80;w=320;h=334|>",
  );

  const duplicate = Schema.decodeUnknownSync(SegmentationCase)({
    ...room,
    prompt: {
      kind: "objects",
      objects: [
        { id: 3, prompt: { kind: "points", points: [{ x: 10, y: 20, label: "positive" }] } },
        { id: 3, prompt: { kind: "points", points: [{ x: 70, y: 80, label: "positive" }] } },
      ],
    },
  });

  expect(
    Result.isFailure(await Effect.runPromise(Effect.result(casePrompt(duplicate, crop)))),
  ).toBe(true);
});

test.each([
  "plumbing-cases.json",
  "plumbing-refinement-cases.json",
  "plumbing-robustness-cases.json",
  "plumbing-room-cases.json",
  "plumbing-wc-points-cases.json",
  "plumbing-pipe-case.json",
])("documented recipe %s loads and encodes every prompt without inference", async (filename) => {
  const directory = join(import.meta.dir, "..", "experiments", "sam");

  const crops = await Effect.runPromise(
    readCrops(directory, join(directory, "plumbing-crops.json")),
  );

  const scenarios = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.NonEmptyArray(SegmentationCase)),
  )(await Bun.file(join(directory, filename)).text());

  for (const scenario of scenarios) {
    const source = crops.find((crop) => crop.id === scenario.crop);

    if (!source) throw new Error(`Missing source crop for ${scenario.id}.`);

    expect(await Effect.runPromise(casePrompt(scenario, source))).not.toBe("");
  }
});

test.each([
  "concept-cases.json",
  "expanded-cases.json",
  "holdout-cases.json",
  "guided-cases.json",
  "heldout-guided-cases.json",
  "tile-cases.json",
  "scale-control-cases.json",
  "room-revision-cases.json",
  "correction-cases.json",
  "occlusion-cases.json",
])("symbol study recipe %s loads and encodes without inference", async (filename) => {
  const directory = join(import.meta.dir, "..", "experiments", "sam", "symbols");
  const crops = await Effect.runPromise(readCrops(directory, join(directory, "crops.json")));

  const scenarios = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.NonEmptyArray(SegmentationCase)),
  )(await Bun.file(join(directory, filename)).text());

  for (const scenario of scenarios) {
    const source = crops.find((crop) => crop.id === scenario.crop);

    if (!source) throw new Error(`Missing source crop for ${scenario.id}.`);

    expect(await Effect.runPromise(casePrompt(scenario, source))).not.toBe("");
  }
});

const temporary: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function syntheticPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 24 >>\nstream\n0 0 0 RG 20 20 40 40 re S\nendstream",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const start = pdf.length;

  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;

  return pdf;
}

async function preparePack() {
  const directory = await mkdtemp(join(tmpdir(), "moke-sam-"));
  temporary.push(directory);
  await Bun.write(join(directory, "drawing.pdf"), syntheticPdf());
  await Bun.write(join(directory, "drawing-manifest.json"), JSON.stringify({ crops: [crop] }));
  await Bun.write(
    join(directory, "cases.json"),
    JSON.stringify([
      {
        id: "first",
        crop: crop.id,
        prompt: { kind: "concept", text: "button" },
        purpose: "Contract test",
      },
      {
        id: "second",
        crop: crop.id,
        prompt: { kind: "concept", text: "absent object" },
        purpose: "Empty output",
      },
    ]),
  );

  return directory;
}

const Request = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.Literal("sam-3.1"),
    stream: Schema.Literal(false),
    metadata: Schema.Struct({
      include_confidence: Schema.Literal("true"),
      mask_encoding: Schema.Literal("one_bit"),
    }),
    input: Schema.Tuple([
      Schema.Struct({
        type: Schema.Literal("message"),
        role: Schema.Literal("user"),
        content: Schema.Tuple([
          Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
          Schema.Struct({ type: Schema.Literal("input_image"), image_url: Schema.String }),
        ]),
      }),
    ]),
  }),
);

test.skipIf(Bun.which("pdftoppm") === null)(
  "real CLI renders PDF, calls a local Responses endpoint, and saves inspectable evidence (requires Poppler)",
  async () => {
    const directory = await preparePack();
    const requests: Array<typeof Request.Type> = [];
    const authorization: Array<string | null> = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = Schema.decodeUnknownSync(Request)(await request.text());
        requests.push(input);
        authorization.push(request.headers.get("Authorization"));

        return new Response(response(requests.length === 1 ? output : "").body, {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const child = Bun.spawn(
        [
          "bun",
          "scripts/test-sam.ts",
          "--live",
          "--fixtures",
          directory,
          "--cases",
          join(directory, "cases.json"),
          "--output",
          join(directory, "runs"),
        ],
        {
          env: {
            ...process.env,
            MODEL_API_KEY: "contract-secret",
            META_API_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
            META_SEGMENTATION_MODEL: "sam-3.1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(requests).toHaveLength(2);
      expect(authorization).toEqual(["Bearer contract-secret", "Bearer contract-secret"]);
      expect(requests[0]?.input[0].content[1].image_url).toStartWith("data:image/png;base64,");

      const [run] = await readdir(join(directory, "runs"));
      expect(run).toBeDefined();

      if (!run) return;

      const root = join(directory, "runs", run);
      const report = await Bun.file(join(root, "report.html")).text();
      const result = await Bun.file(join(root, "first", "result.json")).text();
      const metadata = await Bun.file(join(root, "first", "request.json")).text();
      const svg = await Bun.file(join(root, "first", "overlay.svg")).text();

      expect(result).toContain('"status": "succeeded"');
      expect(result).toContain('"review": "pending"');
      expect(metadata).toContain('"pdfSha256":');
      expect(svg).toContain("scale(1 1)");
      expect(report).toContain("0 proposed objects");
      expect([stdout, stderr, report, result, metadata, svg].join("")).not.toContain(
        "contract-secret",
      );
    } finally {
      await server.stop(true);
    }
  },
  15_000,
);

test("manifest rejects an inconsistent coordinate transform and escaping paths", async () => {
  const directory = await preparePack();
  await Bun.write(
    join(directory, "drawing-manifest.json"),
    JSON.stringify({ crops: [{ ...crop, pixel_to_pdf: { scale: 1, offset_points: [12, 24] } }] }),
  );

  expect(Result.isFailure(await Effect.runPromise(Effect.result(readCrops(directory))))).toBe(true);
  expect(
    Result.isFailure(
      await Effect.runPromise(Effect.result(fixturePath(directory, "../private.pdf"))),
    ),
  ).toBe(true);
});

test.skipIf(Bun.which("pdftoppm") === null).each([
  { live: false, expectedRequests: 0, exitCode: 0, outcome: "prepared" },
  { live: true, expectedRequests: 1, exitCode: 1, outcome: "failed" },
])(
  "CLI live=$live preserves safe preparation and stops on access failure (requires Poppler)",
  async ({ live, expectedRequests, exitCode, outcome }) => {
    const directory = await preparePack();
    let requests = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;

        return Response.json({ error: { message: "private failure detail" } }, { status: 403 });
      },
    });

    try {
      const child = Bun.spawn(
        [
          "bun",
          "scripts/test-sam.ts",
          ...(live ? ["--live"] : []),
          "--fixtures",
          directory,
          "--cases",
          join(directory, "cases.json"),
          "--output",
          join(directory, "runs"),
        ],
        {
          env: {
            ...process.env,
            MODEL_API_KEY: live ? "contract-secret" : "",
            META_API_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
            META_SEGMENTATION_MODEL: "sam-3.1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(code).toBe(exitCode);
      expect(requests).toBe(expectedRequests);

      const [run] = await readdir(join(directory, "runs"));
      expect(run).toBeDefined();

      if (!run) return;

      const report = await Bun.file(join(directory, "runs", run, "report.html")).text();
      expect(report).toContain(outcome.toUpperCase());
      expect(report).toContain(live ? "1 of 2 selected cases" : "2 of 2 selected cases");
      expect([stdout, stderr, report].join("")).not.toContain("contract-secret");
      expect([stdout, stderr, report].join("")).not.toContain("private failure detail");
    } finally {
      await server.stop(true);
    }
  },
  15_000,
);
