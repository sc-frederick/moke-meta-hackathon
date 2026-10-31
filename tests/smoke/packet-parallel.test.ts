import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import { reviewDisciplines } from "#lib/review/execution.ts";
import { ReviewPass } from "#lib/review/packet.ts";
import { packetCoverageProgress } from "#lib/review/packet-coverage.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  systemPrompt,
  until,
  type Request,
  type Session,
} from "../fixtures/packet-review.ts";

const parallel = { minSheets: 2, concurrency: { meta: 4, baseten: 2 } } as const;

const SheetInput = Schema.Struct({
  stage: Schema.Literal("sheet"),
  sheet: Schema.Struct({ id: Schema.String }),
  inventory: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const CoordinatorInput = Schema.Struct({ stage: Schema.Literals(["setup", "coordination"]) });

/** A successful render_sheet result names the page it delivered. */
const Rendered = Schema.Struct({
  artifact: Schema.Struct({ id: Schema.String, sheetId: Schema.String }),
});

/** Every pass and discipline of one sheet, checked. */
const coverage = (sheetId: string) => ({
  name: "record_coverage_batch",
  arguments: {
    entries: reviewDisciplines.flatMap((discipline) =>
      ReviewPass.literals.map((pass) => ({
        sheetId,
        discipline: discipline.id,
        pass,
        status: "checked",
        note: "",
      })),
    ),
  },
});

const finishSheet = (sheetId: string) => ({
  name: "finish_sheet",
  arguments: {
    summary: `Sheet ${sheetId} reviewed.`,
    keyFacts: [`Area on ${sheetId}: 5,005 SF`],
    crossReferences: [],
    suspectedGaps: [],
  },
});

/** Function tools a request offered the model. */
const offered = (request: typeof Request.Type) =>
  Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.optionalKey(Schema.String) })),
  )(request.tools ?? []).flatMap((tool) =>
    tool.type === "function" && tool.name !== undefined ? [tool.name] : [],
  );

/** A sheet reviewer that opens its sheet, records its coverage and saves its notes. */
const reviewOwnSheet = (request: typeof Request.Type, own: string) => {
  const made = calls(request.input);

  if (!outputs(Rendered, request).some((result) => result.artifact.sheetId === own))
    return response([{ name: "render_sheet", arguments: { sheetId: own } }]);

  if (!made.includes("record_coverage_batch")) return response([coverage(own)]);

  if (!made.includes("finish_sheet")) return response([finishSheet(own)]);

  return response([], "Sheet notes saved.");
};

/** A coordinator that finishes the review once it reaches coordination. */
const coordinate = (request: typeof Request.Type) => {
  const input = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(request.input ?? []);

  const start = input.findLastIndex((item) =>
    strings(item).some((text) => text.startsWith('{"stage":"coordination"')),
  );

  return calls(input.slice(start)).includes("finish_review")
    ? response([], "Coordination complete.")
    : response([
        {
          name: "finish_review",
          arguments: { summary: "Sheets reviewed and compared.", missingInputs: [] },
        },
      ]);
};

/** A finding with a display-ready summary, so no summary step is needed. */
const findingOn = (
  sheetIds: ReadonlyArray<string>,
  evidenceIds: ReadonlyArray<string> = [],
  region: { x: number; y: number; width: number; height: number } | null = null,
) => ({
  title: "Door hardware set differs from the schedule",
  discipline: "general",
  severity: "Minor",
  status: "Needs input",
  classification: "Drawing conflict",
  locations: sheetIds.map((sheetId) => ({ sheetId, detail: "Door 101 hardware", region })),
  observed: "The plan lists hardware set 3 where the door schedule lists set 4.",
  correction: "Revise the plan or the door schedule so both list one hardware set.",
  evidenceIds,
  evidenceNote: "The hardware tag is legible on the rendered sheet.",
  citationIds: [],
  calculationIds: [],
  priorCommentId: null,
});

const SetupInput = Schema.Struct({
  stage: Schema.Literal("setup"),
  inventory: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const samResponse = () =>
  Response.json({
    id: "sam-parallel",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
  });

/** Names of the tool calls already in this conversation's transcript. */
function calls(input: typeof Schema.Json.Type | undefined) {
  return Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
      }),
    ),
  )(input ?? []).flatMap((item) => (item.type === "function_call" && item.name ? [item.name] : []));
}

