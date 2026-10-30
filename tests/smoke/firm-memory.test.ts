import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import {
  jurisdictionHistory,
  jurisdictionMatch,
  jurisdictionPlace,
} from "../../backend/packet-review/jurisdiction.ts";
import { renderPacketReport } from "../../backend/packet-review/report.ts";
import { ReviewCommand } from "#lib/review/contracts.ts";
import { PacketReview, StartPacketReview } from "#lib/review/packet.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  type Request,
  response,
  systemPrompt,
  until,
  type Session,
} from "../fixtures/packet-review.ts";

type Step = (request: typeof Request.Type) => Response;

/** Scripted reviewer: each model request takes the next step, then replies with plain text. */
function scripted() {
  const requests: Array<typeof Request.Type> = [];
  const steps: Array<Step> = [];

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    requests.push(request);

    return steps.shift()?.(request) ?? response([], "Review recorded.");
  };

  return { requests, steps, transport };
}

const finish = () =>
  response([
    {
      name: "finish_review",
      arguments: { summary: "Recorded the scripted checks.", missingInputs: [] },
    },
  ]);

/** Start a review in a new conversation, as a reviewer opening a second thread would. */
async function startInNewConversation(session: Session, text: string) {
  const before = await session.snapshot();

  await session.command(
    ReviewCommand.cases.CreateConversation.make({
      commandId: id(),
      projectId: session.projectId,
      expectedVersion: before.project?.version ?? -1,
      title: "Second review",
    }),
  );

  const created = await session.snapshot();
  const conversation = created.conversations.at(-1);

  if (conversation === undefined) throw new Error("Missing second conversation");

  const message = await session.command(
    ReviewCommand.cases.PostMessage.make({
      commandId: id(),
      projectId: session.projectId,
      expectedVersion: created.project?.version ?? -1,
      conversationId: conversation.id,
      text,
    }),
  );

  return await session.run(
    session.packets.start(
      Schema.decodeUnknownSync(StartPacketReview)({
        commandId: id(),
        projectId: session.projectId,
        conversationId: conversation.id,
        messageId: message.entityId,
        model: "muse-spark-1.3",
        discipline: "auto",
        maxCalls: null,
      }),
    ),
  );
}

const ToolOutput = Schema.Struct({
  recorded: Schema.Record(Schema.String, Schema.String),
  jurisdictionHistory: Schema.Struct({
    earlierReviews: Schema.Array(
      Schema.Struct({ projectName: Schema.String, match: Schema.String }),
    ),
    citations: Schema.Array(Schema.Struct({ document: Schema.String, status: Schema.String })),
    recordedEditions: Schema.Array(Schema.Struct({ value: Schema.String })),
    agencyComments: Schema.Array(Schema.Struct({ comment: Schema.String })),
  }),
});

test("jurisdiction text reads states, counties and cities without guessing", () => {
  const manatee = jurisdictionPlace("Manatee County, FL (AHJ per G-1)");
  expect([...manatee.states]).toEqual(["Florida"]);
  expect([...manatee.localities]).toEqual(["manatee county"]);

  const tampa = jurisdictionPlace(
    "City of Tampa Building Department, Hillsborough County, Florida",
  );

  expect([...tampa.localities].toSorted()).toEqual(["city of tampa", "hillsborough county"]);
  expect([...jurisdictionPlace("West Virginia").states]).toEqual(["West Virginia"]);
  expect(jurisdictionPlace("Needs input - not visible on Page 2 crop").states.size).toBe(0);
  // A bare upper-case word is not a state code; ", FL" is.
  expect(jurisdictionPlace("AS NOTED IN G-1").states.size).toBe(0);
  expect([...jurisdictionPlace("Manatee County / State of Florida").localities]).toEqual([
    "manatee county",
  ]);

  expect(jurisdictionMatch(manatee, jurisdictionPlace("Manatee County"))).toBe("locality");
  expect(jurisdictionMatch(manatee, jurisdictionPlace("Florida (AHJ anonymized)"))).toBe("state");
  expect(jurisdictionMatch(manatee, jurisdictionPlace("Orange County, CA"))).toBeNull();
  expect(jurisdictionMatch(manatee, jurisdictionPlace("Manatee County, GA"))).toBeNull();
  expect(jurisdictionMatch(jurisdictionPlace("Needs input"), manatee)).toBeNull();
});

