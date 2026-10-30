# Firm memory: research and implementation plan

Checked 2026-10-30. This is a proposal. None of it is implemented.

**Question.** How should MOKE learn each engineering firm's way of working,
such as its typical details, calculation methods, sheet standards and review
habits, and use that knowledge during reviews? One example is suggesting a
detail the firm already used on a similar project.

**Sources.** The MOKE code at `8e94b578a`; the earlier T3 thread "How Gradon
Builds Its Firm Brain" from 2026-10-17; [Gradon's public site](https://heygradon.com/);
Meta's [Model API reference](https://dev.meta.ai/docs/api-reference/); and two
research notes written for this plan:
[agent memory research](research/memory-sota-notes.md) and
[AEC firm knowledge research](research/aec-firm-knowledge-notes.md). Local
probes ran on Bun 1.4.4 under WSL2. No model requests were made.

## Summary

1. **Keep four kinds of memory with separate write rules.** A firm library
   indexes details, notes, schedules, title blocks and calculations. Review
   history records findings, reviewer decisions and agency comments. A firm
   playbook holds approved rules. Project profiles describe each project so
   MOKE can find similar ones. Each kind has its own source, approval rule and
   use in a review.
2. **Treat memory as a lead, never as evidence.** MOKE's review instructions
   already say that historical comments may suggest a check, but only the
   current project's documents and governing sources establish a finding. The
   host enforces this: precedents and rules get their own fields and cannot be
   cited as source evidence or official citations.
3. **Retrieve precedents with text, image and project similarity together.**
   SQLite FTS5 ranks the drawing's own text and a model-written description of
   each detail. A patch-level visual retriever ranks detail crops, because
   published results on drawing sheets favor it strongly over text extraction.
   Normalized project attributes such as jurisdiction, occupancy and
   construction type rank similar projects. The reviewing model then opens the
   best candidates and compares them with the current detail.
4. **Learn from reviewer decisions, with a person approving every rule.**
   Reviewers mark a finding as valid, a false alarm or not the firm's practice,
   and choose how widely MOKE should remember the decision. Raw records are
   never overwritten. A consolidation run proposes playbook changes as small
   itemized edits derived from them. Only approved rules enter review
   instructions, and MOKE's own unreviewed output never becomes trusted memory.
5. **Store memory in its own SQLite file next to `app.sqlite`.** Firm memory is
   firm-scoped and outlives any project. A separate file keeps it out of cloud
   result replacement and makes export, sharing and deletion straightforward.
   No vector database server is needed at firm scale.
6. **Compute embeddings in a local worker process, after a gated spike.**
   Meta's Model API has no embeddings endpoint. The candidates are ColModernVBERT,
   an MIT-licensed 250M-parameter visual retriever, for similar conditions; Meta's
   Apache-2.0 Perception Encoder for spotting copied details; and Qwen3-Embedding
   0.6B for text. None is proven inside a compiled Bun backend, and local ONNX
   Runtime has open Bun defects, so Phase 0 tests them before anything depends on
   them. FTS5 retrieval works without any of them.
7. **Freeze a memory snapshot when each review starts.** The review records the
   playbook revision and index position it used, and the report states them.
   Approved rules sit in the system instructions as one stable block, which
   preserves the 90% cached-input target.
8. **Measure the result on firm projects.** Replay a firm's past projects in
   date order and compare reviews with and without memory: agency comments
   predicted, false alarms repeated, firm-standard deviations caught, and
   suggestion acceptance.

The first demonstrable slice is Phase 1 below: import a firm standards PDF,
have Muse find and compare the firm's standard detail during a review, and
record a suggestion that links both images.

## What MOKE should learn

MOKE reviews drawings. Gradon, the product discussed in the earlier thread,
produces drawings and needs firm "taste" to draft in the firm's style. That
thread concluded that taste lives in editable assets, explicit rules and visual
examples, and that a redline must be saved with its scope: a one-off fix for
one crowded sheet differs from a standing preference. Both conclusions carry
over to review.

For a reviewer, firm memory is useful in four ways:

- **Check against the firm's own standards.** Many QA/QC comments are internal:
  the wrong typical detail, a nonstandard sheet number, a calculation done
  differently from the firm's method. Code review alone does not find these.
- **Suggest proven precedent.** When a detail is missing, incomplete or unusual,
  MOKE can point to the detail the firm used for the same condition on a
  similar project and show the two side by side.
- **Remember what reviewers and agencies said before.** MOKE can raise the
  comments a jurisdiction usually makes, and stop repeating findings the firm's
  reviewers already dismissed for a stated reason.
- **Catch copied details that do not fit.** When a detail in the current set
  closely matches one from an earlier project with different conditions, such
  as another seismic design category, jurisdiction or code edition, MOKE can
  ask whether the copy still applies.

Gradon's site says its Firm Brain "learns your past projects, standards and
details" and "is stored in our cloud so your whole team can use it", while the
app runs on the user's computer. It does not describe the implementation. The
earlier thread judged it to be retrieval plus firm instructions and templates.

