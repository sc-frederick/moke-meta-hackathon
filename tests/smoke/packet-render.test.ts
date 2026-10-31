import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheetId } from "#lib/review/contracts.ts";
import { PacketReview } from "#lib/review/packet.ts";
import { decodeRequest, open, outputs, response, until } from "../fixtures/packet-review.ts";

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
            // Distinct crops: identical renders share one stored image and one evidence ID.
            function: {
              name: "render_sheet",
              arguments: JSON.stringify({
                sheetId: page,
                region: { x: 20 * index, y: 20, width: 100, height: 100 },
              }),
            },
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
}, 120000);

test("a cropped render tells the reviewer that content can continue past its edge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-audit3-crop-note-"));
  const notes: Array<string | undefined> = [];
  let step = 0;
  let inventory: PacketReview | undefined;

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    switch (step++) {
      case 0:
        return response([{ name: "inventory_packet", arguments: {} }]);
      case 1: {
        inventory = outputs(PacketReview, request).at(-1);
        const sheet = inventory?.sheets[0];

        if (!sheet) throw new Error("Missing source inventory");

        return response([
          {
            name: "render_sheet",
            arguments: {
              sheetId: sheet.id,
              region: { ...sheet.box, width: sheet.box.width / 2, height: sheet.box.height / 2 },
            },
          },
        ]);
      }

      case 2:
        notes.push(
          outputs(Schema.Struct({ cropNote: Schema.optionalKey(Schema.String) }), request).at(-1)
            ?.cropNote,
        );

        return response([
          { name: "render_sheet", arguments: { sheetId: inventory?.sheets[0]?.id ?? "" } },
        ]);
      case 3:
        notes.push(
          outputs(Schema.Struct({ cropNote: Schema.optionalKey(Schema.String) }), request).at(-1)
            ?.cropNote,
        );

        return response([], "Crop guidance observed.");
      default:
        return response([], "Crop guidance observed.");
    }
  });

  try {
    const request = await session.request("Review the whole set.", { maxCalls: 6 });
    const started = await session.run(session.packets.start(request));
    await until(session, started.id, "failed");
    expect(notes[0]).toContain("can continue past its edges");
    expect(notes[1]).toBeUndefined();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
