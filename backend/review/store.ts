import { Context, DateTime, Effect, Layer, Match, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { createHash, randomUUID } from "node:crypto";
import {
  Artifact, ArtifactId, CheckId, CheckRun, CommandReceipt, Conversation,
  ConversationId, CountFact, FactId, Finding, FindingId, OperationId, Project,
  ProjectId, Revision, RevisionId, ReviewCommand, ReviewConflict, ReviewError,
  ReviewEvent, ReviewInputError, ReviewMessage, ReviewSnapshot, ReviewStorageError,
  Sheet, SheetId,
} from "#lib/review/contracts.ts";
import { evaluateCoordination } from "#lib/review/checks.ts";
import { containsRegion } from "#lib/review/geometry.ts";
import type { ImportedPdf } from "../documents/types.ts";
import { CountProposal, DetailRequest, ExecutionFence } from "./execution-port.ts";
import { RunRecord } from "./execution-store.ts";

/** Model tools can propose and inspect, but cannot accept an engineering input. */
export const AgentMutation = Schema.Union([
  Schema.TaggedStruct("Propose", { proposal: CountProposal }),
  Schema.TaggedStruct("Evaluate", {}),
  Schema.TaggedStruct("Message", { text: Schema.NonEmptyString }),
  Schema.TaggedStruct("Render", { detail: DetailRequest, artifact: Artifact }),
]).pipe(Schema.toTaggedUnion("_tag"));

const PayloadRows = Schema.Array(Schema.Struct({ payload: Schema.String }));
const CommandRows = Schema.Array(Schema.Struct({ fingerprint: Schema.String, receipt: Schema.String }));
const Link = Schema.Struct({ old_sheet_id: SheetId, new_sheet_id: SheetId, confirmed: Schema.Int, content: Schema.String });
const failure = (message: string) => new ReviewInputError({ message });
const fingerprint = <A extends object>(value: A) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = Effect.map(DateTime.now, DateTime.formatIso);

/** Application persistence owns idempotent commands, fact versions, and dependency invalidation. */
export class ReviewStore extends Context.Service<ReviewStore, {
  readonly snapshot: (projectId: typeof ProjectId.Type | null, afterSequence: number) => Effect.Effect<ReviewSnapshot, typeof ReviewError.Type>;
  readonly execute: (command: typeof ReviewCommand.Type) => Effect.Effect<CommandReceipt, typeof ReviewError.Type>;
  readonly importPdf: (command: ImportPdfCommand, imported: ImportedPdf) => Effect.Effect<CommandReceipt, typeof ReviewError.Type>;
  readonly artifact: (projectId: typeof ProjectId.Type, artifactId: typeof ArtifactId.Type) => Effect.Effect<Artifact, typeof ReviewError.Type>;
  readonly saveRender: (artifact: Artifact) => Effect.Effect<Artifact, typeof ReviewError.Type>;
  readonly agent: (fence: ExecutionFence, mutation: typeof AgentMutation.Type) => Effect.Effect<CommandReceipt, typeof ReviewError.Type>;
}>()("review/ReviewStore") {
  /** Uses the caller's short-lived initialized connection and recovery exclusion. */
  static readonly layer = Layer.effect(ReviewStore, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const safe = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError((error) =>
      Schema.is(ReviewError)(error) ? error : new ReviewStorageError({ message: "Review data could not be read or saved." }),
    ));

    const records = Effect.fn("ReviewStore.records")(function* <A, I>(schema: Schema.Codec<A, I>, projectId: typeof ProjectId.Type, kind: string) {
      const rows = yield* sql`SELECT payload FROM review_records WHERE project_id=${projectId} AND kind=${kind} ORDER BY rowid LIMIT 2001`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)));

      if (rows.length > 2000) return yield* new ReviewStorageError({ message: "This project exceeds the workbench record limit; export its evidence before continuing." });

      return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.payload));
    });

    const save = (kind: string, value: { readonly id: string; readonly projectId: typeof ProjectId.Type }) =>
      sql`INSERT INTO review_records (project_id,id,kind,payload) VALUES (${value.projectId},${value.id},${kind},${JSON.stringify(value)})
        ON CONFLICT(project_id,id) DO UPDATE SET payload=excluded.payload`;

    const receiptFor = Effect.fn("ReviewStore.receiptFor")(function* (commandId: string, hash: string) {
      const rows = yield* sql`SELECT fingerprint,receipt FROM review_commands WHERE command_id=${commandId}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CommandRows)));
      const row = rows[0];

      if (row === undefined) return undefined;

      if (row.fingerprint !== hash) return yield* new ReviewConflict({ message: "This command ID was already used with different input." });

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommandReceipt))(row.receipt);
    });

    const getProject = Effect.fn("ReviewStore.project")(function* (id: typeof ProjectId.Type) {
      const rows = yield* sql`SELECT payload FROM review_projects WHERE id=${id}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)));
      const row = rows[0];

      if (row === undefined) return yield* failure("The selected project does not exist.");

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Project))(row.payload);
    });

    const finish = Effect.fn("ReviewStore.finish")(function* (
      commandId: CommandReceipt["commandId"], hash: string, project: Project,
      entityId: string, kind: string, message: string,
    ) {
      const updated = new Project({ ...project, version: project.version + 1 });
      const receipt = new CommandReceipt({ commandId, projectId: project.id, entityId, version: updated.version });
      yield* sql`UPDATE review_projects SET version=${updated.version},payload=${JSON.stringify(updated)} WHERE id=${project.id}`;
      yield* sql`INSERT INTO review_commands (command_id,project_id,fingerprint,receipt) VALUES (${commandId},${project.id},${hash},${JSON.stringify(receipt)})`;
      yield* sql`INSERT INTO review_events (project_id,command_id,kind,message,created_at) VALUES (${project.id},${commandId},${kind},${message},${yield* now})`;

      return receipt;
    });

    const snapshot = Effect.fn("ReviewStore.snapshot")(function* (projectId: typeof ProjectId.Type | null, afterSequence: number) {
      const projectRows = yield* sql`SELECT payload FROM review_projects ORDER BY rowid LIMIT 101`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)));

      if (projectRows.length > 100) return yield* failure("The workbench supports at most 100 projects.");
      const projects = yield* Effect.forEach(projectRows, (row) => Schema.decodeUnknownEffect(Schema.fromJsonString(Project))(row.payload));
      const project = projectId === null ? projects[0] ?? null : yield* getProject(projectId);

      if (project === null) return new ReviewSnapshot({ projects, project, revisions: [], sheets: [], artifacts: [], findings: [], facts: [], checks: [], conversations: [], messages: [], events: [] });
      const revisions = yield* records(Revision, project.id, "revision");
      const sheets = yield* records(Sheet, project.id, "sheet");
      const artifacts = yield* records(Artifact, project.id, "artifact");
      const findings = yield* records(Finding, project.id, "finding");
      const facts = yield* records(CountFact, project.id, "fact");
      const checks = yield* records(CheckRun, project.id, "check");
      const conversations = yield* records(Conversation, project.id, "conversation");
      const messages = yield* records(ReviewMessage, project.id, "message");
      const events = yield* sql`SELECT sequence,project_id AS projectId,command_id AS commandId,kind,message,created_at AS createdAt FROM review_events WHERE project_id=${project.id} AND sequence>${afterSequence} ORDER BY sequence LIMIT 2000`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ReviewEvent))));

      return new ReviewSnapshot({ projects, project, revisions, sheets, artifacts, findings, facts, checks, conversations, messages, events });
    });

    const staleFinding = Effect.fn("ReviewStore.staleFinding")(function* (finding: Finding) {
      // Check runs are immutable. Only the current finding pointer is marked stale.
      yield* save("finding", new Finding({ ...finding, outcome: "stale" }));
    });

    const execute = Effect.fn("ReviewStore.execute")(function* (input: typeof ReviewCommand.Type, receiptHash?: string) {
      const command = yield* Schema.decodeUnknownEffect(ReviewCommand)(input);
      const hash = receiptHash ?? fingerprint(Schema.encodeSync(ReviewCommand)(command));
      const previous = yield* receiptFor(command.commandId, hash);

      if (previous !== undefined) return previous;
      const createdAt = yield* now;

      if (ReviewCommand.guards.CreateProject(command)) {
        const project = new Project({ id: Schema.decodeUnknownSync(ProjectId)(randomUUID()), name: command.name, version: 0, sourceVersion: 0, factVersion: 0, createdAt });
        yield* sql`INSERT INTO review_projects (id,version,payload) VALUES (${project.id},0,${JSON.stringify(project)})`;
        const conversation = new Conversation({ id: Schema.decodeUnknownSync(ConversationId)(randomUUID()), projectId: project.id, title: "Drawing coordination", createdAt });
        yield* save("conversation", conversation);

        return yield* finish(command.commandId, hash, project, project.id, command._tag, "Project created.");
      }

      let project = yield* getProject(command.projectId);

      if (project.version !== command.expectedVersion) return yield* new ReviewConflict({ message: "The project changed. Reload before applying this operation." });
      const state = yield* snapshot(project.id, 0);
      const findSheet = (id: typeof SheetId.Type) => state.sheets.find((sheet) => sheet.id === id);
      let entityId: string = project.id;
      let message = "Review updated.";

      yield* Match.value(command).pipe(Match.tagsExhaustive({
"CreateConversation": (command) => Effect.gen(function* () {
const conversation = new Conversation({ id: Schema.decodeUnknownSync(ConversationId)(randomUUID()), projectId: project.id, title: command.title, createdAt });
yield* save("conversation", conversation);
entityId = conversation.id;
message = "Review conversation created.";
}),
"PostMessage": (command) => Effect.gen(function* () {
if (!state.conversations.some((conversation) => conversation.id === command.conversationId)) return yield* failure("The conversation does not belong to this project.");
const entry = new ReviewMessage({ id: randomUUID(), projectId: project.id, conversationId: command.conversationId, role: "reviewer", text: command.text, createdAt });
yield* save("message", entry);
entityId = entry.id;
message = "Reviewer instruction saved; conversation text is not accepted evidence.";
}),
"ConfirmSheet": (command) => Effect.gen(function* () {
const sheet = findSheet(command.sheetId);
if (sheet === undefined) return yield* failure("The sheet does not belong to this project.");
yield* save("sheet", new Sheet({ ...sheet, label: command.label, confirmed: true, coverage: command.coverage }));
entityId = sheet.id;
message = "Sheet identity and coverage confirmed.";
}),
"CreateFinding": (command) => Effect.gen(function* () {
const drawn = findSheet(command.drawnSheetId);
const scheduled = findSheet(command.scheduledSheetId);
if (drawn === undefined || scheduled === undefined) return yield* failure("Both check sources must belong to this project.");
const finding = new Finding({ id: Schema.decodeUnknownSync(FindingId)(randomUUID()), projectId: project.id, title: command.title, objectClass: command.objectClass, drawnSheetId: drawn.id, scheduledSheetId: scheduled.id, applicabilityConfirmed: command.applicabilityConfirmed, latestCheckId: null, outcome: "needs_evidence", closed: false, taskCompleted: false });
yield* save("finding", finding);
entityId = finding.id;
message = "Coordination check created; accepted inputs are still required.";
}),
"AcceptCount": (command) => Effect.gen(function* () {
const finding = state.findings.find((item) => item.id === command.findingId);
const sheet = findSheet(command.evidence.sheetId);
if (finding === undefined || sheet === undefined) return yield* failure("The input does not belong to this project's finding and sheet.");
const expectedSheet = command.side === "drawn" ? finding.drawnSheetId : finding.scheduledSheetId;
if (sheet.id !== expectedSheet || !sheet.confirmed || !containsRegion(sheet.box, command.evidence.region)) return yield* failure("Accept a bounded region on the confirmed source sheet for this operand.");
const old = state.facts.findLast((fact) => fact.findingId === finding.id && fact.side === command.side);
const fact = new CountFact({ id: Schema.decodeUnknownSync(FactId)(randomUUID()), projectId: project.id, findingId: finding.id, side: command.side, version: (old?.version ?? 0) + 1, state: "accepted", value: command.value, unit: command.unit, coverageConfirmed: command.coverageConfirmed, evidence: command.evidence, actor: "reviewer", rationale: command.rationale, supersedes: old?.id ?? null, createdAt });
yield* save("fact", fact);
yield* sql`INSERT INTO review_fact_versions (project_id,fact_id,finding_id,side,version) VALUES (${project.id},${fact.id},${finding.id},${fact.side},${fact.version})`;
yield* staleFinding(finding);
project = new Project({ ...project, factVersion: project.factVersion + 1 });
entityId = fact.id;
message = "Accepted input saved. Only its dependent finding is stale; earlier calculations remain in history.";
}),
"EvaluateFinding": (command) => Effect.gen(function* () {
const finding = state.findings.find((item) => item.id === command.findingId);
if (finding === undefined) return yield* failure("The finding does not belong to this project.");
const links = yield* sql`SELECT old_sheet_id,new_sheet_id,confirmed,content FROM review_sheet_links WHERE project_id=${project.id}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Link))));
const currentSource = (source: typeof SheetId.Type, current: typeof SheetId.Type) => {
            const visited = new Set<string>();
            let cursor = source;

            while (cursor !== current && !visited.has(cursor)) {
              visited.add(cursor);
              const link = links.find((item) => item.old_sheet_id === cursor && item.confirmed === 1 && item.content === "unchanged");

              if (link === undefined) return false;
              cursor = link.new_sheet_id;
            }

            return cursor === current && findSheet(current)?.confirmed === true;
          };
const drawn = state.facts.findLast((fact) => fact.findingId === finding.id && fact.side === "drawn" && fact.state === "accepted");
const scheduled = state.facts.findLast((fact) => fact.findingId === finding.id && fact.side === "scheduled" && fact.state === "accepted");
const result = evaluateCoordination(finding,
            drawn !== undefined && currentSource(drawn.evidence.sheetId, finding.drawnSheetId) ? drawn : undefined,
            scheduled !== undefined && currentSource(scheduled.evidence.sheetId, finding.scheduledSheetId) ? scheduled : undefined);
const check = new CheckRun({ id: Schema.decodeUnknownSync(CheckId)(randomUUID()), projectId: project.id, findingId: finding.id, ruleVersion: "schedule-count-v1", drawnFactId: drawn?.id ?? null, scheduledFactId: scheduled?.id ?? null, drawnCount: drawn?.value ?? null, scheduledCount: scheduled?.value ?? null, ...result, createdAt });
yield* save("check", check);
for (const fact of [drawn, scheduled]) if (fact !== undefined) {
            yield* sql`INSERT INTO review_dependencies (project_id,input_id,dependent_id) VALUES (${project.id},${fact.id},${check.id})`;
            yield* sql`INSERT OR IGNORE INTO review_dependencies (project_id,input_id,dependent_id) VALUES (${project.id},${fact.evidence.sheetId},${finding.id})`;
          }
yield* save("finding", new Finding({ ...finding, latestCheckId: check.id, outcome: check.outcome }));
entityId = check.id;
message = check.explanation;
}),
"SetFindingStatus": (command) => Effect.gen(function* () {
const finding = state.findings.find((item) => item.id === command.findingId);
if (finding === undefined) return yield* failure("The finding does not belong to this project.");
yield* save("finding", new Finding({ ...finding, closed: command.closed, taskCompleted: command.taskCompleted }));
entityId = finding.id;
message = "Reviewer closure and task completion saved independently of the check result.";
}),
"AssociateRevision": (command) => Effect.gen(function* () {
if (!state.revisions.some((revision) => revision.id === command.revisionId)) return yield* failure("The revision does not belong to this project.");
const oldIds = new Set<string>();
const newIds = new Set<string>();
for (const pair of command.correspondence) {
            const old = findSheet(pair.oldSheetId);
            const next = findSheet(pair.newSheetId);

            if (old === undefined || next === undefined || old.revisionId === next.revisionId || next.revisionId !== command.revisionId || oldIds.has(old.id) || newIds.has(next.id)) return yield* failure("Revision correspondence must be one-to-one between different revisions of this project.");
            oldIds.add(old.id);
            newIds.add(next.id);
            yield* sql`INSERT INTO review_sheet_links (project_id,old_sheet_id,new_sheet_id,confirmed,content) VALUES (${project.id},${old.id},${next.id},${Number(pair.confirmed)},${pair.content}) ON CONFLICT(project_id,old_sheet_id,new_sheet_id) DO UPDATE SET confirmed=excluded.confirmed,content=excluded.content`;

            if (pair.confirmed) yield* save("sheet", new Sheet({ ...next, confirmed: true }));
          }
for (const finding of state.findings) {
            const mapSide = (id: typeof SheetId.Type) => command.correspondence.find((pair) => pair.oldSheetId === id);
            const drawn = mapSide(finding.drawnSheetId);
            const scheduled = mapSide(finding.scheduledSheetId);
            const previousRevision = state.sheets.find((sheet) => sheet.id === finding.drawnSheetId)?.revisionId;
            const affected = drawn !== undefined || scheduled !== undefined || previousRevision !== command.revisionId;

            if (!affected) continue;
            const unchanged = drawn?.confirmed === true && drawn.content === "unchanged" && scheduled?.confirmed === true && scheduled.content === "unchanged";
            yield* save("finding", new Finding({ ...finding,
              drawnSheetId: drawn?.confirmed ? drawn.newSheetId : finding.drawnSheetId,
              scheduledSheetId: scheduled?.confirmed ? scheduled.newSheetId : finding.scheduledSheetId,
              outcome: unchanged ? finding.outcome : "stale",
            }));

            for (const id of [finding.drawnSheetId, finding.scheduledSheetId]) {
              const pair = mapSide(id);

              if (pair === undefined || !pair.confirmed) {
                const old = findSheet(id);

                if (old !== undefined) yield* save("sheet", new Sheet({ ...old, confirmed: false }));
              }
            }
          }
project = new Project({ ...project, sourceVersion: project.sourceVersion + 1 });
entityId = command.revisionId;
message = "Revision correspondence recorded. Changed and unconfirmed dependencies require new evidence; history is retained.";
})
}));

      return yield* finish(command.commandId, hash, project, entityId, command._tag, message);
    });

    const importPdf = Effect.fn("ReviewStore.importPdf")(function* (command: ImportPdfCommand, imported: ImportedPdf) {
      const hash = fingerprint({ ...command, sourceHash: imported.sha256 });
      const previous = yield* receiptFor(command.commandId, hash);

      if (previous !== undefined) return previous;
      const project = yield* getProject(command.projectId);

      if (project.version !== command.expectedVersion) return yield* new ReviewConflict({ message: "The project changed during import. Reload and import again." });

      if (imported.pages.length === 0) return yield* failure("The PDF contains no reviewable pages.");
      const revisionId = Schema.decodeUnknownSync(RevisionId)(randomUUID());
      const artifactId = Schema.decodeUnknownSync(ArtifactId)(randomUUID());
      const original = new Artifact({ id: artifactId, projectId: project.id, revisionId, sheetId: null, sha256: imported.sha256, mediaType: "application/pdf", byteLength: imported.byteLength, width: 0, height: 0, region: null, dpi: 0, pdfToPixels: [1,0,0,1,0,0], pixelsToPdf: [1,0,0,1,0,0], operationId: Schema.decodeUnknownSync(OperationId)(command.commandId) });
      const revision = new Revision({ id: revisionId, projectId: project.id, artifactId, name: command.name, sha256: imported.sha256, pageCount: imported.pages.length, importedAt: yield* now });
      yield* save("artifact", original);
      yield* save("revision", revision);

      for (const page of imported.pages) yield* save("sheet", new Sheet({ ...page, id: Schema.decodeUnknownSync(SheetId)(randomUUID()), projectId: project.id, revisionId, confirmed: false, coverage: "unreviewed" }));

      return yield* finish(command.commandId, hash, project, revisionId, "ImportReviewPdf", "Immutable original imported. Confirm sheet identities before accepting evidence.");
    });

    const agent = Effect.fn("ReviewStore.agent")(function* (fence: ExecutionFence, mutation: typeof AgentMutation.Type) {
      const fingerprintInput = AgentMutation.guards.Render(mutation) ? { _tag: mutation._tag, detail: mutation.detail } : mutation;
      const hash = fingerprint({ fence, mutation: fingerprintInput });
      // Replay lookup precedes every freshness check, including paused/old-owner cases.
      const previous = yield* receiptFor(fence.commandId, hash);

      if (previous !== undefined) return previous;
      const project = yield* getProject(fence.projectId);
      const runs = yield* sql`SELECT * FROM review_execution_runs WHERE run_id=${fence.runId} AND project_id=${fence.projectId}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunRecord))));
      const run = runs[0];

      if (run === undefined || run.finding_id !== fence.findingId || run.journal_id !== fence.journalId || run.owner_generation !== fence.ownerGeneration || (run.state !== "running" && run.state !== "pausing") || run.source_version !== fence.sourceVersion || run.fact_version !== fence.factVersion || project.sourceVersion !== fence.sourceVersion || project.factVersion !== fence.factVersion) {
        return yield* new ReviewConflict({ message: "This execution result is no longer current for its owner, run, source, or accepted facts." });
      }

      const state = yield* snapshot(project.id, 0);
      const finding = state.findings.find((item) => item.id === fence.findingId);

      if (finding === undefined) return yield* failure("The execution finding is outside this project.");
      const createdAt = yield* now;

      return yield* Match.value(mutation).pipe(Match.tagsExhaustive({
"Evaluate": (mutation) => Effect.gen(function* () {
return yield* execute(Schema.decodeUnknownSync(ReviewCommand)(ReviewCommand.cases.EvaluateFinding.make({commandId: fence.commandId,
projectId: project.id,
expectedVersion: project.version,
findingId: finding.id})), hash);
}),
"Propose": (mutation) => Effect.gen(function* () {
const proposal = mutation.proposal;
const sheetId = proposal.side === "drawn" ? finding.drawnSheetId : finding.scheduledSheetId;
const sheet = state.sheets.find((item) => item.id === sheetId);
if (proposal.evidence.sheetId !== sheetId || sheet === undefined || !containsRegion(sheet.box, proposal.evidence.region)) return yield* failure("The proposed observation is outside the selected source.");
const old = state.facts.findLast((fact) => fact.findingId === finding.id && fact.side === proposal.side);
const fact = new CountFact({ id: Schema.decodeUnknownSync(FactId)(randomUUID()), projectId: project.id, findingId: finding.id, side: proposal.side, version: (old?.version ?? 0) + 1, state: "proposed", value: proposal.value, unit: "count", coverageConfirmed: false, evidence: proposal.evidence, actor: "muse", rationale: proposal.rationale, supersedes: null, createdAt });
yield* save("fact", fact);
yield* sql`INSERT INTO review_fact_versions (project_id,fact_id,finding_id,side,version) VALUES (${project.id},${fact.id},${finding.id},${fact.side},${fact.version})`;
return yield* finish(fence.commandId, hash, project, fact.id, "ProposeObservation", "Muse observation proposed. Reviewer acceptance and coverage confirmation are still required.");
}),
"Message": (mutation) => Effect.gen(function* () {
const conversation = state.conversations[0];
if (conversation === undefined) return yield* failure("This project has no review conversation.");
const entry = new ReviewMessage({ id: randomUUID(), projectId: project.id, conversationId: conversation.id, role: "application", text: mutation.text, createdAt });
yield* save("message", entry);
return yield* finish(fence.commandId, hash, project, entry.id, "ReviewerQuestion", mutation.text);
}),
"Render": (mutation) => Effect.gen(function* () {
const artifact = mutation.artifact;
const allowed = artifact.sheetId === finding.drawnSheetId || artifact.sheetId === finding.scheduledSheetId;
if (!allowed || artifact.projectId !== project.id || String(artifact.operationId) !== String(fence.commandId)) return yield* failure("The rendered evidence is outside this execution's selected sources.");
yield* save("artifact", artifact);
return yield* finish(fence.commandId, hash, project, artifact.id, "SourceInspection", mutation.detail.missingFact);
})
}));
    });

    return ReviewStore.of({
      snapshot: (id, cursor) => safe(snapshot(id,cursor)),
      execute: (command) => safe(sql.withTransaction(execute(command))),
      importPdf: (command, imported) => safe(sql.withTransaction(importPdf(command,imported))),
      agent: (fence, mutation) => safe(sql.withTransaction(agent(fence, mutation))),
      artifact: (projectId, artifactId) => safe(Effect.gen(function* () {
        const artifacts = yield* records(Artifact,projectId,"artifact");
        const artifact = artifacts.find((item) => item.id === artifactId);

        if (artifact === undefined) return yield* failure("The artifact does not belong to this project.");

        return artifact;
      })),
      saveRender: (artifact) => safe(sql.withTransaction(Effect.gen(function* () {
        const state = yield* snapshot(artifact.projectId,0);
        const sheet = state.sheets.find((item) => item.id === artifact.sheetId && item.revisionId === artifact.revisionId);

        if (sheet === undefined) return yield* failure("The rendered source does not belong to this project revision.");
        const previous = state.artifacts.find((item) => item.operationId === artifact.operationId);

        if (previous !== undefined) {
          const same = previous.sheetId === artifact.sheetId && previous.dpi === artifact.dpi && JSON.stringify(previous.region) === JSON.stringify(artifact.region);

          if (!same) return yield* new ReviewConflict({ message: "This render operation ID was reused for a different source region." });

          return previous;
        }

        yield* save("artifact", artifact);

        return artifact;
      }))),
    });
  }));
}

/** The shell supplies a selected path only to processing; receipts retain source hashes. */
export interface ImportPdfCommand {
  readonly commandId: CommandReceipt["commandId"];
  readonly projectId: typeof ProjectId.Type;
  readonly expectedVersion: number;
  readonly name: string;
}