## What AEC practice and products show

The [AEC firm knowledge notes](research/aec-firm-knowledge-notes.md) give the
sources. The findings that shape this plan:

- **Drawings already carry keys.** UDS sheet IDs encode discipline, sheet type
  and sequence, with type 5 for details and type 7 for typical details. Detail
  references such as `5/S-501` name a detail and a sheet. Reference keynotes
  carry MasterFormat section numbers. The NCS leaves sequence numbering partly to
  each firm, so MOKE should learn a firm's variant instead of assuming one.
- **Firms keep two tiers of details.** Pirros, the closest shipped product,
  separates vetted "Typical Details" from all project details, and lets an admin
  mark older projects "Reference Only" so staff can look at them without reusing
  unreviewed work. Superseded typicals stay in the library with a reason.
  Caltrans and the federal UFGS specifications date every revision and mark
  archived items as prohibited for new projects.
- **Reuse most often fails through copies that no longer fit.** A STRUCTURE
  magazine series from 2021 and 2022 lists seismic details copied from a
  high-seismic building to a low-seismic one, delegated-design notes left in,
  and general notes citing the 1979 welding code. A 2018 paper by two
  specification consultants found firms rarely review standard details between
  projects. A useful suggestion therefore has to show how the earlier project
  differs from the current one.
- **Reuse does not shift responsibility.** The NCEES Model Rules require a
  licensee adapting a standard design to redo the code research and design
  file, and the sealing licensee takes full responsibility.
- **Confidentiality is a firm decision.** Firms normally keep the right to reuse
  their own standard details across clients. The AIA's AI toolkit treats
  unpublished project drawings as confidential. No source addressed showing one
  client's project detail to a team working for another client.
- **No shipped PDF reviewer suggests firm precedent during review, as far as the
  research found.** Most products take firm knowledge as uploaded checklists.
  Nomic builds review standards from past markups and RFIs. Procore ships a
  Lessons Learned agent. Claims that products learn from reviewer corrections
  are marketing with no independent test.
- **Reviewers want traceable findings and few false alarms.** Practitioner
  guides ask for a sheet location, a basis, a severity and a recorded accept or
  reject with a reason and the person who made it. Sorting false positives costs
  more than their count suggests.
- **Models read drawing text well and symbols poorly.** AECV-Bench reports up to
  0.95 on text questions and 0.40 to 0.55 on symbol counting. No public benchmark
  tests retrieval of similar typical details. In engineering diagram search,
  matching a local region worked better than matching a whole sheet, and
  suppressing callouts helped.

## Constraints from the current design

These existing rules shape the design:

- `backend/review/prompts/assets/AGENTS.md`: "Historical comments may suggest a
  check, but only this project's documents and governing sources establish a
  finding." `REVIEW_METHOD.md`: "Do not reuse a historical job's threshold."
- Packet reviews freeze the sheet inventory, request, model and scope when they
  start ([data lifecycle](data.md)). Memory needs the same treatment so a
  review can be explained later.
- The owner set a target of at least 90% cached input per review
  ([fast initial review](research/fast-initial-review.md)). `packetReviewPrompt`
  in `backend/review/prompts/review-prompt.ts` builds the system instructions,
  and every sheet conversation in a parallel review shares them. Any firm text
  added there must be identical across those conversations and change only when
  the playbook changes.
- Retrieved source text, drawings and tool results are untrusted evidence,
  never instructions. Text that memory extracts from drawings is the same kind
  of data.
- In a parallel review, a sheet reviewer can record coverage only for its own
  sheet, and the coordinator compares facts across sheets
  ([review runtime](review-runtime.md)). Memory search reads outside the packet,
  so sheet reviewers can use it without breaking that rule.
