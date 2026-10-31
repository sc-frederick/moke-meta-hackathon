import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializePacketCoverage,
  packetCoverageProgress,
  samePacketSheetSource,
} from "#lib/review/packet-coverage.ts";
import { PacketCoverage, PacketScope, PacketSheet } from "#lib/review/packet.ts";
import { reviewDisciplines } from "#lib/review/execution.ts";
import {
  coverageGateText,
  decodeRequest,
  open,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

const sheet = Schema.decodeUnknownSync(PacketSheet)({
  id: "90000000-0000-4000-8000-000000000001",
  revisionId: "90000000-0000-4000-8000-000000000002",
  label: "E-101",
  pageIndex: 0,
  box: { x: 0, y: 0, width: 612, height: 792 },
  sha256: "a".repeat(64),
  documentName: "Drawing packet.pdf",
});

const whole = PacketScope.cases.WholeSet.make({});
const electrical = PacketScope.cases.Discipline.make({ discipline: "electrical" });
const general = PacketScope.cases.Discipline.make({ discipline: "general" });
const rows = (scope: typeof PacketScope.Type) => initializePacketCoverage(scope, [sheet]);

const checked = (coverage: ReadonlyArray<typeof PacketCoverage.Type>) =>
  coverage.map((row) => ({ ...row, status: "checked" as const }));

test("whole-set coverage cannot borrow a General-only ledger", () => {
  const generalRows = checked(rows(general));
  const progress = packetCoverageProgress({ scope: whole, sheets: [sheet], coverage: generalRows });
  expect(reviewDisciplines).toHaveLength(11);
  expect(progress.total).toBe(44);
  expect(progress.recorded).toBe(4);
  expect(progress.settled).toBe(4);
  expect(progress.gaps).toHaveLength(40);
  expect(
    progress.gaps.every((gap) => gap.reason === "missing" && gap.discipline !== "general"),
  ).toBe(true);
  expect(progress.complete).toBe(false);
  expect(progress.ledger).toHaveLength(44);
});

test("all required disciplines settle only when exclusions have reasons", () => {
  const coverage = rows(whole).map((row) =>
    row.discipline === "electrical"
      ? { ...row, status: "checked" as const, note: "Read the supplied electrical source." }
      : {
          ...row,
          status: "not_applicable" as const,
          note: "No work for this discipline appears on the supplied electrical-only sheet.",
        },
  );

  const progress = packetCoverageProgress({ scope: whole, sheets: [sheet], coverage });
  expect(progress.total).toBe(44);
  expect(progress.recorded).toBe(44);
  expect(progress.settled).toBe(44);
  expect(progress.gaps).toEqual([]);
  expect(progress.complete).toBe(true);
  const noReason = coverage.map((row, index) => (index === 0 ? { ...row, note: "" } : row));
  const incomplete = packetCoverageProgress({ scope: whole, sheets: [sheet], coverage: noReason });
  expect(incomplete.gaps).toHaveLength(1);
  expect(incomplete.gaps[0]?.reason).toBe("needs_reason");
  expect(incomplete.complete).toBe(false);
});

test("unreviewed, needs-input and omitted checks remain visible as scope gaps", () => {
  const coverage = checked(rows(electrical));

  const input = coverage
    .map((row, index) => {
      if (index === 0)
        return { ...row, status: "needs_input" as const, note: "Need the governing edition." };

      if (index === 1) return { ...row, status: "unreviewed" as const };

      return row;
    })
    .slice(0, 3);

  const progress = packetCoverageProgress({ scope: electrical, sheets: [sheet], coverage: input });
  expect(progress.rows).toHaveLength(4);
  expect(progress.gaps.map((gap) => gap.reason).toSorted()).toEqual([
    "missing",
    "needs_input",
    "unreviewed",
  ]);
  expect(progress.recorded).toBe(2);
  expect(progress.settled).toBe(1);
  expect(progress.complete).toBe(false);
});

test("discipline progress evaluates its own rows while preserving other compatible ledger scopes", () => {
  const generalRows = checked(rows(general));
  const electricalRows = checked(rows(electrical));

  const missing = packetCoverageProgress({
    scope: electrical,
    sheets: [sheet],
    coverage: generalRows,
  });

  expect(missing.complete).toBe(false);
  expect(missing.recorded).toBe(0);
  expect(missing.gaps).toHaveLength(4);
  expect(missing.ledger).toHaveLength(8);

  const scoped = packetCoverageProgress({
    scope: electrical,
    sheets: [sheet],
    coverage: [
      ...generalRows.map((row) => ({ ...row, status: "needs_input" as const })),
      ...electricalRows,
    ],
  });

  expect(scoped.complete).toBe(true);
  expect(scoped.total).toBe(4);
  expect(scoped.recorded).toBe(4);
  expect(scoped.ledger).toHaveLength(8);
});

test("overlay preserves compatible findings' coverage and resets changed frozen sources", () => {
  const previousCoverage = checked(rows(general));

  const overlaid = initializePacketCoverage(whole, [sheet], {
    sheets: [sheet],
    coverage: previousCoverage,
  });

  expect(overlaid).toHaveLength(44);
  expect(overlaid.filter((row) => row.status === "checked")).toEqual(previousCoverage);
  expect(overlaid.filter((row) => row.status === "unreviewed")).toHaveLength(40);
  const changed = { ...sheet, sha256: "b".repeat(64) };

  const fresh = initializePacketCoverage(general, [changed], {
    sheets: [sheet],
    coverage: previousCoverage,
  });

  expect(fresh.every((row) => row.status === "unreviewed")).toBe(true);
  expect(previousCoverage.every((row) => row.status === "checked")).toBe(true);
  expect(packetCoverageProgress({ scope: whole, sheets: [], coverage: [] }).complete).toBe(false);
});

test("whole-set coverage also accounts for each supplied sheet", () => {
  const second = Schema.decodeUnknownSync(PacketSheet)({
    ...sheet,
    id: "90000000-0000-4000-8000-000000000003",
    pageIndex: 1,
    label: "E-102",
  });

  const progress = packetCoverageProgress({
    scope: whole,
    sheets: [sheet, second],
    coverage: checked(rows(whole)),
  });

  expect(progress.total).toBe(88);
  expect(progress.gaps).toHaveLength(44);
  expect(progress.gaps.every((gap) => gap.sheetId === second.id)).toBe(true);
  expect(progress.complete).toBe(false);
  expect(samePacketSheetSource(sheet, { ...sheet, label: "Corrected E-101 label" })).toBe(true);
  expect(samePacketSheetSource(sheet, second)).toBe(false);
  expect(
    samePacketSheetSource(sheet, {
      ...sheet,
      box: { x: sheet.box.x, y: sheet.box.y, width: 600, height: sheet.box.height },
    }),
  ).toBe(false);
});

test.each([
  { maxCalls: undefined, rejections: 1 },
  { maxCalls: 6, rejections: 0 },
] as const)(
  "an early finish is returned for unopened sheets once unless the user set a call budget (%j)",
  async ({ maxCalls, rejections }) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-audit3-finish-gate-"));
    let step = 0;
    let history: ReadonlyArray<string> = [];

    const finish = (summary: string) =>
      response([{ name: "finish_review", arguments: { summary, missingInputs: [] } }]);

    const session = await open(
      directory,
      async (_url, init) => {
        history = strings(decodeRequest(init));

        if (step === 0) {
          step++;

          return response([{ name: "inventory_packet", arguments: {} }]);
        }

        // Finish immediately; an unbudgeted review is sent back until the gate gives up.
        if (step <= rejections + 1) {
          step++;

          return finish(step > rejections + 1 ? "Finished with recorded gaps." : "Early finish");
        }

        return response([], "Finished with recorded gaps.");
      },
      true,
      undefined,
      "observe",
    );

    try {
      const request = await session.request(
        "Review the whole set.",
        maxCalls === undefined ? undefined : { maxCalls },
      );

      const started = await session.run(session.packets.start(request));
      const completed = await until(session, started.id, "completed");
      expect(completed.finished).toBe(true);
      expect(completed.summary).toBe("Finished with recorded gaps.");

      const gates = history.filter((text) => text.includes(coverageGateText));
      expect(gates).toHaveLength(rejections);

      if (rejections > 0) {
        expect(gates[0]).toContain("2 of 2 requested sheets were never opened");
        expect(gates[0]).toContain("record_coverage_batch");
        expect(gates[0]).toContain("That next call is accepted");
      }
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
