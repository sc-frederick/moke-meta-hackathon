import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { PacketScope, selectPacketReviewScope } from "#lib/review/packet.ts";
import { id, open, response, until } from "../fixtures/packet-review.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test.each([
  "Review the whole set, especially electrical coordination.",
  "Audit the entire packet and scrutinize structure.",
  "Check all sheets for plumbing issues and broader QA.",
  "Review the entire permit packet, especially electrical coordination.",
  "Audit the full construction document set and scrutinize structure.",
  "Review the whole revised permit drawing packet, including plumbing.",
  "Check all supplied plan sheets for electrical coordination and broader QA.",
])("Auto retains explicit whole-set scope: %s", (request) => {
  expect(selectPacketReviewScope(request, "auto")._tag).toBe("WholeSet");
});

test("explicit reviewer choice and an individual discipline request remain scoped", () => {
  expect(selectPacketReviewScope("Run a quick QA pass", "auto")._tag).toBe("WholeSet");
  expect(selectPacketReviewScope("Perform an electrical review", "auto")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "electrical" }),
  );
  expect(selectPacketReviewScope("Review the whole packet", "structural")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "structural" }),
  );
  expect(selectPacketReviewScope("Review the whole packet", "general")).toEqual(
    PacketScope.cases.Discipline.make({ discipline: "general" }),
  );
});

// These exercise real SQLite, Pi journals, public operations and provider admission; no model is called.
test("sheet assignments persist without confirming count coverage and explicit scopes freeze only selected revision sheets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-scope-audit-"));
  const api = await open(directory, async () => response([], "Scoped fixture completed."));

  try {
    let state = await api.snapshot();
    const first = state.sheets[0];
    const second = state.sheets[1];

    if (!first || !second) throw new Error("Missing drawing fixture");
    await api.command(
      ReviewCommand.cases.AssignSheetDiscipline.make({
        commandId: id(),
        projectId: api.projectId,
        expectedVersion: state.project?.version ?? -1,
        sheetIds: [first.id],
        discipline: "electrical",
      }),
    );
    state = await api.snapshot();
    await api.command(
      ReviewCommand.cases.AssignSheetDiscipline.make({
        commandId: id(),
        projectId: api.projectId,
        expectedVersion: state.project?.version ?? -1,
        sheetIds: [second.id],
        discipline: "fire_alarm",
      }),
    );
    state = await api.snapshot();
    expect(state.sheets.map((sheet) => sheet.discipline)).toEqual(["electrical", "fire_alarm"]);
    expect(state.sheets.every((sheet) => !sheet.confirmed && sheet.coverage === "unreviewed")).toBe(
      true,
    );

    const selected = await api.run(
      api.packets.start(
        await api.request("Review these selected sheets", {
          selection: {
            mode: "selected_sheets",
            revisionId: first.revisionId,
            sheetIds: [second.id],
          },
        }),
      ),
    );

    const complete = await until(api, selected.id, "failed");
    expect(complete.scope._tag).toBe("SelectedSheets");
    expect(complete.sheets.map((sheet) => sheet.id)).toEqual([second.id]);

    const discipline = await api.run(
      api.packets.start(
        await api.request("Review the whole drawing set, especially electrical", {
          discipline: "electrical",
          selection: { mode: "discipline", revisionId: first.revisionId, sheetIds: [] },
        }),
      ),
    );

    const done = await until(api, discipline.id, "failed");
    expect(done.scope).toEqual(PacketScope.cases.Discipline.make({ discipline: "electrical" }));
    expect(done.sheets.map((sheet) => [sheet.id, sheet.discipline])).toEqual([
      [first.id, "electrical"],
    ]);

    const invalid = await api.run(
      Effect.exit(
        api.packets.start(
          await api.request("Review sprinkler", {
            discipline: "fire_sprinkler",
            selection: { mode: "discipline", revisionId: first.revisionId, sheetIds: [] },
          }),
        ),
      ),
    );

    expect(String(invalid)).toContain("No sheets match");
    state = await api.snapshot();
    const revised = join(directory, "Revised.pdf");
    await writeFile(revised, createHeroPdf("B"));
    await api.importPdf({
      commandId: id(),
      projectId: api.projectId,
      expectedVersion: state.project?.version ?? -1,
      source: revised,
      name: "Rev 1",
    });
    state = await api.snapshot();
    const latestRevision = state.revisions.at(-1);

    if (!latestRevision) throw new Error("Missing imported revision");

    const whole = await api.run(
      api.packets.start(
        await api.request("Review electrical", {
          discipline: "electrical",
          selection: { mode: "whole_set", revisionId: latestRevision.id, sheetIds: [] },
        }),
      ),
    );

    const wholeDone = await until(api, whole.id, "failed");
    expect(wholeDone.scope._tag).toBe("WholeSet");
    expect(wholeDone.sheets).toHaveLength(2);
    expect(wholeDone.sheets.every((sheet) => sheet.revisionId === latestRevision.id)).toBe(true);

    const mixed = await api.run(
      Effect.exit(
        api.packets.start(
          await api.request("Review selected", {
            selection: {
              mode: "selected_sheets",
              revisionId: latestRevision.id,
              sheetIds: [first.id],
            },
          }),
        ),
      ),
    );

    expect(String(mixed)).toContain("Selected sheets must belong");

    const links = await api.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT old_sheet_id FROM review_sheet_links WHERE project_id=${api.projectId}`;
      }),
    );

    expect(links).toHaveLength(0);
    await api.dispose();

    const reopened = await open(
      directory,
      async () => {
        throw new Error("Reopen must not dispatch");
      },
      false,
    );

    try {
      expect(
        (await reopened.snapshot()).sheets
          .filter((sheet) => sheet.revisionId === first.revisionId)
          .map((sheet) => sheet.discipline),
      ).toEqual(["electrical", "fire_alarm"]);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
