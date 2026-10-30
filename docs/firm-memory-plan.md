# Firm memory: what MOKE remembers now and what waits

Decided 2026-10-30. MOKE should learn each engineering firm's way of working:
its details, calculation methods, sheet standards and review habits. One example
is suggesting a detail the firm used on a similar project. A full firm memory
system was researched and designed, and then deferred. MOKE ships three smaller
pieces that improve the current findings and revisions workflow and the
requirements pass, and that collect the data a later memory system would need.

Sources: the MOKE code at `8e94b578a`, the T3 thread "How Gradon Builds Its Firm
Brain" (2026-10-17), [agent memory research](research/memory-sota-notes.md),
[AEC firm knowledge research](research/aec-firm-knowledge-notes.md) and the
Audit 3 records.

## What MOKE remembers now

| Piece              | What the reviewer or firm does                                                 | What later reviews get                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding decisions  | Marks a finding valid, false alarm, not applicable or duplicate, with a reason | Follow-ups in the conversation receive the decision and reason, and are told not to raise a dismissed issue again without new evidence. The report shows each decision. |
| Firm checklist     | Writes the firm's own checks in Review settings; each save is a revision       | New reviews apply the checklist as firm practice. A deviation is a Recommendation unless a verified governing source makes it a code issue.                             |
| Jurisdiction leads | Nothing; the reviewing model records the project's jurisdiction as before      | Sources, citations, recorded code editions and agency comments from earlier reviews in the same state or county/city, labeled as leads                                  |

All three keep MOKE's rule that past work can suggest a check but only the
current documents and governing sources establish a finding. Decisions and the
checklist are written by people. Jurisdiction leads come from earlier reviews
and never become the new review's sources, citations or prior comments; the
model must read a source again before citing it. See
[review runtime](review-runtime.md#what-later-reviews-learn-from-earlier-ones)
and [data lifecycle](data.md) for how each is stored and used.

## Why the full system waits

- **The base review is still settling.** In Audit 3, single-conversation
  full-set reviews recorded a fraction of their required checks: Brewery 7 of
  1,276, Laundry 16 of 572, Porch 29 of 396 and Civil 31 of 176
  ([Audit 3 validation](research/audit-3-validation.md)). Parallel sheet review
  has since recorded 1,276 of 1,276 Brewery checks on this computer and 1,246
  in the cloud ([parallel sheet review](research/parallel-sheet-review.md),
  [fast initial review validation](research/fast-initial-review-validation.md)),
  but those runs cover one drawing set. Reading accuracy is still a limit: the
  recheck found reviews calling complete tables "not located" or "clipped"
  because the model's own crop cut them off
  ([Audit 3 recheck](research/audit-3-recheck.md), M3-18). Agent memory studies
  found that agents copy similar stored records, so stored mistakes spread.
- **There was nothing to learn from.** Reviewers could only tick Completed.
  Learning firm practice also needs a firm's past projects, comment letters and
  standard details; MOKE has sanitized sample sets.
- **The expected gain is modest and unmeasured for drawings.** Learning from
  experience added +10.6% (AppWorld) and +8.6% (finance) in the ACE study, on
  tasks with an automatic success signal. Retrieval of similar AEC details has
  no public benchmark.
- **Shipped products mostly use checklists.** UpCodes, Groundbook, Structured AI
  and others apply uploaded firm checklists. Claims that a product learns from
  reviewer corrections (SWAPP, Pirros, Pelles) had no independent test.
- **The cost is large.** A second database, a local embedding worker that is
  unproven inside the compiled Bun backend, model calls to index detail sheets,
  and playbook and approval screens.

## Deferred design

The deferred design had four kinds of memory: a firm detail library, review
history, an approved firm playbook, and project profiles. It retrieved
precedents with SQLite FTS5 plus a patch-level visual retriever such as
ColModernVBERT, proposed playbook edits from reviewer decisions for a person to
approve, and froze a memory snapshot at review start. The research notes above
keep the evidence, and the design is in this document's history in the pull
request that replaced it.

Revisit it when all of these hold:

1. Full-set reviews finish their required checks across several drawing sets.
2. Saved finding decisions show repeated false alarms or firm-specific issues
   across projects.
3. A firm supplies past projects with agency comment letters and its standard
   details, so retrieval can be measured.

Start then with a retrieval test on that firm's data: FTS5 alone against FTS5
with a visual retriever, run inside the compiled backend on Windows, macOS and
Linux.
