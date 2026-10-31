import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  countPacketCoverage,
  indexPacketCoverage,
  initializePacketCoverage,
  packetCoverageProgress,
} from "#lib/review/packet-coverage.ts";
import { PacketCoverage, PacketScope, PacketSheet } from "#lib/review/packet.ts";

const statuses = PacketCoverage.fields.status.literals;

const sheets = (count: number, revision = "90000000-0000-4000-8000-000000000000") =>
  Array.from({ length: count }, (_, index) =>
    Schema.decodeUnknownSync(PacketSheet)({
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      revisionId: revision,
      label: `E-${101 + index}`,
      pageIndex: index,
      box: { x: 0, y: 0, width: 612, height: 792 },
      sha256: "a".repeat(64),
      documentName: "Drawing packet.pdf",
    }),
  );

// Every status appears, including Not applicable with and without a reason.
const recorded = (rows: ReadonlyArray<typeof PacketCoverage.Type>) =>
  rows.map((row, index) => ({
    ...row,
    status: statuses[index % statuses.length] ?? "unreviewed",
    note: index % 3 === 0 ? "" : `Note ${index}`,
  }));

// The per-sheet rescans the panel used before the index.
const rescanned = (
  packetSheets: ReadonlyArray<typeof PacketSheet.Type>,
  rows: ReadonlyArray<typeof PacketCoverage.Type>,
) =>
  packetSheets.flatMap((sheet) => {
    const sheetRows = rows.filter((row) => row.sheetId === sheet.id);

    return sheetRows.length > 0
      ? [[sheet.id, { rows: sheetRows, counts: countPacketCoverage(sheetRows) }] as const]
      : [];
  });

// The panel reads the index by sheet, in packet order.
const lookup = (
  packetSheets: ReadonlyArray<typeof PacketSheet.Type>,
  index: ReturnType<typeof indexPacketCoverage>,
) =>
  packetSheets.flatMap((sheet) => {
    const entry = index.get(sheet.id);

    return entry ? [[sheet.id, entry] as const] : [];
  });

test("the sheet index keeps each sheet's records and counts across scopes and earlier coverage", () => {
  const packet = sheets(5);
  const whole = PacketScope.cases.WholeSet.make({});
  const electrical = PacketScope.cases.Discipline.make({ discipline: "electrical" });
  const selected = PacketScope.cases.SelectedSheets.make({});

  // An earlier electrical review leaves compatible records that a whole-set ledger keeps.
  const earlier = recorded(initializePacketCoverage(electrical, packet));

  for (const [scope, coverage] of [
    [whole, recorded(initializePacketCoverage(whole, packet))],
    [electrical, earlier],
    [selected, recorded(initializePacketCoverage(selected, packet.slice(1, 3)))],
    [whole, initializePacketCoverage(whole, packet, { sheets: packet, coverage: earlier })],
    // Two sheets have no records yet.
    [whole, recorded(initializePacketCoverage(whole, packet.slice(0, 3)))],
  ] as const) {
    const progress = packetCoverageProgress({ scope, sheets: packet, coverage });

    for (const rows of [progress.rows, progress.ledger]) {
      expect(lookup(packet, indexPacketCoverage(rows))).toEqual(rescanned(packet, rows));
      expect(
        [...indexPacketCoverage(rows).values()].reduce((sum, entry) => sum + entry.counts.total, 0),
      ).toBe(rows.length);
    }
  }
});

test("counts cover every status and Not applicable without a reason", () => {
  const packet = sheets(1);

  const rows = recorded(
    initializePacketCoverage(PacketScope.cases.WholeSet.make({}), packet),
  ).slice(0, 7);

  expect(countPacketCoverage(rows)).toEqual({
    total: 7,
    unreviewed: 2,
    checked: 2,
    issues: 1,
    notApplicable: 1,
    needsInput: 1,
  });
});

test("a large packet groups in one pass instead of rescanning the ledger for every sheet", () => {
  const packet = sheets(400);

  const rows = packetCoverageProgress({
    scope: PacketScope.cases.WholeSet.make({}),
    sheets: packet,
    coverage: recorded(initializePacketCoverage(PacketScope.cases.WholeSet.make({}), packet)),
  }).rows;

  const fastest = (work: () => void) =>
    Math.min(
      ...Array.from({ length: 3 }, () => {
        const started = performance.now();
        work();

        return performance.now() - started;
      }),
    );

  expect(rows).toHaveLength(400 * 11 * 4);
  expect(lookup(packet, indexPacketCoverage(rows))).toEqual(rescanned(packet, rows));
  const indexed = fastest(() => indexPacketCoverage(rows));
  const rescans = fastest(() => rescanned(packet, rows));
  console.log(
    `Coverage grouping for 400 sheets: one pass ${indexed.toFixed(1)} ms, per-sheet rescans ${rescans.toFixed(1)} ms`,
  );
  expect(indexed * 5).toBeLessThan(rescans);
});