test("jurisdiction history ranks locality matches first and prefers verified citations", () => {
  const earlier = (
    id: string,
    jurisdiction: string,
    changedAt: number,
    status: string,
  ): Parameters<typeof jurisdictionHistory>[1][number] => ({
    id,
    projectName: `Project ${id.slice(0, 1)}`,
    changedAt,
    projectConfiguration: { jurisdiction, codeEditions: "FBC 8th Edition (2023)" },
    sources: [
      {
        url: "https://www.floridabuilding.org/bc/bc_default.aspx",
        title: "Florida Building Commission",
        status: "available",
        official: true,
        retrievedAt: "2026-10-29T00:00:00.000Z",
      },
    ],
    citations: [
      {
        jurisdiction,
        document: "Florida Building Code, Building",
        edition: "8th Edition (2023)",
        section: "1006.2",
        status,
      },
    ],
    priorComments: [],
  });

  const { history, leads } = jurisdictionHistory("Manatee County, Florida", [
    earlier("a0000000-0000-4000-8000-000000000000", "Florida (anonymized)", 3, "verified"),
    earlier("b0000000-0000-4000-8000-000000000000", "Manatee County, FL", 1, "unverified"),
    earlier("c0000000-0000-4000-8000-000000000000", "Orange County, CA", 5, "verified"),
  ]);

  expect(leads.reviews.map((item) => [item.projectName, item.match])).toEqual([
    ["Project b", "locality"],
    ["Project a", "state"],
  ]);
  // One source and one citation after deduplication; the verified copy wins.
  expect(leads.sources).toBe(1);
  expect(leads.citations).toBe(1);
  expect(leads.editions).toBe(1);
  expect(JSON.stringify(history)).toContain('"status":"verified"');
  expect(JSON.stringify(history)).not.toContain("Orange County");
});

