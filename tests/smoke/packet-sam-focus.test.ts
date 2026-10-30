import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import { claimsDeviceCount } from "../../backend/packet-review/service.ts";
import { Artifact } from "#lib/review/contracts.ts";
import {
  decodeRequest,
  open,
  outputs,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

const gateText = "needs SAM evidence from this review";

const sam = (id: string, text: string) =>
  Response.json({
    id,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });

const instance = (id: number, left: number) =>
  `${id}<|box;x1=${left};y1=10;x2=${left + 40};y2=50;w=320;h=334;c=0.9|><|mask;x=0;y=0;c=0.8;data=1,1,!!!!!&O.lVP|>`;

test("device count wording needs a counted noun, not an identifier number", () => {
  expect(claimsDeviceCount("Plan shows 2 duplex receptacles where the schedule lists 4")).toBe(
    true,
  );
  expect(claimsDeviceCount("Lighting fixture quantities do not match the schedule")).toBe(true);
  expect(claimsDeviceCount("Room 107 receptacles lack GFCI notation")).toBe(false);
  expect(claimsDeviceCount("NEC 210.52 receptacle spacing exceeds 12 ft")).toBe(false);
});

test("a device count needs SAM, and each recorded finding gets a SAM zoom of its problem area", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-sam-focus-"));
  const samInputs: Array<string> = [];
  const modelInputs: Array<string> = [];
  let step = 0;
  let sheetId = "";
  let box = { x: 0, y: 0, width: 1, height: 1 };

  const region = () => ({
    x: box.x + box.width * 0.3,
    y: box.y + box.height * 0.3,
    width: box.width * 0.2,
    height: box.height * 0.2,
  });

  const finding = (artifactId: string) => ({
    title: "Receptacle count in the work area does not match the panel schedule",
    discipline: "electrical",
    severity: "Major",
    status: "Needs input",
    classification: "Drawing conflict",
    locations: [{ sheetId, detail: "Work area receptacles", region: region() }],
    observed: "The plan shows 2 duplex receptacles where the panel schedule lists 4.",
    correction: "Reconcile the receptacle count between the plan and the panel schedule.",
    evidenceIds: [artifactId],
    evidenceNote: "SAM proposed two receptacle symbols; both were checked against the source.",
    citationIds: [],
    calculationIds: [],
    priorCommentId: null,
  });

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    const input = strings(request.input ?? null).join("\n");

    if (request.model === "sam-3.1") {
      samInputs.push(input);

      return samInputs.length === 1
        ? sam("sam-count", `<0f>${instance(0, 10)},${instance(1, 80)}`)
        : sam("sam-focus", `<0f>${instance(0, 10)}`);
    }

    modelInputs.push(input);
    const rendered = outputs(Schema.Struct({ artifact: Artifact }), request).at(0);

    switch (step++) {
      case 0:
        return response([{ name: "render_sheet", arguments: { sheetId } }]);
      case 1:
        if (!rendered) throw new Error("The rendered sheet was not delivered to the model.");

        return response([{ name: "record_finding", arguments: finding(rendered.artifact.id) }]);
      case 2:
        if (!rendered) throw new Error("The rendered sheet was not delivered to the model.");

        return response([
          {
            name: "segment_objects",
            arguments: {
              artifactId: rendered.artifact.id,
              prompt: { kind: "concept", text: "duplex receptacle" },
            },
          },
        ]);
      case 3:
        if (!rendered) throw new Error("The rendered sheet was not delivered to the model.");

        return response([
          { name: "record_finding", arguments: finding(rendered.artifact.id) },
          {
            name: "record_finding",
            arguments: {
              ...finding(rendered.artifact.id),
              title: "Title block omits the permit stage",
              observed: "The title block names the revision but no permit stage.",
              correction: "Show the permit stage in the title block.",
              classification: "Recommendation",
              locations: [{ sheetId, detail: "Whole sheet", region: box }],
            },
          },
        ]);
      case 4:
        return response([
          {
            name: "finish_review",
            arguments: { summary: "Counted receptacles with SAM.", missingInputs: [] },
          },
        ]);
      default:
        return response([], "The receptacle count needs coordination.");
    }
  };

  const session = await open(directory, transport);

  try {
    const sheet = (await session.snapshot()).sheets[0];

    if (!sheet) throw new Error("The fixture PDF has no source sheet.");
    sheetId = sheet.id;
    box = { x: sheet.box.x, y: sheet.box.y, width: sheet.box.width, height: sheet.box.height };

    const started = await session.run(
      session.packets.start(await session.request("Check the receptacle counts on this plan.")),
    );

    const finished = await until(session, started.id, "completed");

    // The first count finding is returned until SAM segments a crop of its sheet.
    expect(modelInputs[2]).toContain(gateText);
    expect(finished.segmentedSheetIds).toEqual([sheet.id]);
    expect(samInputs).toHaveLength(2);
    expect(samInputs[0]).toContain("duplex receptacle");
    expect(samInputs[1]).toContain("<|box;");

    const [counted, wholeSheet] = finished.findings;
    expect(finished.findings).toHaveLength(2);
    expect(wholeSheet?.focus).toBeUndefined();

    const focus = counted?.focus;

    if (!focus) throw new Error("The recorded finding has no SAM zoom.");
    expect(focus).toMatchObject({ sheetId, region: region(), model: "sam-3.1" });
    expect(focus.responseId).toBe("sam-focus");
    expect(focus.segments).toHaveLength(1);
    expect(focus.segments[0]?.bounds).toEqual({ left: 10, top: 10, right: 51, bottom: 51 });
    expect(finished.evidenceIds).toContain(focus.artifactId);
    expect(counted?.evidenceIds).not.toContain(focus.artifactId);

    // The zoom is a padded original-PDF render around the finding region.
    const zoom = (await session.snapshot()).artifacts.find((item) => item.id === focus.artifactId);

    if (!zoom?.region) throw new Error("The SAM zoom artifact is unavailable.");
    expect(zoom.region.x).toBeLessThan(region().x);
    expect(zoom.region.x + zoom.region.width).toBeGreaterThan(region().x + region().width);
    expect(zoom.region.width).toBeLessThan(sheet.box.width);
    expect(focus.box.left).toBeGreaterThan(0);
    expect(focus.box.right).toBeLessThan(focus.width);
    expect(modelInputs[4]).toContain(`"samFocus":{"artifactId":"${focus.artifactId}"`);

    const reportPath = join(directory, "report.html");
    await session.run(session.packets.exportReport(session.projectId, finished.id, reportPath));
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain('<svg class="sam-focus"');
    expect(report).toContain('<image href="data:image/png;base64,');
    expect(report).toContain('<path d="M');
    expect(report).toContain("SAM 3.1 focus of");
    expect(report).toContain(`SAM focus ${focus.artifactId}`);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
