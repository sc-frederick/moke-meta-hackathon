import { expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import { createAdmittedModels } from "../../backend/inference/provider.ts";
import type { ProviderFailure } from "#lib/review/execution.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact, SheetId } from "#lib/review/contracts.ts";
import { PacketReview } from "#lib/review/packet.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

test("provider HTTP diagnostics survive cancellation without rewriting active duration or replaying inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit3-provider-"));
  let sends = 0;

  const session = await open(directory, async () => {
    sends++;

    return Response.json(
      { error: { message: "private-provider-body-credential" } },
      { status: 401 },
    );
  });

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review all sheets.")),
    );

    const failed = await until(session, started.id, "uncertain");
    expect(failed.providerFailure).toMatchObject({ category: "http", httpStatus: 401 });
    expect(failed.error).toContain("HTTP 401");
    expect(failed.error).toContain("may have been charged");
    expect(JSON.stringify(failed)).not.toContain("private-provider-body-credential");
    await Bun.sleep(25);

    const cancelled = await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: failed.id,
        expectedVersion: failed.version,
        action: "cancel",
        commandId: id(),
      }),
    );

    expect(cancelled.error).toBe(failed.error);
    expect(cancelled.providerFailure).toEqual(failed.providerFailure);
    expect(cancelled.activeDurationMs).toBe(failed.activeDurationMs);
    expect(cancelled.activeSince).toBeNull();
    expect(sends).toBe(1);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("pause accepts progress advancing since the displayed version and cancellation excludes paused waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit3-pause-"));
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const session = await open(directory, async () => {
    dispatched.resolve();
    await release.promise;

    return response([], "Paused inspection receipt.");
  });

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review all sheets.")),
    );

    await dispatched.promise;

    const paused = await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: started.version,
        action: "pause",
        commandId: id(),
      }),
    );

    expect(paused.state).toBe("paused");
    expect(paused.version).toBeGreaterThan(started.version);
    const duration = paused.activeDurationMs;
    release.resolve();
    await Bun.sleep(25);

    const cancelled = await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: paused.version,
        action: "cancel",
        commandId: id(),
      }),
    );

    expect(cancelled.activeDurationMs).toBe(duration);
    expect(cancelled.activeSince).toBeNull();
  } finally {
    release.resolve();
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test.each([
  "missing",
  "not shown",
  "omitted",
  "does not contain",
  "no battery calculations or NAC voltage-drop tables",
  "no schedules",
  "no matrices",
] as const)(
  "an absence claim (%s) requires source search even as a Needs input recommendation",
  async (wording) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-audit3-absence-"));
    let step = 0;
    let inventory: PacketReview | undefined;
    let artifact: Artifact | undefined;
    let rejection = "";

    const session = await open(directory, async (_url, init) => {
      const request = decodeRequest(init);

      switch (step++) {
        case 0:
          return response([{ name: "inventory_packet", arguments: {} }]);
        case 1:
          inventory = outputs(PacketReview, request).at(-1);

          if (!inventory?.sheets[0]) throw new Error("Missing source inventory");

          return response([
            { name: "render_sheet", arguments: { sheetId: inventory.sheets[0].id } },
          ]);
        case 2:
          artifact = outputs(Schema.Struct({ artifact: Artifact }), request).at(-1)?.artifact;

          if (!inventory?.sheets[0] || !artifact) throw new Error("Missing source image");

          return response([
            {
              name: "record_finding",
              arguments: {
                title: wording.startsWith("no ") ? wording : `Battery calculation ${wording}`,
                discipline: "fire_alarm",
                severity: "Critical",
                status: "Needs input",
                classification: "Recommendation",
                locations: [
                  {
                    sheetId: inventory.sheets[0].id,
                    detail: "Calculation page",
                    region:
                      artifact.region === null
                        ? null
                        : {
                            x: artifact.region.x,
                            y: artifact.region.y,
                            width: artifact.region.width,
                            height: artifact.region.height,
                          },
                  },
                ],
                observed:
                  wording === "does not contain"
                    ? "The packet does not contain a battery calculation."
                    : wording.startsWith("no ")
                      ? `The packet contains ${wording}.`
                      : `The battery calculation is ${wording}.`,
                correction: "Supply battery calculation.",
                evidenceIds: [artifact.id],
                evidenceNote: "",
                citationIds: [],
                calculationIds: [],
                priorCommentId: null,
              },
            },
          ]);
        default:
          rejection = strings(request).join("\n");

          return response(
            [],
            "Source search remains incomplete; no missing calculation claim released.",
          );
      }
    });

    try {
      const started = await session.run(
        session.packets.start(await session.request("Review the fire alarm calculation.")),
      );

      const completed = await until(session, started.id, "failed");
      expect(completed.findings).toHaveLength(0);
      expect(completed.finished).toBe(false);
      expect(completed.error).toContain("without recording a completed source review");
      expect(completed.summary).toContain("Source search remains incomplete");
      expect(rejection).toContain("absenceCheck");
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

test("the SDK request deadline is diagnosed as timeout rather than caller cancellation", async () => {
  let diagnostic: typeof ProviderFailure.Type | undefined;
  let sends = 0;

  const admitted = createAdmittedModels(
    {
      provider: "baseten",
      apiKey: Redacted.make("timeout-fixture"),
      route: "recorded",
      timeoutMs: 10,
      transport: async (_input, init) => {
        sends++;

        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) throw new Error("The SDK request has no cancellation signal");
          const fail = () => reject(signal.reason);

          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
      },
    },
    {
      packetReview: true,
      maxInputTokens: 1048576,
      maxOutputTokens: 1048576,
      begin: async () => null,
      send: async () => undefined,
      complete: async () => undefined,
      end: async (_uncertain, failure) => {
        diagnostic = failure;
      },
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!model) throw new Error("The fixture model was not registered");
  await admitted.telemetry.startSpan(
    {
      name: "pi.durable.phase",
      attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
    },
    (telemetry) =>
      admitted.models.completeSimple(
        model,
        {
          messages: [{ role: "user", content: "Review the fixture.", timestamp: 0 }],
        },
        { telemetry },
      ),
  );
  expect(diagnostic?.category).toBe("timeout");
  expect(diagnostic?.phase).toBe("dispatch");
  expect(sends).toBe(1);
});

test.each([
  ["Too many images: 9 (max 8)", "image_limit"],
  ["Maximum context length exceeded", "context_limit"],
] as const)(
  "provider rejection (%s) retains a safe reason without the raw echoed body",
  async (message, detail) => {
    let diagnostic: typeof ProviderFailure.Type | undefined;

    const admitted = createAdmittedModels(
      {
        provider: "baseten",
        apiKey: Redacted.make("diagnostic-fixture"),
        route: "recorded",
        transport: async () =>
          Response.json(
            { error: { message, code: "400", echoedPrivateInput: "must-not-escape" } },
            { status: 400 },
          ),
      },
      {
        packetReview: true,
        maxInputTokens: 1048576,
        maxOutputTokens: 1048576,
        begin: async () => null,
        send: async () => undefined,
        complete: async () => undefined,
        end: async (_uncertain, failure) => {
          diagnostic = failure;
        },
      },
    );

    const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

    if (!model) throw new Error("Missing diagnostic fixture model");

    const result = await admitted.telemetry.startSpan(
      {
        name: "pi.durable.phase",
        attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
      },
      (telemetry) =>
        admitted.models.completeSimple(
          model,
          { messages: [{ role: "user", content: "Synthetic diagnostic.", timestamp: 0 }] },
          { telemetry },
        ),
    );

    expect(diagnostic?.detail).toBe(detail);
    expect(diagnostic?.httpStatus).toBe(400);
    expect(JSON.stringify({ diagnostic, result })).not.toContain("must-not-escape");
  },
);

test("a Spark Open tool batch retains eight fresh images and rejects the ninth before adding evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit3-image-batch-"));
  let page = Schema.decodeUnknownSync(SheetId)(crypto.randomUUID());
  let step = 0;
  let deliveredImages = 0;
  let rejected = false;

  const session = await open(directory, async (_input, init) => {
    const body = Schema.decodeUnknownSync(Schema.String)(init?.body);

    const tools =
      step++ === 0
        ? Array.from({ length: 9 }, (_, index) => ({
            index,
            id: `image-${index}`,
            type: "function",
            function: { name: "render_sheet", arguments: JSON.stringify({ sheetId: page }) },
          }))
        : [];

    if (!tools.length) {
      deliveredImages = body.split("data:image/png;base64,").length - 1;
      rejected = body.includes("current source batch already contains eight images");
    }

    const delta: typeof Schema.Json.Type = tools.length
      ? { role: "assistant", tool_calls: tools }
      : { role: "assistant", content: "Partial source batch inspected." };

    const events: Array<typeof Schema.Json.Type> = [
      { id: "batch-fixture", choices: [{ index: 0, delta, finish_reason: null }] },
      {
        id: "batch-fixture",
        choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    ];

    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });

  try {
    const sheet = (await session.snapshot()).sheets[0];

    if (!sheet) throw new Error("No batch fixture source");
    page = sheet.id;

    const started = await session.run(
      session.packets.start(
        await session.request("Inspect these source images.", {
          model: "meta-models/muse-spark-open-1026",
        }),
      ),
    );

    const final = await until(session, started.id, "failed");
    expect(deliveredImages).toBe(8);
    expect(rejected).toBe(true);
    expect(final.evidenceIds).toHaveLength(8);
    expect(final.inspectedSheetIds).toEqual([page]);
    expect(final.providerFailure).toBeNull();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
