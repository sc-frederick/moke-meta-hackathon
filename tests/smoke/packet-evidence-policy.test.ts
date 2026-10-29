import { expect, test } from "bun:test";
import { Effect, Match, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Artifact } from "#lib/review/contracts.ts";
import {
  PacketCitation,
  PacketPriorComment,
  PacketReview,
  PacketSource,
} from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

test.each(["edition", "section", "other section", "document", "short quote", "supported"] as const)(
  "retrieved citation identity gates confirmed regulatory findings: %s",
  async (claim) => {
    const directory = await mkdtemp(join(tmpdir(), "moke-citation-policy-"));

    const quote =
      "All plumbing installations shall provide accessible cleanouts at the specified locations.";

    const source = Schema.decodeUnknownSync(PacketSource)({
      id: id(),
      url: "https://example.gov/code/2020/101",
      title: "Florida Plumbing Code, 2020",
      retrievedAt: "2026-10-28T00:00:00.000Z",
      status: "available",
      official: true,
      sha256: "a".repeat(64),
      text: `Florida Plumbing Code\n2020 Edition\nSection 101 Scope\nThis section establishes the scope of the adopted plumbing requirements.\nSection 102 Cleanout access\n${quote}`,
    });

    const citation = Schema.decodeUnknownSync(PacketCitation)({
      id: id(),
      sourceId: source.id,
      jurisdiction: "Fixture jurisdiction; applicability requires engineering review",
      document: claim === "document" ? "Electrical Code" : "Florida Plumbing Code",
      edition: claim === "edition" ? "2026" : "2020",
      section: Match.value(claim).pipe(
        Match.when("section", () => "999.99"),
        Match.when("other section", () => "101"),
        Match.orElse(() => "102"),
      ),
      quote: claim === "short quote" ? "shall" : quote,
      application: "Cleanout access on the supplied plumbing plan",
      status: "verified",
      note: "Fixture source for application-level citation evidence validation.",
    });

    const findingId = id();
    let step = 0;
    let echoedStatus: typeof citation.status | undefined;

    const session = await open(directory, async (_url, init) => {
      const request = decodeRequest(init);

      switch (step++) {
        case 0:
          // This trusted fixture stands in for the read_source receipt. The real model adapter,
          // durable tools, SQL validation and regulatory-finding promotion still execute.
          await session.database(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              const rows = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ payload: Schema.fromJsonString(PacketReview) })),
              )(yield* sql`SELECT payload FROM packet_reviews ORDER BY rowid DESC LIMIT 1`);

              const current = rows[0]?.payload;

              if (!current) throw new Error("Missing real review row");
              const seeded = new PacketReview({ ...current, sources: [source] });
              yield* sql`UPDATE packet_reviews SET payload=${JSON.stringify(seeded)} WHERE id=${current.id}`;
            }),
          );

          return response([{ name: "record_citation", arguments: citation }]);
        case 1:
          echoedStatus = outputs(PacketCitation, request).at(-1)?.status;

          return response([
            {
              name: "record_finding",
              arguments: {
                id: findingId,
                title: "Cleanout access requirement fixture",
                discipline: "plumbing",
                severity: "Major",
                status: "Confirmed",
                classification: "Code",
                locations: [],
                observed: "Fixture request attempts a confirmed regulatory finding.",
                correction: "Provide the governing-source evidence before confirmation.",
                evidenceIds: [],
                evidenceNote:
                  "This regression isolates retrieved-law identity, not a pictured defect.",
                citationIds: [citation.id],
                calculationIds: [],
                priorCommentId: null,
              },
            },
          ]);
        default:
          return response([], "Citation evidence policy fixture finished.");
      }
    });

    try {
      const started = await session.run(
        session.packets.start(
          await session.request("Review the plumbing source evidence.", { discipline: "plumbing" }),
        ),
      );

      const finished = await until(session, started.id, "completed");
      const supported = claim === "supported";
      expect(echoedStatus).toBe(supported ? "verified" : "unverified");
      expect(finished.citations[0]?.status).toBe(supported ? "verified" : "unverified");
      expect(finished.findings.some((finding) => finding.id === findingId)).toBe(supported);

      if (!supported) expect(finished.citations[0]?.note).toContain("does not support");
    } finally {
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

test("resubmittal closure retains its revision target across an uninspected follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-prior-comment-policy-"));
  const commentId = id();
  let phase: "baseline" | "deferred" | "followup" = "baseline";
  let step = 0;
  let baselineArtifact: Artifact | undefined;
  let revisedArtifact: Artifact | undefined;
  let currentBaselineArtifact: Artifact | undefined;
  let inventory: PacketReview | undefined;
  let rejectedWithoutInspection = false;
  let rejectedBaselineInspection = false;
  let rejectedTargetOverride = false;

  const comment = (status: "Open" | "Resolved", evidenceIds: ReadonlyArray<string>) =>
    Schema.decodeUnknownSync(PacketPriorComment)({
      id: commentId,
      agency: "Fixture agency",
      date: "2026-10-28",
      number: "1",
      comment: "Coordinate the revised service and schedule on the supplied plan.",
      response:
        status === "Open" ? "Awaiting revised deliverable" : "Revised deliverable inspected",
      changedSources: status === "Open" ? "Baseline A" : "Revision B",
      status,
      evidenceIds,
    });

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    if (phase === "deferred")
      return response([], "Revision B remains uninspected and the agency comment remains open.");

    if (phase === "baseline") {
      switch (step++) {
        case 0:
          return response([{ name: "inventory_packet", arguments: {} }]);
        case 1: {
          inventory = outputs(PacketReview, request).at(-1);
          const sheet = inventory?.sheets[0];

          if (!sheet) throw new Error("Baseline sheet missing");

          return response([{ name: "render_sheet", arguments: { sheetId: sheet.id } }]);
        }

        case 2:
          baselineArtifact = outputs(Schema.Struct({ artifact: Artifact }), request).at(
            -1,
          )?.artifact;

          if (!baselineArtifact) throw new Error("Baseline source was not rendered");

          return response([
            { name: "record_prior_comment", arguments: comment("Open", [baselineArtifact.id]) },
            {
              name: "record_coverage",
              arguments: {
                sheetId: baselineArtifact.sheetId,
                discipline: "general",
                pass: "coordination",
                status: "checked",
                note: "Baseline source inspected before tracking the open revision comment.",
              },
            },
          ]);
        default:
          return response([], "Baseline inspected; comment remains open pending revision.");
      }
    }

    const prior = baselineArtifact;

    if (!prior || prior.sheetId === null) throw new Error("Missing retained baseline evidence");

    switch (step++) {
      case 0:
        return response([{ name: "inventory_packet", arguments: {} }]);
      case 1:
        inventory = outputs(PacketReview, request).at(-1);

        if (!inventory) throw new Error("Follow-up inventory missing");
        expect(inventory.inspectedSheetIds).toContain(prior.sheetId);
        expect(inventory.inspectedThisReviewSheetIds).toEqual([]);
        expect(inventory.baselineSheetIds).toHaveLength(inventory.sheets.length);
        expect(inventory.priorComments[0]?.revisionTargetSheetIds).not.toContain(prior.sheetId);
        expect(
          inventory.coverage.find(
            (entry) =>
              entry.sheetId === prior.sheetId &&
              entry.discipline === "general" &&
              entry.pass === "coordination",
          )?.status,
        ).toBe("checked");

        return response([
          { name: "record_prior_comment", arguments: comment("Resolved", [prior.id]) },
        ]);
      case 2: {
        if (!inventory) throw new Error("Follow-up inventory missing");
        const current = await session.run(session.packets.get(session.projectId, inventory.id));
        expect(current.priorComments[0]?.status).toBe("Open");
        expect(current.inspectedThisReviewSheetIds).toEqual([]);
        rejectedWithoutInspection = strings(request.input ?? null).some((text) =>
          text.includes("revision evidence"),
        );

        return response([
          {
            name: "record_prior_comment",
            arguments: {
              ...comment("Resolved", [prior.id]),
              revisionTargetSheetIds: [prior.sheetId],
            },
          },
        ]);
      }

      case 3: {
        if (!inventory) throw new Error("Follow-up inventory missing");
        const current = await session.run(session.packets.get(session.projectId, inventory.id));
        expect(current.priorComments[0]?.status).toBe("Open");
        expect(current.priorComments[0]?.revisionTargetSheetIds).not.toContain(prior.sheetId);
        rejectedTargetOverride = true;

        return response([{ name: "render_sheet", arguments: { sheetId: prior.sheetId } }]);
      }

      case 4:
        currentBaselineArtifact = outputs(Schema.Struct({ artifact: Artifact }), request).at(
          -1,
        )?.artifact;

        if (!currentBaselineArtifact) throw new Error("Current baseline render missing");

        return response([
          {
            name: "record_prior_comment",
            arguments: comment("Resolved", [currentBaselineArtifact.id]),
          },
        ]);
      case 5: {
        if (!inventory) throw new Error("Follow-up inventory missing");
        const current = await session.run(session.packets.get(session.projectId, inventory.id));
        expect(current.priorComments[0]?.status).toBe("Open");
        rejectedBaselineInspection = strings(request.input ?? null).some((text) =>
          text.includes("revision evidence"),
        );

        const revised = inventory.sheets.find((sheet) => sheet.revisionId !== prior.revisionId);

        if (!revised) throw new Error("Real imported revision B missing");

        return response([{ name: "render_sheet", arguments: { sheetId: revised.id } }]);
      }

      case 6:
        revisedArtifact = outputs(Schema.Struct({ artifact: Artifact }), request).at(-1)?.artifact;

        if (!revisedArtifact) throw new Error("Current revised evidence missing");

        return response([
          {
            name: "record_prior_comment",
            arguments: comment("Resolved", [prior.id, revisedArtifact.id]),
          },
        ]);
      default:
        return response([], "Comment resolved only after current revision B inspection.");
    }
  });

  try {
    const baseline = await session.run(
      session.packets.start(await session.request("Review the baseline source.")),
    );

    const initial = await until(session, baseline.id, "completed");
    expect(initial.priorComments[0]?.status).toBe("Open");
    const current = await session.snapshot();
    const revisedPdf = join(directory, "Revision B.pdf");
    await writeFile(revisedPdf, createHeroPdf("B"));
    await session.importPdf({
      commandId: id(),
      projectId: session.projectId,
      expectedVersion: current.project?.version ?? -1,
      source: revisedPdf,
      name: "Revision B.pdf",
    });
    phase = "deferred";

    const deferred = await session.run(
      session.packets.start(
        await session.request("Retain the open comment; revision B has not yet been inspected."),
      ),
    );

    const deferredResult = await until(session, deferred.id, "completed");
    expect(deferredResult.priorComments[0]?.status).toBe("Open");
    expect(deferredResult.inspectedThisReviewSheetIds).toEqual([]);
    expect(deferredResult.priorComments[0]?.revisionTargetSheetIds).not.toContain(
      baselineArtifact?.sheetId,
    );

    phase = "followup";
    step = 0;

    const followup = await session.run(
      session.packets.start(await session.request("Check revision B against agency comment 1.")),
    );

    const finished = await until(session, followup.id, "completed");

    if (!revisedArtifact || revisedArtifact.sheetId === null)
      throw new Error("Missing revised evidence");
    expect(rejectedWithoutInspection).toBe(true);
    expect(rejectedBaselineInspection).toBe(true);
    expect(rejectedTargetOverride).toBe(true);
    expect(revisedArtifact.revisionId).not.toBe(baselineArtifact?.revisionId);
    expect(finished.priorComments[0]?.status).toBe("Resolved");
    expect(finished.priorComments[0]?.evidenceIds).toContain(revisedArtifact.id);
    expect(finished.priorComments[0]?.revisionTargetSheetIds).toContain(revisedArtifact.sheetId);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