test("reviewer decisions survive model updates, reach follow-ups and appear in the report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-decisions-"));
  const script = scripted();
  const session = await open(directory, script.transport);

  try {
    let sheetId = "";
    let findingId = "";

    const finding = (overrides: Record<string, typeof Schema.Json.Type> = {}) => ({
      name: "record_finding",
      arguments: {
        title: "Door hardware groups need confirmation",
        discipline: "general",
        severity: "Minor",
        status: "Needs input",
        classification: "Recommendation",
        locations: [{ sheetId, detail: "Door schedule", region: null }],
        observed: "Hardware group labels on the plan use a different numbering than the schedule.",
        correction: "Confirm the hardware group numbering on the plan and schedule.",
        evidenceIds: [],
        evidenceNote: "Schedule text read from the title block area.",
        citationIds: [],
        calculationIds: [],
        priorCommentId: null,
        ...overrides,
      },
    });

    script.steps.push(
      () => response([{ name: "inventory_packet", arguments: {} }]),
      (request) => {
        const inventory = outputs(PacketReview, request).at(-1);
        sheetId = inventory?.sheets[0]?.id ?? "";

        return response([finding()]);
      },
      finish,
    );

    const first = await session.run(
      session.packets.start(await session.request("Review the door hardware.")),
    );

    const done = await until(session, first.id, "completed");
    findingId = done.findings[0]?.id ?? "";
    expect(findingId).not.toBe("");
    expect(systemPrompt(script.requests[0] ?? { model: "" })).toContain("Reviewer decisions:");

    const stale = await session.run(
      Effect.result(
        session.packets.decide({
          projectId: session.projectId,
          reviewId: done.id,
          findingId,
          decision: { verdict: "false_alarm", reason: "Stale" },
          expectedVersion: done.version - 1,
        }),
      ),
    );

    expect(Result.isFailure(stale) && stale.failure.reason).toBe("conflict");

    const decided = await session.run(
      session.packets.decide({
        projectId: session.projectId,
        reviewId: done.id,
        findingId,
        decision: {
          verdict: "false_alarm",
          reason: "The plan uses the hardware supplier's numbering, which the schedule key maps.",
        },
        expectedVersion: done.version,
      }),
    );

    expect(decided.findings[0]?.decision?.verdict).toBe("false_alarm");
    expect(decided.findings[0]?.decision?.decidedAt).toBeGreaterThan(0);

    const report = renderPacketReport(decided, new Map());
    expect(report).toContain("Reviewer decision: <strong>False alarm</strong>");
    expect(report).toContain("supplier&#39;s numbering");

    // The follow-up updates the dismissed finding and also tries to set a decision itself.
    script.steps.push((request) => {
      // Its input carries the reviewer's verdict and reason with the finding.
      expect(JSON.stringify(request.input)).toContain("supplier's numbering");
      expect(JSON.stringify(request.input)).toContain("false_alarm");

      return response([
        finding({ id: findingId, severity: "Major" }),
        finding({
          id: findingId,
          decision: { verdict: "valid", reason: "Model override", decidedAt: 1 },
        }),
      ]);
    }, finish);

    const followUp = await session.run(
      session.packets.start(await session.request("Check the hardware groups again.")),
    );

    const after = await until(session, followUp.id, "completed");
    const updated = after.findings.find((item) => item.id === findingId);
    expect(updated?.severity).toBe("Major");
    expect(updated?.decision?.verdict).toBe("false_alarm");

    const cleared = await session.run(
      session.packets.decide({
        projectId: session.projectId,
        reviewId: after.id,
        findingId,
        decision: null,
        expectedVersion: after.version,
      }),
    );

    expect(cleared.findings.find((item) => item.id === findingId)?.decision).toBeUndefined();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("new reviews apply the saved firm checklist revision; saves are versioned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-checklist-"));
  const script = scripted();
  const session = await open(directory, script.transport);

  try {
    expect(await session.run(session.packets.checklist)).toBeNull();

    const saved = await session.run(
      session.packets.saveChecklist({
        text: "- Every sheet carries the firm's seal block.",
        expectedRevision: 0,
      }),
    );

    expect(saved.revision).toBe(1);

    const again = await session.run(
      session.packets.saveChecklist({
        text: "- Every sheet carries the firm's seal block.",
        expectedRevision: 1,
      }),
    );

    expect(again.revision).toBe(1);

    const stale = await session.run(
      Effect.result(session.packets.saveChecklist({ text: "Other", expectedRevision: 0 })),
    );

    expect(Result.isFailure(stale) && stale.failure.reason).toBe("conflict");

    script.steps.push(finish);

    const started = await session.run(
      session.packets.start(await session.request("Review the set.")),
    );

    const done = await until(session, started.id, "completed");
    expect(done.firmChecklist).toEqual({ revision: 1, text: saved.text });

    const prompt = systemPrompt(script.requests[0] ?? { model: "" });
    expect(prompt).toContain("## Firm review checklist, revision 1");
    expect(prompt).toContain("- Every sheet carries the firm's seal block.");
    expect(prompt.indexOf("## Firm review checklist")).toBeGreaterThan(
      prompt.indexOf("Requested scope:"),
    );
    expect(renderPacketReport(done, new Map())).toContain("Firm checklist, revision 1");

    // Clearing the checklist is a new revision; later reviews run without one.
    const clearedChecklist = await session.run(
      session.packets.saveChecklist({ text: "", expectedRevision: 1 }),
    );

    expect(clearedChecklist.revision).toBe(2);
    const sent = script.requests.length;
    script.steps.push(finish);

    const next = await startInNewConversation(session, "Review the set again.");
    const nextDone = await until(session, next.id, "completed");
    expect(nextDone.firmChecklist).toBeUndefined();
    expect(systemPrompt(script.requests[sent] ?? { model: "" })).not.toContain("Firm review");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("record_project offers earlier reviews' sources, citations and comments for the same jurisdiction once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-jurisdiction-"));
  const script = scripted();
  const session = await open(directory, script.transport);

  try {
    script.steps.push(
      () =>
        response([
          {
            name: "record_project",
            arguments: {
              values: {
                jurisdiction: "Manatee County, FL (AHJ per G-1)",
                governingCodes: "2023 FBC Existing 8th Edition; NFPA 72 2022",
              },
            },
          },
          {
            name: "record_citation",
            arguments: {
              id: crypto.randomUUID(),
              sourceId: null,
              jurisdiction: "Manatee County / State of Florida",
              document: "NFPA 72 National Fire Alarm and Signaling Code",
              edition: "2022",
              section: "10.6.7",
              quote: "",
              application: "Secondary power duration for the fire alarm panel.",
              status: "unverified",
              note: "Login required for the official text.",
            },
          },
          {
            name: "record_prior_comment",
            arguments: {
              id: crypto.randomUUID(),
              agency: "Manatee County Fire Marshal",
              date: "2025-11-02",
              number: "FA-3",
              comment: "Provide battery calculations for the added notification appliances.",
              response: "",
              changedSources: "",
              status: "Open",
              evidenceIds: [],
            },
          },
        ]),
      finish,
    );

    const first = await session.run(
      session.packets.start(await session.request("Review the fire alarm set.")),
    );

    const earlier = await until(session, first.id, "completed");
    expect(earlier.jurisdictionLeads?.reviews).toEqual([]);

    const sent = script.requests.length;

    script.steps.push(
      () =>
        response([
          {
            name: "record_project",
            arguments: { values: { jurisdiction: "Manatee County, Florida" } },
          },
        ]),
      () =>
        response([
          {
            name: "record_project",
            arguments: {
              values: {
                jurisdiction: "City of Bradenton, Manatee County, Florida",
                permitStage: "Permit set",
              },
            },
          },
        ]),
      finish,
    );

    const second = await startInNewConversation(session, "Review this fire alarm addition.");
    const done = await until(session, second.id, "completed");

    // The last request carries every tool result of the second review's conversation once. Only
    // its first record_project call returned the history, though the second refined the place.
    const last = script.requests.at(-1);
    expect(script.requests.length).toBeGreaterThan(sent);
    const offered = last === undefined ? [] : outputs(ToolOutput, last);
    expect(offered).toHaveLength(1);
    const history = offered[0]?.jurisdictionHistory;
    expect(history?.earlierReviews).toEqual([
      { projectName: "Packet QA fixture", match: "locality" },
    ]);
    expect(history?.citations[0]?.document).toBe("NFPA 72 National Fire Alarm and Signaling Code");
    expect(history?.recordedEditions[0]?.value).toContain("NFPA 72 2022");
    expect(history?.agencyComments[0]?.comment).toContain("battery calculations");

    expect(done.jurisdictionLeads?.reviews.map((item) => item.reviewId)).toEqual([earlier.id]);
    expect(done.jurisdictionLeads?.citations).toBe(1);
    expect(done.jurisdictionLeads?.agencyComments).toBe(1);
    expect(done.projectConfiguration.permitStage).toBe("Permit set");
    // Leads are not copied into this review's own evidence.
    expect(done.citations).toHaveLength(0);
    expect(done.priorComments).toHaveLength(0);
    expect(renderPacketReport(done, new Map())).toContain("Leads from earlier reviews");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