/**
 * Scripted coordinator and sheet reviewers. One sheet reviewer opens first to cache the shared
 * prompt prefix. Each reviewer's second request is then held until both are on the wire, so they
 * must run concurrently and one in-flight attempt cannot block the other.
 */
function script(
  failing:
    | "none"
    | "second-sheet"
    | "second-sheet-without-notes"
    | "pending-summary"
    | "pending-summary-reversed",
  // Only the concurrency test holds requests; elsewhere a peer may never arrive to release it.
  holdUntilBoth = false,
) {
  const arrived = new Set<string>();
  const bothArrived = Promise.withResolvers<void>();

  const observed = {
    maxInFlight: 0,
    rejections: 0,
    stages: new Array<string>(),
    /** Each sheet reviewer's opening request, and whether another opening was still on the wire. */
    openings: new Array<{ readonly sheetId: string; readonly overlapped: boolean }>(),
    cacheKeys: { sheet: new Set<string>(), coordinator: new Set<string>() },
    retention: new Set<string>(),
  };

  let inFlight = 0;
  let opening = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    const prompt = systemPrompt(request);
    const made = calls(request.input);
    expect(prompt).toContain("## Short, actionable findings");
    expect(prompt).toContain(
      "Do not copy example facts, findings or corrections into a review without support.",
    );

    if (request.prompt_cache_retention !== undefined)
      observed.retention.add(request.prompt_cache_retention);

    if (prompt.includes("## Parallel review: sheet reviewer")) {
      const input = outputs(SheetInput, request).at(0);

      if (!input) throw new Error("Sheet reviewer input is missing its sheet");
      const own = input.sheet.id;
      const other = input.inventory.find((sheet) => sheet.id !== own)?.id ?? own;
      const first = own < other;

      observed.rejections += strings(request.input ?? null).filter((text) =>
        text.includes("You review one assigned sheet"),
      ).length;

      if (request.prompt_cache_key !== undefined)
        observed.cacheKeys.sheet.add(request.prompt_cache_key);

      if (made.length === 0) {
        observed.openings.push({ sheetId: own, overlapped: opening > 0 });
        opening++;
        await Bun.sleep(20);
        opening--;

        if (failing === "second-sheet" && !first)
          return Response.json({ error: { message: "Internal error" } }, { status: 500 });

        // The first sheet reviewer also tries to open the other sheet, which the host refuses.
        return response([{ name: "render_sheet", arguments: { sheetId: first ? other : own } }]);
      }

      if (made.length === 1 && holdUntilBoth) {
        arrived.add(own);

        if (arrived.size === 2) bothArrived.resolve();
        inFlight++;
        observed.maxInFlight = Math.max(observed.maxInFlight, inFlight);
        await Promise.race([bothArrived.promise, Bun.sleep(5000)]);
        inFlight--;
      }

      // A render refused because the review paused is retried after resume, as a model would.
      if (!outputs(Rendered, request).some((result) => result.artifact.sheetId === own))
        return response([{ name: "render_sheet", arguments: { sheetId: own } }]);

      if (!made.includes("record_coverage_batch")) return response([coverage(own)]);

      if (
        (failing === "pending-summary" || failing === "pending-summary-reversed") &&
        !made.includes("record_finding")
      )
        return response([
          ...(failing === "pending-summary-reversed" ? [finishSheet(own)] : []),
          {
            name: "record_finding",
            arguments: {
              title: "Pressure assumptions need confirmation",
              discipline: "general",
              severity: "Minor",
              status: "Needs input",
              classification: "Recommendation",
              locations: [{ sheetId: own, detail: "Source assumptions", region: null }],
              observed:
                "Pressure data needs confirmation. The installation scope is still uncertain.",
              correction: "Provide the measured pressure before sizing.",
              evidenceIds: [],
              evidenceNote: "Original source context is retained for the reviewer.",
              citationIds: [],
              calculationIds: [],
              priorCommentId: null,
            },
          },
        ]);

      // This reviewer ignores both its instructions and the host's reminder to save notes.
      if (failing === "second-sheet-without-notes" && !first)
        return response([], "Sheet reviewed.");

      if (!made.includes("finish_sheet")) return response([finishSheet(own)]);

      return response([], "Sheet notes saved.");
    }

    if (!prompt.includes("## Parallel review: coordinator"))
      throw new Error("A large packet must not run as a single reviewer");

    const stage = outputs(CoordinatorInput, request).at(-1)?.stage;

    if (!stage) throw new Error("Coordinator input is missing its stage");
    observed.stages.push(stage);

    if (request.prompt_cache_key !== undefined)
      observed.cacheKeys.coordinator.add(request.prompt_cache_key);

    if (stage === "setup")
      return made.includes("record_project")
        ? response([], "Project configuration recorded.")
        : response([
            { name: "record_project", arguments: { values: { jurisdiction: "Needs input" } } },
          ]);

    return made.includes("finish_review")
      ? response([], "Coordination complete.")
      : response([
          {
            name: "finish_review",
            arguments: { summary: "Sheets reviewed and compared.", missingInputs: [] },
          },
        ]);
  };

  return { transport, observed };
}