- Push to cloud copies the whole workspace and replaces it with the returned
  result. Local writes are fenced while the cloud owns the run ([data lifecycle](data.md#sync)).
- Meta's Model API exposes Responses, Chat completions, Messages, Files, Models
  and Status. It has no embeddings endpoint
  ([API reference](https://dev.meta.ai/docs/api-reference/), checked 2026-10-30).
- The packaged backend is a `bun build --compile` executable, so native addons
  and their shared libraries need explicit packaging. transformers.js 4.x does
  not run inside such an executable without patches because it statically
  imports `onnxruntime-node` and `sharp`
  ([transformers.js #1672](https://github.com/huggingface/transformers.js/issues/1672), May 2026).
- Today the only reviewer signal on a packet finding is the Completed checkbox
  (`CompletePacketFinding` in `src/lib/review/packet.ts`). There is no way to
  dismiss a finding or say why, so the learning loop needs a new RPC.
- `PacketReview.projectConfiguration` is a free-form string map written by
  `record_project`. Comparing projects requires normalizing it.

Two local probes on Bun 1.4.4 under Linux: the bundled SQLite 3.53.4 created and
queried an FTS5 table with the porter tokenizer, and a plain TypeScript cosine
scan of 100,000 random 512-dimension float32 vectors took 50 ms on one thread.
20,000 vectors took 15 ms. FTS5 on the macOS and Windows builds was not probed.

## What MOKE takes from memory research

The [agent memory notes](research/memory-sota-notes.md) cover the products,
papers, benchmarks and attacks, with sources. Public memory benchmarks measure
recall of personal chat history, not organizational or visual knowledge, and
their leaderboards are unreliable: an audit found 6.4% of LoCoMo's answer key
wrong, and Mem0's self-reported 92.5 on it was 61.4% in a matched third-party
run. "State of the art" for MOKE therefore means adopting the practices with
measured support and evaluating them on MOKE's own task.

| Practice                                        | Evidence                                                                                                                                                                                                      | Use in MOKE                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Keep raw records unchanged; derive the rest     | Mem0 moved to add-only writes in April 2026 because overwrites and deletes lost information. Zep keeps raw episodes as a lossless layer. HaluMem measured 5% to 62% correct updates across memory products.   | Source pages, review records and decisions are append-only. Cards, clusters and proposed rules are rebuildable. |
| Edit learned rules in small deltas              | ACE measured a context collapsing from 18,282 to 122 tokens in one rewrite, falling below the no-memory baseline. Its itemized bullets with counters gained 10.6% on agent tasks and 8.6% on finance tasks.   | The playbook is numbered rules with counters. Consolidation proposes per-rule edits, never a rewrite.           |
| Separate validity time from record time         | Zep's Graphiti stores when a fact held and when it was recorded, and invalidates instead of deleting. MemoryAgentBench found no method above 28% at forgetting outdated facts that need multi-step reasoning. | Superseded details and code editions keep history and stop ranking as current.                                  |
| Fuse several retrieval signals                  | Zep, Mem0's 2026 algorithm and the IRPAPERS study all fuse lexical and dense signals. On IRPAPERS, text and image retrieval failed on different queries, and fusion beat both.                                | FTS5, visual and project-similarity rankings fused with reciprocal rank fusion.                                 |
| Retrieve drawings visually                      | On DOT standard plans, patch-level visual retrievers reached 91% to 95% recall at 5 against 37% for OCR text. For identifiers such as sheet numbers, OCR with keyword search won.                             | Visual retrieval for conditions, FTS5 for sheet and detail identifiers and note text.                           |
| Let the agent search                            | Letta's agent with plain file search scored 74% on LoCoMo without specialized memory machinery.                                                                                                               | Precedent retrieval is a tool the reviewing model calls, and it compares results itself.                        |
| Consolidate in the background                   | Letta's sleep-time agents cut test-time compute about fivefold at equal accuracy on its benchmarks.                                                                                                           | Consolidation runs after a review, never on the review path.                                                    |
| Learn from experience only with a quality check | ReasoningBank, Agent Workflow Memory and ACE mostly gained single-digit to low double-digit points, on tasks with an automatic success signal. Agents copy similar stored records, so stored errors spread.   | Only reviewer-dispositioned findings become precedent. Unreviewed model findings stay out.                      |
| Load procedure on demand                        | Anthropic's Agent Skills keep a name and description in the prompt and load the body when needed.                                                                                                             | The prompt carries rule statements. Examples and rationale come through the search tool.                        |

The evidence conflicts on one point MOKE has to settle by measurement. Some
studies find that distilled rules transfer better than raw examples, and others
find that agents reuse raw records better than the skills distilled from them.
MOKE keeps both, approved rules and dispositioned examples, and the evaluation
compares them.

Memory poisoning is practical. In the MINJA study, ordinary queries led an agent
to write attacker-chosen records into its own memory 98% of the time.
MemoryGraft planted fake "successful experiences", which is exactly what a
"similar prior work" feature would retrieve. The defenses that did best keep
provenance in the platform instead of asking the model to judge trust, but only
their authors have tested them. OWASP's 2026 agentic Top 10 lists memory
poisoning and recommends source attribution, validated writes, per-tenant
namespaces and preventing an agent's own output from re-entering trusted memory.

## Memory model

### Four kinds of memory

| Memory           | What it holds                                                                                                                                     | Written by                                                 | Approval                                                          | Used during a review                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| Firm library     | Detail, note block, schedule, title block, sheet and calculation records from firm standards and from projects the firm opts in                   | Ingestion pipeline                                         | None to index. Marking an item as a firm standard needs approval. | Precedent search and side-by-side comparison              |
| Review history   | Findings, reviewer decisions with reasons, suggestion decisions, agency comments and their closure                                                | Host, from review records and the new disposition commands | None. These are records of past events.                           | Recurring-comment leads and repeated false-alarm warnings |
| Firm playbook    | Numbered rules: review checks, drafting and sheet standards, calculation methods, preferred details and suppressions, each with a scope           | A person, or a consolidation proposal a person approves    | Required                                                          | Stable system-instruction block for in-scope reviews      |
| Project profiles | Normalized jurisdiction, permit stage, occupancy, construction type, sprinkler status, building use, size, code editions, client and project date | Host from `record_project`, with a model normalizing terms | Reviewer can correct                                              | Similar-project ranking and rule scoping                  |

Jurisdiction knowledge is split across these. Agency comment patterns live in
review history. Adopted code editions live in project profiles with dates.
Official sources MOKE already retrieved can be offered again as leads, but each
review still records its own citation and applicability.

### Scope and time

Every item carries a scope: the whole firm, one client, one jurisdiction, or a
single project. Retrieval filters by the current project's client and
jurisdiction, so a client-restricted precedent never appears on another
client's review.

Items also carry two kinds of time, following the bi-temporal model used by
Zep's Graphiti. Validity time says when something was true in the world, for
example when a standard detail was current or a code edition was adopted.
Record time says when MOKE learned or retired it. A superseded standard detail
keeps its history and stops ranking as current. A review of an older permit can
ask what was current at that permit's date.

### Records

Firm memory gets its own database, `memory.sqlite`, in the same data directory
and under the same ownership lock. A sketch of its first migration:

```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('detail','note_block','schedule','title_block','sheet',
    'calculation_method','finding','agency_comment','rule','project_profile')),
  scope TEXT NOT NULL CHECK (json_valid(scope)),
  status TEXT NOT NULL CHECK (status IN
    ('indexed','reference_only','firm_standard','proposed','approved','retired')),
  valid_from TEXT, valid_to TEXT,
  -- Record time as event sequences, so a review can read memory as of its snapshot.
  recorded_seq INTEGER NOT NULL, retired_seq INTEGER,
  superseded_by TEXT REFERENCES memory_items(id),
  trust TEXT NOT NULL CHECK (trust IN ('approved','reviewer','source','model')),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
-- Where each item came from; deleting a source removes what it produced.
CREATE TABLE memory_provenance (
  item_id TEXT NOT NULL REFERENCES memory_items(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('library_pdf','project_sheet','packet_review','disposition','consolidation','manual')),
  source_ref TEXT NOT NULL CHECK (json_valid(source_ref)),
  sha256 TEXT
);
CREATE TABLE memory_edges (
  from_id TEXT NOT NULL REFERENCES memory_items(id),
  to_id TEXT NOT NULL REFERENCES memory_items(id),
  relation TEXT NOT NULL CHECK (relation IN
    ('used_in','derived_from','supersedes','applies_to','contradicts','same_condition')),
  valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation, recorded_at)
);
CREATE VIRTUAL TABLE memory_text USING fts5(
  item_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61'
);
-- One row per item and embedding space, e.g. 'colmodernvbert@<model sha256>'.
-- Late-interaction spaces store one pooled vector plus the patch vectors.
CREATE TABLE memory_vectors (
  item_id TEXT NOT NULL REFERENCES memory_items(id),
  space TEXT NOT NULL, dims INTEGER NOT NULL, count INTEGER NOT NULL,
  pooled BLOB NOT NULL, patches BLOB,
  PRIMARY KEY (item_id, space)
);
-- Append-only log of every memory write; later the unit of firm sync.
CREATE TABLE memory_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, item_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('host','model','reviewer')),
  payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL
);
CREATE TABLE playbook_revisions (
  revision INTEGER PRIMARY KEY, created_at TEXT NOT NULL, approved_by TEXT NOT NULL,
  rule_ids TEXT NOT NULL CHECK (json_valid(rule_ids)), sha256 TEXT NOT NULL
);
```

Review-side records stay in `app.sqlite`, where the reviews live: finding and
suggestion dispositions, and each review's memory snapshot. Dispositions are
copied into `memory.sqlite` as events after they are saved.

Records fall into two groups. Source records are never changed: imported
pages and their text, review records, dispositions and agency comments. Derived
records can be rebuilt from them: detail cards, vectors, clusters, statistics
and proposed rules. Each derived record names the prompt or model version that
produced it, so a better card prompt can regenerate cards without losing the
source. Deleting a source removes it and rebuilds the views that depended on
it. Zep documents that deleting an episode does not regenerate the summaries
built from it; rebuilding avoids that gap. Approved rules are the exception: a
rule that loses its evidence is flagged for review instead of silently changed.

The `trust` column records where an item came from: approved by a person,
dispositioned by a reviewer, taken from a source document, or written by the
model without review. Retrieval ranks by trust. Model-written items never count
as precedent until a reviewer dispositions them.

The relations form a small typed graph inside SQLite. A dedicated graph
database would add a second storage engine for a graph that ordinary joins on
`memory_edges` can serve at this size.

### Why a separate database file

- **Different lifetime.** Firm memory spans projects and should survive project
  deletion, package restore and cloud result replacement.
- **Cloud reviews.** The push sends a consistent backup of `memory.sqlite` and
  the artifacts it references as read-only input. The worker never returns it.
  Learning from a cloud review happens locally after the result syncs, so a
  cloud run cannot overwrite memory edits made meanwhile.
- **Sharing.** A firm memory pack is a backup of one file plus its artifacts,
  which matches the existing complete-package approach.

The cost is a second migration track, its own pre-migration backups, and
including the file in the ownership lock and maintenance drain. A review reads
memory only through its frozen snapshot, so the review path needs no write
access to `memory.sqlite`. Retrieval logging goes into the review's own tool
receipts in `app.sqlite`.

## Ingestion

### Sources

1. **Firm standards import.** A new import accepts standard detail sheets, CAD
   and drafting manuals, QA/QC checklists and calculation templates as PDFs. It
   reuses the PDF worker and stores originals and crops in the content-addressed
   artifact store.
2. **Opted-in projects.** A project setting, "Contribute to firm memory", with a
   client scope. It is off by default until the firm decides its
   confidentiality rules. When on, MOKE indexes the project's latest revision.
3. **Review records.** Every finished packet review contributes its findings,
   dispositions, prior agency comments and project profile.

### Details

Detail sheets usually show a grid of details, each with a callout bubble, a
title, a scale and a frame. MOKE already extracts the PDF text layer with
positions in `backend/documents/pdf-worker-main.ts`, currently only to suggest
sheet labels.

1. **Find candidates without a model.** Search the text layer for detail title
   patterns: `SCALE:` strings, callout references such as `5/S-501`, and title
   text near them. Use frames from the vector line work where present.
2. **Confirm with Muse.** Render the sheet and send the candidate boxes. Muse
   accepts, merges or rejects candidates and returns a detail card for each
   through structured output. This is one request per detail sheet, recorded in
   the attempt ledger before dispatch like every other model call. Published
   evaluations find vision models poor at drawing bounding boxes, so a region
   Muse proposes on its own, as on a scanned sheet, snaps to nearby frames and
   text clusters and is marked lower confidence.
3. **Index.** Write the card and verbatim text to FTS5, and the crop's vectors
   to `memory_vectors`. Also index the whole detail sheet: PlanSightRAG found
   that tiling alone lost cross-references when a note and its detail fell in
   different tiles, and indexed full pages alongside tiles.

A detail card holds: the title as printed, callout and sheet IDs, scale,
discipline, a one-sentence description of the condition the detail resolves,
the applicability facts a reviewer needs to judge reuse, such as fire rating and
any seismic or wind criteria shown, components and materials, listed assemblies and product approvals such as UL
design or Florida product approval numbers, standards and editions printed on
the detail, keynotes, the verbatim note text, advisory MasterFormat sections,
and the model's confidence. Card text comes from drawings, so it is untrusted
data.

### Sheets and title blocks

For each indexed sheet, record the sheet number format, title, scale notation,
revision block, title block fields and their positions. Aggregated across a
firm's projects, these show its sheet conventions, for example that sheet IDs
follow the discipline-designator, sheet-type and sequence pattern. MOKE proposes
such conventions as playbook rules. Once approved, simple ones run as
deterministic checks during review, such as a sheet number pattern or a missing
title block field.

### Calculations

MOKE already records calculations with an expression, named inputs, units and a
result. Memory stores calculation methods taken from firm calculation packages
and earlier reviews: a name, the expression, the inputs it needs with expected
units, and the governing source it was used with. A method can be suggested, for
example the firm's battery standby calculation, but it carries no numeric limit.
The limit must come from a citation recorded in the current review, which
keeps "do not reuse a historical job's threshold" enforceable.

### Project profiles

Normalize `record_project`'s free-form values into a `ProjectProfile` schema:
a canonical jurisdiction, permit stage, occupancy groups, construction type,
sprinkler status, stories, area, building use, code editions by volume, client
and project date. The model proposes the normalization from the recorded values;
the reviewer can correct it in project settings.

## Retrieval

`search_firm_memory` accepts query text, an optional sheet and region from the
current packet, kinds, a discipline, and a limit of at most eight. Queries come
in three forms, and each favors a different signal:

- **Condition queries**, such as "CMU parapet with metal coping at a low-slope
  roof". The reviewing model writes this description after reading the current
  detail. Patch-level visual retrieval and card text both apply.
- **Identifier queries**, such as `5/S-501`, a UL design number or a product
  approval number. FTS5 over the verbatim text layer is the right signal; the
  Blueprint study found OCR with keyword search beat visual retrieval for
  identifiers.
- **Copy checks**, where the region itself is the query. A near-duplicate
  search with Perception Encoder vectors, or a perceptual hash, looks for the
  same drawing in the library. Copies are close to pixel-identical, which is a
  much easier problem than finding a different drawing of the same condition.

The host then:

1. Filters by scope, trust, status, validity at the project's date, the
   review's memory snapshot, kind and discipline.
2. Ranks candidates by FTS5 `bm25()` over card and text-layer content, by
   visual similarity, and by text vectors when enabled. Visual ranking has two
   stages: cosine similarity on one pooled vector per item selects a few hundred
   candidates, then late-interaction scoring over patch vectors reorders them.
3. Fuses the rankings with reciprocal rank fusion.
4. Raises firm standards, reviewer-trusted items and items from similar
   projects. Lowers superseded and reference-only items.
5. Returns compact cards: item ID, kind, title, source project and sheet label,
   date, status, trust, code edition, match reasons such as "same condition
   text: parapet coping" or "same jurisdiction and occupancy", and a thumbnail
   artifact ID. Card text is wrapped as quoted source data.
6. Adds applicability differences to each card. The host compares the
   precedent's project profile with the current one and lists what differs, for
   example "Precedent: Miami-Dade, seismic design category D, 2020 FBC. Current:
   Tampa, category A, 2023 FBC." This targets the most common reuse failure
   found in the AEC research.

`open_precedent` renders a precedent's crop into the conversation, so Muse can
compare it with the current detail. The image counts against the conversation's
image budget, including Baseten's eight-image window. The model's comparison is
the final reranking step, which avoids shipping a separate reranker model.

Project similarity is a weighted attribute match, so its reasons can be shown.
Jurisdiction and code editions weigh most for code-related memory. Occupancy,
construction type and building use weigh most for details.

Plain TypeScript search is enough at firm scale. A firm with 200 projects of 60
sheets and 6 details each has about 72,000 items, under the 100,000 pooled
vectors scanned in 50 ms locally. Late-interaction scoring runs only on the
first stage's candidates. Patch vectors are large: ColPali uses about 257 KB per
page at fp16. Detail crops have fewer patches, and published pooling and
binarization methods cut storage severalfold at small quality cost. A
`VectorIndex` service keeps the option of moving to `sqlite-vec`, which the
pinned Effect SQLite client can load, without changing callers. On macOS that
extension also needs a custom SQLite library.

## Use during a review

1. **Snapshot.** `StartPacketReview` freezes the playbook revision, the memory
   event sequence and the in-scope rule IDs. `PacketReview` gains a `memory`
   field. The report states which firm knowledge was in effect.
2. **System instructions.** `packetReviewPrompt` adds a block titled
   "Firm practices, playbook revision N" after the discipline files. It lists
   approved in-scope rules with their IDs, capped at about 3,000 tokens; the
   rest remain reachable through the search tool. The coordinator and every
   sheet reviewer receive the same text, which keeps the shared cached prefix.
3. **Coordinator setup.** When the coordinator calls `record_project`, the host
   finds similar projects and recurring agency comments for the jurisdiction and
   returns a short "Firm history" block in that tool result. The coordinator
   passes relevant leads to the coordination stage. This block depends on the
   project, so it stays out of the system instructions.
4. **Sheet reviewers.** They get `search_firm_memory` and `open_precedent`.
   After `render_sheet`, the host may add up to three high-confidence precedent
   hints to the tool result. This stays off until the evaluation shows the hints
   are precise.
5. **Recording.** A new `record_suggestion` tool writes a `PacketSuggestion`.
   Findings gain optional `ruleIds` and `precedentIds`. A new finding
   classification, `Firm standard`, covers deviations from an approved rule and
   requires at least one rule ID. The host rejects memory IDs in `citationIds`
   or `evidenceIds`.
6. **Repeated false alarms.** When `record_finding` runs, the host compares the
   finding with findings the firm's reviewers dismissed in the same discipline
   and scope. On a match, the tool result returns the earlier reason and asks the
   model to reconsider. The host does not block the finding.
7. **Copied details.** When a crop from the current set is a near duplicate of a
   library detail, and the applicability differences include seismic category,
   jurisdiction, code edition or fire rating, the search result says so. The
   model inspects both and records a finding or suggestion only if the copied
   content conflicts with the current project.

```ts
export const PacketSuggestion = Schema.Struct({
  id: Id,
  kind: Schema.Literals([
    "precedent_detail",
    "firm_standard",
    "recurring_agency_comment",
    "calculation_method",
    "sheet_standard",
  ]),
  title: Required,
  discipline: ReviewDiscipline,
  locations: Schema.Array(
    Schema.Struct({ sheetId: SheetId, detail: Required, region: Schema.NullOr(Region) }),
  ),
  rationale: Required,
  /** Conditions the reviewer must confirm before reusing the precedent. */
  applicability: Required,
  precedentIds: Schema.Array(MemoryItemId),
  ruleIds: Schema.Array(RuleId),
  evidenceIds: Schema.Array(ArtifactId),
  disposition: Schema.Literals(["proposed", "accepted", "dismissed"]),
});
```

The conversation summary shows suggestions as a compact "From your firm's work"
group after the findings. Opening one shows the current region and the
precedent side by side in the central canvas, with Accept and Dismiss. The HTML
report gets the same section, with both crops, the precedent's project and date,
and a label telling the reader to confirm applicability.

## Learning loop

### Signals

- **Finding decisions.** A new `DispositionPacketFinding` RPC records valid,
  false alarm, not our practice, duplicate, wrong severity or edited, with an
  optional reason, the person who made the decision, and a scope to remember it
  at: this review, this project, this client, this jurisdiction, or the firm. The scope choice comes from the Gradon
  discussion.
- **Suggestion decisions** through `DispositionPacketSuggestion`.
- **Steering messages and follow-up corrections** in the conversation.
- **Agency comments** recorded with `record_prior_comment` on resubmittals.
- **Missed issues** a reviewer adds by hand. This needs a manual finding entry,
  which MOKE does not have yet.
- **Completed checkboxes**, a weak sign that a finding led to a correction.

### Updates without a model

- Rule counters: times applied, times cited by an accepted finding, times cited
  by a dismissed finding.
- Agency comment clusters by jurisdiction and discipline, with counts across
  projects.
- An index of dismissed findings with their reasons and scopes.
- Detail reuse counts. Near-duplicate details are clustered by image similarity
  and title. A detail that recurs across many of the firm's projects becomes a firm
  standard candidate. Pirros's guide uses a similar test: a detail appearing
  five or more times across a firm's 10 to 25 best projects.

### Consolidation

After a review is finished and its findings are dispositioned, or when the user
chooses "Learn from this review", a consolidation run reads the review records,
the decisions and related memory. It proposes operations: add a rule with
evidence and scope, update or narrow a rule, retire a rule, mark a precedent as a
firm standard candidate, or do nothing. Proposals go to a learning inbox and are
never applied without approval.

The run proposes small numbered edits instead of rewriting the playbook, and it
checks new proposals against existing rules for duplicates. It runs as a Pi
Durable conversation so its model calls get the same intent ledger and receipts
as reviews. It proposes a rule only from repeated evidence, such as the same
dismissal reason in two reviews, or from a reviewer who chose the firm scope.

### Approval

The playbook editor shows each rule's text, scope, kind, examples, provenance and
counters. Approving changes creates a new playbook revision. Retired rules keep
their history. In a single-user desktop, the local user approves. A shared firm
memory needs roles, which depends on the authentication decision below.

## Governance

- **Lead, not evidence.** Enforced by the host as described above. Suggestions
  and the report keep MOKE's statement that model findings are not professional
  approval.
- **Untrusted content and poisoning.** Card text is returned as delimited,
  quoted data in tool results. Text from a drawing can reach the system
  instructions only as part of a rule a person approved, so a planted note
  cannot become an instruction on its own. Provenance and trust are set by the
  host, never by the model. MOKE's own findings re-enter memory only after a
  reviewer dispositions them, following OWASP's guidance against re-ingesting an
  agent's own output. Consolidation proposals show the source records behind
  each rule, because merging and summarizing are where provenance gets lost.
- **Confidentiality.** Scopes filter retrieval by client. Project contributions
  are off by default. Following Pirros, a project can contribute as reference
  only: its details appear as leads but cannot become firm standards without
  approval.
- **Responsibility.** Every precedent suggestion says that adapting it requires
  the current project's code research, consistent with the NCEES Model Rules.
- **Retention.** The firm sets how long dismissed findings and review comments
  are kept. One 2018 QA paper recommends destroying commented review sets after
  recording that the review happened, while regulators such as Engineers and
  Geoscientists BC require documented checks. MOKE should not assume either.
- **Deletion.** Removing a source deletes the items it produced, found through
  provenance, rebuilds the derived views, and flags rules whose only evidence
  came from it. Vectors are deleted with their text, because embedding inversion
  can recover much of the original text.
- **Staleness.** Superseded standards get a `valid_to` date. Cards show the code
  edition and the date last used.
- **Audit.** `memory_events` records every write, and each review records the
  snapshot it used.

## Firm sharing

**Phase 1 runs on one machine.** Memory packs export and import a versioned
directory with a consistent backup of `memory.sqlite`, its artifacts and a
manifest with hashes, like complete packages. Import merges by stable IDs.
Imported rules arrive as proposals unless the importer approves them.

**A shared firm memory needs a server and accounts.** The append-only
`memory_events` log and content-addressed artifacts are designed so a later
server can sync them. Gradon made this choice by storing the Firm Brain in its
cloud for the whole team. MOKE's authentication is still undecided in
`.project-kit/manifest.json`.

## Evaluation

Public memory benchmarks test conversational recall, and neither research note
found a public benchmark for retrieving similar typical details, so MOKE needs
its own evaluation. It follows methods with published precedent: score each
memory operation separately, as HaluMem does; replay data in time order; include
superseded facts and cases where the right answer is to suggest nothing; hold
the answer model fixed across variants; and check any model judge against
answers known to be wrong. Nomic's Apache-2.0 AEC-Bench can separately check
that memory does not weaken MOKE's ordinary drawing review.

1. **Ingestion.** Detail detection precision and recall against hand-marked
   sheets, and card field accuracy for title, callout, scale and listings.
2. **Retrieval.** At least 50 condition queries, 30 identifier queries and 30
   copy checks with known answers, plus queries with no correct match. Report
   recall at 5 and mean reciprocal rank for FTS5 alone, each visual candidate
   alone, and the fused ranking. Turn on precedent hints only after fused recall
   at 5 reaches an agreed threshold, proposed at 0.8, with few suggestions on the
   no-match queries.
3. **Replay.** Order a firm's projects by date. Review project N with memory
   built only from earlier projects, and compare with a review without memory:
   agency comments predicted that the jurisdiction later issued, repeated false
   alarms, firm-standard deviations caught in seeded defects, copied details
   caught in seeded copies, suggestion acceptance, cost and cached-input share.
   Run it three ways: approved rules only, dispositioned examples only, and
   both, to settle the rules-versus-examples question for MOKE.
4. **Regressions.** Memory must not lower finding precision or drop cached input
   below 90%.
5. **In use.** Show acceptance and dismissal rates per suggestion kind and per
   rule in the playbook editor.

This needs at least one firm's past projects with their agency comment letters
and its standard details.

## Implementation phases

Each phase ends with `bun run verify` and updates to [data lifecycle](data.md),
[review runtime](review-runtime.md) and [PRODUCT.md](../PRODUCT.md).

**Phase 0: contracts, evaluation set and embedding spike.**

- Shared schemas in `src/lib/memory/contracts.ts`: memory items, detail cards,
  playbook rules, project profiles, suggestions, dispositions and a
  `FirmMemoryRpc` group.
- Retrieval fixtures from the sanitized drawing pack, with an FTS5-only
  baseline.
- Embedding spike. Candidates: ColModernVBERT for condition retrieval,
  Perception Encoder S/16 for copy checks, and Qwen3-Embedding 0.6B for text.
  The research found no published ONNX export of ColModernVBERT or Perception
  Encoder, so the spike includes exporting them. Run each in a worker subprocess launched by the
  compiled backend on Windows, macOS and Linux, once with `onnxruntime-node` and
  once with the WASM build of ONNX Runtime. Open Bun issues report
  `onnxruntime-node` crashes on Windows and under `bun test` in Bun 1.3; nothing
  has been reported for 1.4. Measure time per crop, memory and package size, and
  score each model on the retrieval set. Gate: a model ships only if it runs on
  all three platforms and beats FTS5 alone. Otherwise MOKE ships FTS5 retrieval
  first and adds vectors later.
- Confirm FTS5 in the Windows and macOS builds with `PRAGMA compile_options`.

**Phase 1: firm library and precedent search.**

- `migrations/memory/0001_firm_memory.sql`, with `MemoryStore`, `MemoryIndex`
  and `Embedder` services and Layers, plus a deterministic test embedder.
- Firm standards import, detail candidates, detail cards through Muse.
- `search_firm_memory`, `open_precedent` and `record_suggestion`, a `memory`
  activity stage labelled "Checking firm precedents", the review snapshot, the
  report section and the side-by-side canvas.
- Tests on real SQLite with the deterministic embedder and a recorded provider,
  plus an Electron flow with a synthetic standards PDF.

**Phase 2: decisions and playbook.**

- Disposition RPCs and controls, including the remember scope.
- Playbook editor, manual rules, approved rules in `packetReviewPrompt`, the
  `Firm standard` classification and repeated false-alarm warnings.
- Project profile normalization and similar-project ranking.
- Copy checks with applicability differences, using a perceptual hash first and
  Perception Encoder vectors if the spike passes.

**Phase 3: learning.**

- Agency comment clusters and the coordinator's firm history block.
- Consolidation runs, the learning inbox and rule counters.
- The replay evaluation, recorded in `docs/research/`.

**Phase 4: sharing.**

- Memory packs, then a firm server once authentication is chosen.

## Decisions needed

1. **Where shared firm memory lives.** Local packs first, which the plan
   assumes, or a firm server now, which requires choosing authentication.
2. **Default for project contributions.** Off per project, which the plan
   assumes, or on for every project.
3. **Hackathon scope.** Whether firm memory belongs in the submission. If so,
   only Phase 1 is realistic.
4. **Evaluation data.** Whether you can supply past projects with agency comment
   letters and a firm's standard details.
5. **The `Firm standard` classification.** Add it to findings, or keep firm
   deviations as suggestions only.
6. **Retention of review history.** How long dismissed findings and agency
   comments stay searchable, given the discovery concern above.

## Open questions and risks

- Visual retrieval of similar details is unmeasured on firm drawings. The
  strong drawing results are text questions over DOT standard plans, and
  generic image encoders did poorly at image-to-image drawing similarity in the
  studies found. Copy checks should be easier, but they are also unmeasured.
- Detail segmentation accuracy on real sheets is unmeasured.
- Whether approved rules or dispositioned examples help more is contested in
  the literature, and no controlled study shows that human approval of learned
  rules improves results. The replay evaluation tests both for MOKE.
- Several sources behind this plan are 2026 preprints without replication,
  including PlanSightRAG and the poisoning defenses.
- FTS5 was confirmed only in Bun's Linux build.
- Packaging ONNX Runtime with the compiled backend is unproven here.
- Ingestion uses model calls, about one per detail sheet. Large libraries need
  batching and a budget.
- Firms differ on how far precedent may cross client boundaries. The scope model
  supports restrictions, but the defaults need the firm's input.
