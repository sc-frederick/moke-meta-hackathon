import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../backend/segmentation/fixtures.ts";
import {
  FixtureSchedule,
  InventoryFixture,
  reconcileFixtures,
} from "../backend/segmentation/reconciliation.ts";

const schedule = Schema.decodeUnknownSync(FixtureSchedule)({
  rows: [
    { mark: "WC", description: "Water closet", quantity: 2 },
    { mark: "LAV", description: "Lavatory", quantity: 2 },
    { mark: "BS", description: "Basin sink", quantity: 8 },
  ],
});

const fixture = Schema.decodeUnknownSync(InventoryFixture)({
  id: "wc-1",
  mark: "WC",
  room: "Staff restroom",
  scope: "existing",
  crop: "staff-room",
  pdf: "sample.pdf",
  page: 2,
  evidence: "available",
  proposal: { left: 10, top: 20, right: 40, bottom: 60 },
});

test("fixture reconciliation joins independently read quantities and preserves untested rows", async () => {
  const rows = await Effect.runPromise(
    reconcileFixtures(schedule, [fixture, { ...fixture, id: "wc-2" }], ["WC", "LAV"]),
  );

  expect(rows.find((row) => row.mark === "WC")).toMatchObject({
    scheduled: 2,
    proposed: 2,
    delta: 0,
    status: "counts-agree",
  });
  expect(rows.find((row) => row.mark === "LAV")).toMatchObject({
    proposed: 0,
    delta: -2,
    status: "counts-differ",
  });
  expect(rows.find((row) => row.mark === "BS")).toMatchObject({
    scheduled: 8,
    proposed: null,
    delta: null,
    status: "not-tested",
  });
});

test("missing masks and missing schedule rows remain needs-input rather than agreeing", async () => {
  const rows = await Effect.runPromise(
    reconcileFixtures(schedule, [{ ...fixture, evidence: "failed" }], ["WC", "SS"]),
  );

  expect(rows.find((row) => row.mark === "WC")).toMatchObject({
    proposed: 0,
    unresolved: 1,
    status: "needs-input",
  });
  expect(rows.find((row) => row.mark === "SS")).toMatchObject({
    scheduled: null,
    proposed: 0,
    status: "needs-input",
  });
});

test("duplicate inventory IDs, duplicate schedule marks, and undeclared coverage fail visibly", async () => {
  for (const operation of [
    reconcileFixtures(schedule, [fixture, fixture], ["WC"]),
    reconcileFixtures({ rows: [schedule.rows[0], schedule.rows[0]] }, [fixture], ["WC"]),
    reconcileFixtures(schedule, [fixture], ["LAV"]),
  ]) {
    expect(Result.isFailure(await Effect.runPromise(Effect.result(operation)))).toBe(true);
  }
});

test("real offline CLI preserves candidate provenance and rejects changed image evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-inventory-cli-"));

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=",
    "base64",
  );

  const input = join(directory, "inputs", "tiny.png");
  const schedulePath = join(directory, "schedule.json");
  const candidates = join(directory, "candidates.json");
  const output = join(directory, "report.html");
  const proposal = { left: 0, top: 0, right: 1, bottom: 1 };

  const source = {
    id: "tiny",
    file: "inputs/tiny.png",
    pdf: "synthetic.pdf",
    page: 1,
    sheet: "TEST",
    pdf_rect_points: [0, 0, 1, 1],
    dpi: 72,
    width_px: 1,
    height_px: 1,
    pixel_to_pdf: { scale: 1, offset_points: [0, 0] },
    purpose: "Offline conformance fixture",
    sha256: sha256(png),
  };

  try {
    await Bun.write(input, png);
    await Bun.write(
      schedulePath,
      JSON.stringify({ rows: [{ mark: "WC", description: "Water closet", quantity: 1 }] }),
    );
    await Bun.write(
      candidates,
      JSON.stringify({
        fixtures: [{ kind: "WC", crop: "tiny", room: "Test", scope: "unclear", ...proposal }],
      }),
    );

    const recorded = {
      test: {
        id: "tiny-wc",
        crop: "tiny",
        purpose: "Fixture",
        prompt: { kind: "box", box: proposal },
      },
      crop: source,
      inputSha256: sha256(png),
      status: "succeeded",
    };

    await Bun.write(join(directory, "summary.json"), JSON.stringify({ results: [recorded] }));
    // Deterministic 1×1 foreground mask encoded by the installed Meta parser's conformance encoder.
    const text = "<0f>1<|box;x1=0;y1=0;x2=0;y2=0;w=1;h=1|><|mask;x=0;y=0;data=1,1,!!!!!&O.lVP|>";
    await Bun.write(
      join(directory, "tiny-wc", "response.json"),
      JSON.stringify({
        id: "conformance",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      }),
    );

    const command = [
      "bun",
      "scripts/reconcile-fixtures.ts",
      "--schedule",
      schedulePath,
      "--candidates",
      candidates,
      "--run",
      directory,
      "--schedule-image",
      input,
      "--output",
    ];

    const child = Bun.spawn([...command, output], { stdout: "pipe", stderr: "pipe" });

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("WC: schedule 1, scoped proposals 1, counts-agree");
    const html = await Bun.file(output).text();
    expect(html).toContain("data-boxes-src=");
    expect(html).toContain("Export review decisions");
    expect(await Bun.file(`${output}.json`).text()).toContain('"proposal":');

    await Bun.write(
      join(directory, "summary.json"),
      JSON.stringify({ results: [{ ...recorded, status: "failed" }] }),
    );
    const unavailable = join(directory, "unavailable.html");
    const missing = Bun.spawn([...command, unavailable], { stdout: "pipe", stderr: "pipe" });
    expect(await missing.exited).toBe(0);
    expect(await Bun.file(unavailable).text()).toContain(
      "no usable SAM mask; original proposals only",
    );
    await Bun.write(join(directory, "summary.json"), JSON.stringify({ results: [recorded] }));

    await Bun.write(input, Buffer.concat([png, Buffer.from("changed")]));
    const failedOutput = join(directory, "changed.html");
    const changed = Bun.spawn([...command, failedOutput], { stdout: "pipe", stderr: "pipe" });

    const [failedCode, error] = await Promise.all([
      changed.exited,
      new Response(changed.stderr).text(),
    ]);

    expect(failedCode).toBe(1);
    expect(error).toContain("Input image hash differs");
    expect(await Bun.file(failedOutput).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