test.each(["pending-summary", "pending-summary-reversed"] as const)(
  "sheet and coordinator finishing cannot silently drop pending summaries: %s",
  async (order) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-parallel-summary-"));
    const { transport } = script(order);
    const session = await open(directory, transport, true, undefined, "observe", parallel);

    try {
      const started = await session.run(
        session.packets.start(await session.request("Review the whole drawing set.")),
      );

      const failed = await until(session, started.id, "failed");
      expect(failed.findings).toHaveLength(2);
      expect(failed.findings.every((finding) => finding.summary?._tag === "Pending")).toBe(true);
      expect(failed.parallel?.sheets.every((sheet) => sheet.notes === undefined)).toBe(true);
      expect(failed.parallel?.sheets.every((sheet) => sheet.state === "failed")).toBe(true);
      expect(failed.finished).toBe(false);
      expect(failed.error).toContain("short summaries remain pending");
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);

test("a large packet reviews its sheets in concurrent conversations between coordinator setup and coordination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-"));
  const { transport, observed } = script("none", true);
  const session = await open(directory, transport, true, undefined, "observe", parallel);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    expect(started.parallel?.stage).toBe("setup");
    expect(started.parallel?.sheets).toHaveLength(2);

    const finished = await until(session, started.id, "completed");

    expect(observed.maxInFlight).toBe(2);
    // The second reviewer opens only after the first one's opening request cached the prefix.
    expect(observed.openings).toHaveLength(2);
    expect(observed.openings.some((entry) => entry.overlapped)).toBe(false);
    // Sheet reviewers share one cache key and the coordinator has its own; both ask for 24h.
    expect(observed.cacheKeys.sheet.size).toBe(1);
    expect(observed.cacheKeys.coordinator.size).toBe(1);
    expect([...observed.cacheKeys.sheet][0]).not.toBe([...observed.cacheKeys.coordinator][0]);
    expect([...observed.retention]).toEqual(["24h"]);
    expect(finished.promptUsage?.calls).toBeGreaterThan(0);
    expect(finished.parallel?.sheets.every((sheet) => (sheet.promptUsage?.calls ?? 0) > 0)).toBe(
      true,
    );
    expect(observed.rejections).toBeGreaterThan(0);
    expect(observed.stages[0]).toBe("setup");
    expect(observed.stages.at(-1)).toBe("coordination");
    expect(finished.parallel?.stage).toBe("coordination");
    expect(finished.parallel?.sheets.map((sheet) => sheet.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(finished.parallel?.sheets.every((sheet) => sheet.notes?.keyFacts.length === 1)).toBe(
      true,
    );
    expect(new Set(finished.parallel?.sheets.map((sheet) => sheet.conversationId)).size).toBe(2);
    expect(packetCoverageProgress(finished).complete).toBe(true);
    expect(finished.projectConfiguration.jurisdiction).toBe("Needs input");
    expect(finished.finished).toBe(true);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

const WireRequest = Schema.fromJsonString(
  Schema.Struct({
    prompt_cache_key: Schema.optionalKey(Schema.String),
    tools: Schema.optionalKey(Schema.Json),
    input: Schema.Array(Schema.Json),
  }),
);

test("every conversation's next request extends its previous request byte for byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-prefix-"));
  const { transport } = script("none");

  const requests: Array<{
    readonly conversation: string;
    readonly stage: string;
    readonly wire: typeof WireRequest.Type;
  }> = [];

  const recording: ProviderTransport = async (url, init) => {
    const request = decodeRequest(init);
    const sheet = systemPrompt(request).includes("## Parallel review: sheet reviewer");

    requests.push({
      conversation: sheet
        ? (outputs(SheetInput, request).at(0)?.sheet.id ?? "unknown")
        : "coordinator",
      stage: sheet ? "sheet" : (outputs(CoordinatorInput, request).at(-1)?.stage ?? "unknown"),
      wire: Schema.decodeUnknownSync(WireRequest)(
        Schema.decodeUnknownSync(Schema.String)(init?.body),
      ),
    });

    return transport(url, init);
  };

  const session = await open(directory, recording, true, undefined, "observe", parallel);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    await until(session, started.id, "completed");
    const conversations = Map.groupBy(requests, (request) => request.conversation);
    expect(conversations.size).toBe(3);
    expect(conversations.has("unknown")).toBe(false);

    const toolChanges: Array<string> = [];

    for (const sequence of conversations.values()) {
      expect(sequence.length).toBeGreaterThan(1);

      for (let index = 1; index < sequence.length; index++) {
        const before = sequence[index - 1];
        const after = sequence[index];
        const previous = before?.wire;
        const current = after?.wire;

        if (previous === undefined || current === undefined) throw new Error("Missing request");
        expect(current.prompt_cache_key).toBe(previous.prompt_cache_key);

        // Each stage keeps one tool list; the coordinator's widens once, for coordination.
        if (before?.stage === after?.stage)
          expect(JSON.stringify(current.tools)).toBe(JSON.stringify(previous.tools));
        else toolChanges.push(`${before?.stage}->${after?.stage}`);
        // No earlier turn is edited, reordered or re-encoded, so the cached prefix stays valid.
        expect(
          current.input.slice(0, previous.input.length).map((item) => JSON.stringify(item)),
        ).toEqual(previous.input.map((item) => JSON.stringify(item)));
      }
    }

    expect(toolChanges).toEqual(["setup->coordination"]);

    // Sheet reviewers' opening requests share tools and every field before their own sheet.
    const openings = [...conversations].flatMap(([conversation, sequence]) =>
      conversation === "coordinator" ? [] : [sequence[0]?.wire],
    );

    const sheetText = (wire: typeof WireRequest.Type | undefined) =>
      strings(wire?.input ?? []).find((text) => text.startsWith('{"stage":"sheet"')) ?? "";

    const [left, right] = openings.map(sheetText);
    const shared = left?.indexOf('"continuation"') ?? -1;
    expect(shared).toBeGreaterThan(0);
    expect(right?.slice(0, shared)).toBe(left?.slice(0, shared));
    expect(left?.slice(0, shared)).toContain('"inventory"');
    expect(JSON.stringify(openings[0]?.tools)).toBe(JSON.stringify(openings[1]?.tools));
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("one sheet reviewer's unresolved provider request stops only that sheet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-failure-"));
  const { transport, observed } = script("second-sheet");
  const session = await open(directory, transport, true, undefined, "observe", parallel);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    const finished = await until(session, started.id, "uncertain");
    const sheets = finished.parallel?.sheets ?? [];
    const stopped = sheets.find((sheet) => sheet.state === "failed");

    expect(sheets.map((sheet) => sheet.state).toSorted()).toEqual(["completed", "failed"]);
    expect(stopped?.providerFailure?.httpStatus).toBe(500);
    expect(stopped?.notes).toBeUndefined();
    expect(sheets.find((sheet) => sheet.state === "completed")?.notes?.summary).toContain(
      "reviewed",
    );
    // The coordinator still compared the sheets that reported.
    expect(observed.stages.at(-1)).toBe("coordination");
    expect(finished.error).toContain("1 of 2 sheet reviewers stopped");
    expect(finished.providerFailure?.httpStatus).toBe(500);
    expect(packetCoverageProgress(finished).complete).toBe(false);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a call budget pauses a parallel review mid-sheet and resume finishes the queued sheets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-resume-"));
  const { transport, observed } = script("none");
  const session = await open(directory, transport, true, undefined, "observe", parallel);

  try {
    // Setup uses two calls and each sheet reviewer's first request one more.
    const started = await session.run(
      session.packets.start(
        await session.request("Review the whole drawing set.", { maxCalls: 4 }),
      ),
    );

    await until(session, started.id, "paused");
    let paused = await session.run(session.packets.get(session.projectId, started.id));

    // Sheet reviewers settle after the budget pauses the review.
    for (let wait = 0; paused.parallel?.sheets.some((sheet) => sheet.state === "running"); wait++) {
      if (wait > 500) throw new Error("Sheet reviewers did not settle after the pause");
      await Bun.sleep(10);
      paused = await session.run(session.packets.get(session.projectId, started.id));
    }

    expect(paused.parallel?.stage).toBe("sheets");
    expect(paused.parallel?.sheets.map((sheet) => sheet.state)).toEqual(["queued", "queued"]);
    expect(paused.parallel?.sheets.every((sheet) => sheet.conversationId !== null)).toBe(true);

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: paused.version,
        action: "resume",
        maxCalls: 40,
        commandId: id(),
      }),
    );

    const finished = await until(session, started.id, "completed");

    // Resume continues the same sheet conversations; setup does not run again.
    expect(observed.stages.filter((stage) => stage === "setup")).toHaveLength(2);
    expect(finished.parallel?.sheets.map((sheet) => sheet.conversationId)).toEqual(
      paused.parallel?.sheets.map((sheet) => sheet.conversationId),
    );
    expect(finished.parallel?.sheets.map((sheet) => sheet.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(packetCoverageProgress(finished).complete).toBe(true);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a sheet reviewer that ends without finish_sheet is not reported to the coordinator as completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-notes-"));
  const { transport, observed } = script("second-sheet-without-notes");
  const session = await open(directory, transport, true, undefined, "observe", parallel);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    const finished = await until(session, started.id, "completed");
    const sheets = finished.parallel?.sheets ?? [];

    expect(observed.stages.at(-1)).toBe("coordination");
    expect(sheets.map((sheet) => sheet.state).toSorted()).toEqual(["completed", "failed"]);
    expect(sheets.find((sheet) => sheet.state === "failed")?.notes).toBeUndefined();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a sheet reviewer's SAM request and its peer's model requests do not block each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-sam-"));
  const peerHeld = Promise.withResolvers<void>();
  const samArrived = Promise.withResolvers<void>();
  const peerContinued = Promise.withResolvers<void>();
  let samSends = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") {
      samSends++;
      samArrived.resolve();
      // The peer's next model request is admitted while this SAM request is on the wire.
      await Promise.race([peerContinued.promise, Bun.sleep(5000)]);

      return Response.json({
        id: "sam-parallel",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
      });
    }

    const prompt = systemPrompt(request);
    const made = calls(request.input);

    if (prompt.includes("## Parallel review: sheet reviewer")) {
      const input = outputs(SheetInput, request).at(0);

      if (!input) throw new Error("Sheet reviewer input is missing its sheet");
      const own = input.sheet.id;
      const segmenting = own === input.inventory[0]?.id;
      const rendered = outputs(Rendered, request).find((result) => result.artifact.sheetId === own);

      if (!rendered) return response([{ name: "render_sheet", arguments: { sheetId: own } }]);

      if (segmenting && !made.includes("segment_objects")) {
        // SAM is admitted while the peer's model request is on the wire.
        await Promise.race([peerHeld.promise, Bun.sleep(5000)]);

        return response([
          {
            name: "segment_objects",
            arguments: {
              artifactId: rendered.artifact.id,
              prompt: { kind: "concept", text: "luminaires" },
            },
          },
        ]);
      }

      if (!made.includes("record_coverage_batch")) {
        if (!segmenting) {
          peerHeld.resolve();
          await Promise.race([samArrived.promise, Bun.sleep(5000)]);
        }

        return response([coverage(own)]);
      }

      if (!made.includes("finish_sheet")) {
        if (!segmenting) peerContinued.resolve();

        return response([finishSheet(own)]);
      }

      return response([], "Sheet notes saved.");
    }

    const stage = outputs(CoordinatorInput, request).at(-1)?.stage;

    if (stage === "setup") return response([], "Project configuration recorded.");

    return made.includes("finish_review")
      ? response([], "Coordination complete.")
      : response([
          {
            name: "finish_review",
            arguments: { summary: "Sheets reviewed and compared.", missingInputs: [] },
          },
        ]);
  };

  const session = await open(directory, transport, true, undefined, "observe", parallel);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    const finished = await until(session, started.id, "completed");

    expect(samSends).toBe(1);
    expect(finished.parallel?.sheets.map((sheet) => sheet.state)).toEqual([
      "completed",
      "completed",
    ]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("coordinator setup is offered and runs only configuration work, ends at its request limit, and stays ended across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-setup-"));
  const setupRequests = new Array<typeof Request.Type>();
  let samSends = 0;
  let current: Session | undefined;
  let atFirstSheet: { readonly coverage: number; readonly findings: number } | undefined;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") {
      samSends++;

      return samResponse();
    }

    if (systemPrompt(request).includes("## Parallel review: sheet reviewer")) {
      const own = outputs(SheetInput, request).at(0)?.sheet.id;

      if (own === undefined) throw new Error("Sheet reviewer input is missing its sheet");

      if (atFirstSheet === undefined && current !== undefined) {
        const review = (await current.run(current.packets.list(current.projectId)))[0];
        atFirstSheet = {
          coverage: (review?.coverage ?? []).filter((entry) => entry.status !== "unreviewed")
            .length,
          findings: review?.findings.length ?? -1,
        };
      }

      return reviewOwnSheet(request, own);
    }

    const stage = outputs(CoordinatorInput, request).at(-1)?.stage;

    if (stage === "coordination") return coordinate(request);
    setupRequests.push(request);
    const [first, second] = outputs(SetupInput, request).at(0)?.inventory ?? [];
    const rendered = outputs(Rendered, request).at(0);

    if (first === undefined || second === undefined) throw new Error("Setup input lacks sheets");

    if (rendered === undefined)
      return response([{ name: "render_sheet", arguments: { sheetId: first.id } }]);

    // An adversarial setup reviews sheets instead of finishing, every way it can.
    if (setupRequests.length === 2)
      return response([
        { name: "render_sheet", arguments: { sheetId: second.id } },
        coverage(first.id),
        { name: "record_finding", arguments: findingOn([first.id], [rendered.artifact.id]) },
        {
          name: "segment_objects",
          arguments: {
            artifactId: rendered.artifact.id,
            prompt: { kind: "concept", text: "luminaires" },
          },
        },
        {
          name: "finish_review",
          arguments: { summary: "Reviewed during setup.", missingInputs: [] },
        },
      ]);

    return response([{ name: "record_project", arguments: { values: { occupancy: "B" } } }]);
  };

  const limited = { ...parallel, setup: { sheets: 1, requests: 3 } };
  let session = await open(directory, transport, true, undefined, "observe", limited);
  current = session;

  try {
    const sheets = (await session.snapshot()).sheets;

    // Setup's three requests leave one call: the first sheet reviewer's opening.
    const started = await session.run(
      session.packets.start(
        await session.request("Review the whole drawing set.", { maxCalls: 4 }),
      ),
    );

    await until(session, started.id, "paused");
    let paused = await session.run(session.packets.get(session.projectId, started.id));

    for (let wait = 0; paused.parallel?.sheets.some((sheet) => sheet.state === "running"); wait++) {
      if (wait > 500) throw new Error("Sheet reviewers did not settle after the pause");
      await Bun.sleep(10);
      paused = await session.run(session.packets.get(session.projectId, started.id));
    }

    // The fourth setup request was never sent: the limit ended setup and started the sheets.
    expect(setupRequests).toHaveLength(3);
    expect(paused.parallel?.stage).toBe("sheets");
    expect(paused.parallel?.setup?.sheetIds).toEqual(sheets.slice(0, 1).map((sheet) => sheet.id));
    expect(paused.parallel?.setup?.projectConfiguration).toEqual({ occupancy: "B" });
    expect(paused.parallel?.setup?.sources).toEqual([]);

    for (const request of setupRequests)
      expect(offered(request).toSorted()).toEqual(
        [
          "ask_reviewer",
          "finish_setup",
          "inventory_packet",
          "read_source",
          "record_citation",
          "record_project",
          "render_sheet",
          "search_code",
          "search_sources",
        ].toSorted(),
      );

    // Each review call the model emitted anyway was refused without a mutation or SAM request.
    const refused = strings(setupRequests[2]?.input ?? null).join("\n");
    expect(refused).toContain("Setup opens at most 1 configuration sheets");

    for (const tool of [
      "record_coverage_batch",
      "record_finding",
      "segment_objects",
      "finish_review",
    ])
      expect(refused).toContain(`Tool ${tool} is not available`);
    expect(atFirstSheet).toEqual({ coverage: 0, findings: 0 });
    expect(paused.inspectedThisReviewSheetIds).not.toContain(sheets[1]?.id);

    await session.dispose();
    session = await open(directory, transport, false, undefined, "observe", limited);
    current = session;
    const reopened = await session.run(session.packets.get(session.projectId, started.id));

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: reopened.version,
        action: "resume",
        maxCalls: 60,
        commandId: id(),
      }),
    );

    const finished = await until(session, started.id, "completed");

    // After the restart the sheets continue from the saved setup; setup does not run again.
    expect(setupRequests).toHaveLength(3);
    expect(finished.parallel?.setup).toEqual(paused.parallel?.setup);
    expect(finished.parallel?.sheets.map((sheet) => sheet.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(finished.findings).toHaveLength(0);
    expect(samSends).toBe(0);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a sheet reviewer cannot record, adopt or segment another sheet's findings and evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-fence-"));
  const findingId = crypto.randomUUID();
  let firstArtifact: string | undefined;
  let refusals: ReadonlyArray<string> = [];
  let samSends = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") {
      samSends++;

      return samResponse();
    }

    const made = calls(request.input);

    if (systemPrompt(request).includes("## Parallel review: sheet reviewer")) {
      const input = outputs(SheetInput, request).at(0);

      if (!input) throw new Error("Sheet reviewer input is missing its sheet");
      const own = input.sheet.id;
      const peer = input.inventory.find((sheet) => sheet.id !== own)?.id ?? own;
      const rendered = outputs(Rendered, request).find((result) => result.artifact.sheetId === own);

      if (!rendered) return response([{ name: "render_sheet", arguments: { sheetId: own } }]);

      // One reviewer at a time: the first records a finding, then the second tries to reach it.
      if (own === input.inventory[0]?.id) {
        firstArtifact = rendered.artifact.id;

        if (!made.includes("record_finding"))
          return response([
            {
              name: "record_finding",
              arguments: { ...findingOn([own], [rendered.artifact.id]), id: findingId },
            },
          ]);

        return reviewOwnSheet(request, own);
      }

      if (!made.includes("record_finding"))
        return response([
          { name: "record_finding", arguments: findingOn([peer]) },
          { name: "record_finding", arguments: { ...findingOn([own]), id: findingId } },
          { name: "record_finding", arguments: findingOn([own], [firstArtifact ?? "missing"]) },
          {
            name: "segment_objects",
            arguments: {
              artifactId: firstArtifact ?? "missing",
              prompt: { kind: "concept", text: "door tags" },
            },
          },
        ]);

      if (refusals.length === 0) refusals = strings(request.input ?? null);

      return reviewOwnSheet(request, own);
    }

    const stage = outputs(CoordinatorInput, request).at(-1)?.stage;

    if (stage === "setup") return response([], "Project configuration recorded.");

    // The coordinator still updates a sheet's finding across sheets.
    if (!made.includes("record_finding")) {
      const [first, second] =
        outputs(
          Schema.Struct({
            stage: Schema.Literal("coordination"),
            sheetReviews: Schema.Array(Schema.Struct({ sheetId: Schema.String })),
          }),
          request,
        ).at(-1)?.sheetReviews ?? [];

      return response([
        {
          name: "record_finding",
          arguments: {
            ...findingOn([first?.sheetId ?? "missing", second?.sheetId ?? "missing"]),
            id: findingId,
          },
        },
      ]);
    }

    return coordinate(request);
  };

  const sequential = { ...parallel, concurrency: { meta: 1, baseten: 1 } };
  const session = await open(directory, transport, true, undefined, "observe", sequential);

  try {
    const sheets = (await session.snapshot()).sheets;

    const started = await session.run(
      session.packets.start(await session.request("Review the whole drawing set.")),
    );

    const finished = await until(session, started.id, "completed");
    const refused = refusals.join("\n");

    expect(refused.split("You review one assigned sheet").length - 1).toBe(3);
    expect(refused).toContain("That finding belongs to another sheet or to the coordinator");
    expect(samSends).toBe(0);
    expect(finished.findings).toHaveLength(1);
    expect(finished.findings[0]?.id).toBe(findingId);
    expect(finished.findings[0]?.locations.map((location) => location.sheetId)).toEqual(
      sheets.map((sheet) => sheet.id),
    );
    expect(finished.findings[0]?.summary?.sheetId).toBeNull();
    expect(finished.segmentedSheetIds ?? []).toEqual([]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("every sheet reviewer opens from the setup snapshot after a peer adds a source, across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-parallel-snapshot-"));
  const openings = new Map<string, string>();
  let setupCalls = 0;

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);
    const made = calls(request.input);

    if (systemPrompt(request).includes("## Parallel review: sheet reviewer")) {
      const input = outputs(SheetInput, request).at(0);

      if (!input) throw new Error("Sheet reviewer input is missing its sheet");
      const own = input.sheet.id;

      openings.set(
        own,
        strings(request.input ?? null).find((text) => text.startsWith('{"stage":"sheet"')) ?? "",
      );

      const rendered = outputs(Rendered, request).some((result) => result.artifact.sheetId === own);

      // The first reviewer adds a source and tries to change the occupancy before its peer opens.
      if (own === input.inventory[0]?.id && rendered && !made.includes("read_source"))
        return response([
          { name: "read_source", arguments: { url: "https://county.gov/amendments" } },
          { name: "record_project", arguments: { values: { occupancy: "A-2" } } },
        ]);

      return reviewOwnSheet(request, own);
    }

    const stage = outputs(CoordinatorInput, request).at(-1)?.stage;

    if (stage === "coordination") return coordinate(request);
    setupCalls++;

    return made.includes("record_project")
      ? response([{ name: "finish_setup", arguments: { needsInput: ["permit stage"] } }])
      : response([{ name: "record_project", arguments: { values: { occupancy: "B" } } }]);
  };

  const sources = {
    resolve: async () => [{ address: "1.1.1.1", family: 4 as const }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode("<p>County amendment text.</p>"),
    }),
  };

  // One sheet at a time, so the second reviewer opens after the first has finished.
  const sequential = { ...parallel, concurrency: { meta: 1, baseten: 1 } };
  let session = await open(directory, transport, true, undefined, "observe", sequential, sources);

  try {
    // Setup's two calls use the budget; the first reviewer is created, then the review pauses.
    const started = await session.run(
      session.packets.start(
        await session.request("Review the whole drawing set.", { maxCalls: 2 }),
      ),
    );

    await until(session, started.id, "paused");
    let paused = await session.run(session.packets.get(session.projectId, started.id));

    for (let wait = 0; paused.parallel?.sheets.some((sheet) => sheet.state === "running"); wait++) {
      if (wait > 500) throw new Error("Sheet reviewers did not settle after the pause");
      await Bun.sleep(10);
      paused = await session.run(session.packets.get(session.projectId, started.id));
    }

    // finish_setup ended setup at once: its round sent no further coordinator request.
    expect(setupCalls).toBe(2);
    expect(paused.parallel?.setup?.projectConfiguration).toEqual({
      occupancy: "B",
      "permit stage": "Needs input",
    });

    await session.dispose();
    session = await open(directory, transport, false, undefined, "observe", sequential, sources);
    const reopened = await session.run(session.packets.get(session.projectId, started.id));

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: reopened.version,
        action: "resume",
        maxCalls: 60,
        commandId: id(),
      }),
    );

    const finished = await until(session, started.id, "completed");
    const [first, second] = finished.sheets.map((sheet) => openings.get(sheet.id) ?? "");
    const shared = first?.indexOf('"continuation"') ?? -1;

    // The first opening was written before the restart and the second after its peer's source.
    expect(shared).toBeGreaterThan(0);
    expect(second?.slice(0, shared)).toBe(first?.slice(0, shared));
    expect(second?.slice(0, shared)).toContain(
      '"projectConfiguration":{"occupancy":"B","permit stage":"Needs input"},"sources":[]',
    );
    expect(finished.sources).toHaveLength(1);
    expect(finished.projectConfiguration.occupancy).toBe("B");
    expect(finished.parallel?.setup).toEqual(paused.parallel?.setup);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
