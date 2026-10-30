import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FindingSummaryText } from "#lib/review/finding-summary.ts";
import { PacketCalculation, PacketReview } from "#lib/review/packet.ts";
import { Artifact } from "#lib/review/contracts.ts";
import {
  chatResponse,
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

const short = {
  title: "Service sizing needs pressure data",
  observed: "The 1.25 in. service cannot be sized without measured pressure.",
  correction: "Provide the measured pressure before sizing the 1.25 in. service.",
};

test("summary bounds include exact character and word limits and engineering references", () => {
  expect(Schema.is(FindingSummaryText)({ ...short, title: "x".repeat(80) })).toBe(true);
  expect(Schema.is(FindingSummaryText)({ ...short, observed: `${"x".repeat(319)}.` })).toBe(true);
  expect(Schema.is(FindingSummaryText)({ ...short, correction: `Show ${"x".repeat(314)}.` })).toBe(
    true,
  );
  expect(Schema.is(FindingSummaryText)({ ...short, title: "x ".repeat(11) + "x" })).toBe(true);
  expect(Schema.is(FindingSummaryText)({ ...short, observed: "x ".repeat(44) + "x." })).toBe(true);
  expect(
    Schema.is(FindingSummaryText)({
      ...short,
      observed: "The .75 in. pipe serves AHU-1.2; 8.90 AH and 4.42% appear in NFPA 72 10.6.7.",
    }),
  ).toBe(true);
});

test.each([
  { title: "x".repeat(81) },
  { title: "x ".repeat(12) + "x" },
  { observed: "x".repeat(320) + "." },
  { observed: "x ".repeat(45) + "x." },
  { observed: "The value is unreadable. It needs confirmation." },
  { observed: "The value is unreadable.It needs confirmation." },
  { observed: "The value is unreadable。It needs confirmation。" },
  { observed: "The pipe is 4 in. It needs confirmation." },
  { observed: "The tag says 'Existing.' It needs confirmation." },
  { observed: "The value is unreadable" },
  { observed: "- The value is unreadable." },
  { observed: "The value is\nunreadable." },
  { title: " ", observed: " ", correction: " " },
  { correction: "Show." },
  { correction: "Verify compliance." },
  { correction: "Coordinate as required." },
  { correction: "Revise accordingly." },
  { correction: "Provide the measurement. Then size the pipe." },
])("invalid display text is rejected without modifying the input: %j", (change) => {
  const value = { ...short, ...change };
  const before = JSON.stringify(value);
  expect(Schema.is(FindingSummaryText)(value)).toBe(false);
  expect(JSON.stringify(value)).toBe(before);
});

const full = {
  title:
    "Service sizing assumptions and measured pressure require reviewer input before confirming the existing installation and its intended use",
  observed:
    `${short.observed} The fixture-unit assumptions depend on the selected equipment and existing service conditions. ${"Supporting context remains available for engineering review. ".repeat(10)}`.trim(),
  correction: `${short.correction} Retain the fixture-unit assumptions and confirm the existing connection before selecting a final size.`,
};

const technicalFinding = (findingId: string) => ({
  id: findingId,
  ...full,
  discipline: "general",
  severity: "Minor",
  status: "Needs input",
  classification: "Recommendation",
  locations: [],
  evidenceIds: [],
  evidenceNote: "The technical source context and scope assumptions are retained.",
  citationIds: [],
  calculationIds: [],
  priorCommentId: null,
});

test("summaries bind to their technical revision and correcting one finding leaves other candidates pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-summary-revisions-"));
  const first = id();
  const second = id();
  let step = 0;
  let firstRevision = "";
  let secondRevision = "";
  let updatedRevision = "";

  const Receipt = Schema.Struct({
    id: Schema.String,
    summary: Schema.Struct({ revision: Schema.String }),
  });

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    const receipt = (findingId: string) => {
      const value = outputs(Receipt, request).findLast((entry) => entry.id === findingId);

      if (!value) throw new Error("Expected a saved finding revision");

      return value.summary.revision;
    };

    const finish = {
      name: "finish_review",
      arguments: { summary: "Pressure input is needed.", missingInputs: ["Measured pressure"] },
    };

    switch (step++) {
      case 0:
        return response(
          [first, second].map((findingId) => ({
            name: "record_finding",
            arguments: technicalFinding(findingId),
          })),
        );
      case 1:
        firstRevision = receipt(first);
        secondRevision = receipt(second);

        return response([
          {
            name: "record_finding_summary",
            arguments: { id: first, revision: firstRevision, ...short },
          },
          finish,
        ]);
      case 2:
        expect(strings(request.input ?? null).join(" ")).toContain(
          `Short summaries are pending for ${second}`,
        );

        return response([
          {
            name: "record_finding",
            arguments: {
              ...technicalFinding(first),
              observed: `${full.observed} Additional connection scope was clarified.`,
            },
          },
        ]);
      case 3:
        updatedRevision = receipt(first);
        expect(updatedRevision).not.toBe(firstRevision);

        return response([
          {
            name: "record_finding_summary",
            arguments: { id: first, revision: firstRevision, ...short },
          },
          finish,
        ]);
      case 4:
        expect(strings(request.input ?? null).join(" ")).toContain("The technical finding changed");

        return response([
          {
            name: "record_finding_summary",
            arguments: { id: first, revision: updatedRevision, ...short },
          },
          {
            name: "record_finding_summary",
            arguments: { id: second, revision: secondRevision, ...short },
          },
        ]);
      case 5:
        return response([finish]);
      default:
        return response();
    }
  });

  try {
    const started = await session.run(
      session.packets.start(
        await session.request("Review pressure assumptions.", { maxCalls: 20 }),
      ),
    );

    const completed = await until(session, started.id, "completed");
    expect(completed.findings).toHaveLength(2);
    expect(completed.findings.every((finding) => finding.summary?._tag === "Ready")).toBe(true);
    expect(completed.findings.find((finding) => finding.id === first)?.observed).toContain(
      "Additional connection scope was clarified.",
    );
    expect(completed.findings.find((finding) => finding.id === second)?.observed).toBe(
      full.observed,
    );
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test.each(["muse-spark-1.3", "meta-models/muse-spark-open-1026"] as const)(
  "%s saves full facts before rejecting a summary, accepts a corrected revision and reopens losslessly",
  async (model) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-short-findings-"));
    const findingId = id();
    let step = 0;
    let inventory: PacketReview | undefined;
    let source: Artifact | undefined;
    let revision = "";

    const transport = async (_url: string | URL | Request, init?: RequestInit) => {
      const request = decodeRequest(init);

      const reply = (calls: NonNullable<Parameters<typeof response>[0]> = []) =>
        model === "muse-spark-1.3" ? response(calls) : chatResponse("Summary fixture.", calls);

      switch (step++) {
        case 0: {
          const tools = JSON.stringify(request.tools);
          expect(tools).toContain("record_finding_summary");
          expect(tools).toContain('"maxLength":80');
          expect(tools).toContain('"maxLength":320');

          return reply([{ name: "inventory_packet", arguments: {} }]);
        }

        case 1: {
          inventory = outputs(PacketReview, request).at(-1);
          const sheet = inventory?.sheets[0];

          if (!sheet) throw new Error("Missing source inventory");

          return reply([
            { name: "render_sheet", arguments: { sheetId: sheet.id } },
            {
              name: "calculate",
              arguments: {
                title: "Service diameter",
                expression: "diameter",
                inputs: { diameter: { value: 1.25, unit: "in" } },
                unit: "in",
                explanation: "Retained source value, not an accepted sizing conclusion.",
              },
            },
          ]);
        }

        case 2: {
          source = outputs(Schema.Struct({ artifact: Artifact }), request).at(-1)?.artifact;
          const calculation = outputs(PacketCalculation, request).at(-1);

          if (!source || !source.sheetId || !calculation)
            throw new Error("Missing evidence or calculation");

          return reply([
            {
              name: "record_finding",
              arguments: {
                id: findingId,
                ...full,
                discipline: "plumbing",
                severity: "Major",
                status: "Needs input",
                classification: "Recommendation",
                locations: [
                  {
                    sheetId: source.sheetId,
                    detail: "Service connection",
                    region:
                      source.region === null
                        ? null
                        : {
                            x: source.region.x,
                            y: source.region.y,
                            width: source.region.width,
                            height: source.region.height,
                          },
                  },
                ],
                evidenceIds: [source.id],
                evidenceNote: "Original connection and service assumptions require pressure data.",
                citationIds: [],
                calculationIds: [calculation.id],
                priorCommentId: null,
              },
            },
          ]);
        }

        case 3: {
          const receipt = outputs(
            Schema.Struct({
              id: Schema.String,
              summary: Schema.Struct({ _tag: Schema.Literal("Pending"), revision: Schema.String }),
            }),
            request,
          ).at(-1);

          if (!receipt) throw new Error("Full finding did not return a pending summary revision");
          revision = receipt.summary.revision;
          const saved = await session.run(session.packets.get(session.projectId, reviewId));
          expect(saved.findings[0]?.observed).toBe(full.observed);

          return reply([
            {
              name: "record_finding_summary",
              arguments: {
                id: findingId,
                revision,
                ...short,
                title: "x".repeat(81),
                observed: "First sentence. Second sentence.",
              },
            },
            {
              name: "finish_review",
              arguments: { summary: "Attempted early finish.", missingInputs: [] },
            },
          ]);
        }

        case 4:
          expect(strings(request.input ?? request.messages ?? null).join(" ")).toContain(
            "Short summaries are pending",
          );

          return reply([
            { name: "record_finding_summary", arguments: { id: findingId, revision, ...short } },
          ]);
        case 5:
          return reply([
            {
              name: "finish_review",
              arguments: {
                summary: "Pressure input is needed; complete technical detail is retained.",
                missingInputs: ["Measured service pressure"],
              },
            },
          ]);
        default:
          return reply();
      }
    };

    let session = await open(directory, transport);
    let reviewId = "";

    try {
      const started = await session.run(
        session.packets.start(
          await session.request("Review the service sizing assumptions.", { model, maxCalls: 20 }),
        ),
      );

      reviewId = started.id;
      const finished = await until(session, started.id, "completed");
      const finding = finished.findings[0];
      expect(finished.findings).toHaveLength(1);
      expect(finding).toMatchObject({
        ...full,
        status: "Needs input",
        summary: { revision, ...short },
        evidenceIds: [source?.id],
      });
      expect(finding?.calculationIds).toHaveLength(1);
      const reportPath = join(directory, "report.html");
      await session.run(session.packets.exportReport(session.projectId, started.id, reportPath));
      const html = await readFile(reportPath, "utf8");
      expect(html).toContain(short.observed);
      expect(html).toContain(full.observed);
      expect(html).toContain("Full technical finding");
      await session.dispose();
      session = await open(directory, transport, false);
      expect(
        (await session.run(session.packets.get(session.projectId, started.id))).findings,
      ).toEqual(finished.findings);
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);

test.each(["finding-first", "finish-first"] as const)(
  "ignored invalid summaries never complete or lose the full finding: %s",
  async (order) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-pending-summary-"));
    const findingId = id();
    let step = 0;

    const session = await open(directory, async () => {
      if (step++ !== 0) return response([], "The reviewer stopped without correcting the summary.");

      const finding = {
        name: "record_finding",
        arguments: {
          id: findingId,
          ...full,
          discipline: "general",
          severity: "Minor",
          status: "Needs input",
          classification: "Recommendation",
          locations: [],
          evidenceIds: [],
          evidenceNote: "The full technical context is preserved despite the invalid presentation.",
          citationIds: [],
          calculationIds: [],
          priorCommentId: null,
        },
      };

      const finish = {
        name: "finish_review",
        arguments: { summary: "Attempting to finish.", missingInputs: [] },
      };

      return response(order === "finish-first" ? [finish, finding] : [finding, finish]);
    });

    try {
      const started = await session.run(
        session.packets.start(await session.request("Review source context.", { maxCalls: 10 })),
      );

      const failed = await until(session, started.id, "failed");
      expect(failed.finished).toBe(false);
      expect(failed.error).toContain("short summaries remain pending");
      expect(failed.findings[0]).toMatchObject(full);
      expect(failed.findings[0]?.summary?._tag).toBe("Pending");
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
