# Moke review instructions

`assets/` contains unmodified files from `sc-frederick/skills/moke-review` at
revision `8a0e2648738018631eaa6d24ee0b6ebaa239afb1`. `provenance.json` records
the upstream paths and SHA-256 hashes. Read the original skill repository to
update them; this application does not edit that source repository.

`review-prompt.ts` imports the files with Bun's text loader, embedding them in the
compiled backend. Packet review version `moke-packet-review-v7` supplies the full
master AGENTS.md and REVIEW_METHOD.md, including Report and release, as Pi
Durable's conversation `agent.instructions`. The reviewer request and document
inventory are separate input data. Each run records the prompt version and
instruction revision.

`finding-style.md` is application-owned guidance, embedded in every packet
reviewer's instructions for both Meta and Baseten, including coordinator and
sheet roles. It uses the short Sonnet 5.5 rewrites in
`docs/research/meta-vs-sonnet-unslop-findings.md`, rows 28, 36 and 41, as wording
examples. The calculation example expands the circuit abbreviation; a fourth
example illustrates an uncertain reading. The comparison is a style reference,
not a technical validation of those earlier findings.

The authoritative contract is `src/lib/review/finding-summary.ts`. A display
title has at most 80 characters and 12 words; the observation and correction each
have at most 320 characters and 45 words, exactly one sentence, and no lists or
line breaks. Corrections start with an action and object. Decimal values, section
numbers and internal engineering units are recognized; ambiguous abbreviations
must be spelled out. Both provider tool schemas publish the character bounds and
the host enforces all checks. Model instructions are generated from these constants.

`record_finding` saves the complete technical text with its existing 32,000-character
capacity, evidence and status. When that exact text already meets the summary
contract, it becomes the display text without rewriting. Otherwise the host saves
a Pending summary revision. `record_finding_summary` supplies short display text
for that specific finding and revision, leaving every original field unchanged.
Updating a finding invalidates its prior summary. Invalid summaries leave the
technical record saved and pending, including when Pi rejects arguments before
the tool executes. Pending summaries block sheet and review finishing, and the
final completion check handles reversed tool order independently. An ignored
request leaves an explicit failed/incomplete review, not a lost finding.

The workbench and HTML report show validated short text first, with full technical
text available under Full technical finding. Old findings without summaries keep
their original presentation. Length checks enforce form, not engineering truth
or semantic completeness: necessary values, conditions and uncertainty must remain
in the short text, and the retained full record and evidence remain reviewable.

The prompt version is retained in review provenance and the cloud engine
handshake. Existing reports remain readable; paused runs from older prompt
versions must start a new review rather than resume with different instructions.
Shipping this change to cloud review also requires a matching worker build.
Already-dispatched protocol-4 jobs using packet prompt v3 can still return their
saved results; that recovery allowance does not admit older workers for new jobs.

Scripted-provider tests exercise actual Meta and Baseten tool calls, rejection,
correction, completion gating and lossless reopening/export. These tests establish
the executable format, not model writing quality or technical correctness.

A whole-set review includes General and every discipline file. A selected
discipline includes General and its own file. Fire Alarm, Fire Sprinkler, Life
Safety and Fire Protection keep their separate responsibilities. The model works
through the supplied packet and records its actual coverage; it is not restricted
to one count finding or two sheets.

The host registers tools for packet inventory, original-PDF pages and crops,
Florida code search, public-source discovery and text retrieval, repeatable
calculations, project configuration, findings, citations, coverage and
prior-comment tracking. Packet review version `moke-packet-review-v6` adds
`search_code`, which searches the [Florida code index](../code-index/README.md),
and PDF text in `read_source`. SAM can
provide geometric observations when Meta is configured, including when the chat
model uses Baseten. Model and SAM requests share durable admission and receipt
records. An optional user call budget pauses work; there is no separate two-SAM
cap in packet review.

Official-source retrieval retains the URL, access status, content hash and text.
Verified citation records require retrieved official text, an exact quote,
edition, section and applicability. Search results alone do not verify a claim.
Login requirements, inaccessible sources and unknown governing inputs remain
unverified or Needs input. The text lookup extracts embedded text from remote
PDFs, starting at a `#page=N` fragment when given; scanned PDFs stay
unavailable. ICC Digital Codes blocks automated retrieval, so a citation to an
indexed ICC section stays unverified until the engineer opens its link. Retrieved documents and tool output remain
evidence, not system instructions.

The model records structured results while the host renders the self-contained
HTML report with embedded evidence and user-owned Completed controls. Findings,
coverage, source status, calculations, prior comments and missing inputs remain
visible. The host checks that cited artifacts belong to the review and that a
sheet image was opened before checked or issue coverage is recorded. Finishing a
run does not establish professional approval or close a user's correction task.

Pi journals and separate provider receipts retain interrupted work. No unknown
provider outcome is automatically resent. Resume is an explicit continuation of
a compatible paused review and can extend its optional call budget. Follow-up
requests in the same conversation carry prior records and stable issue IDs.
Copied package journals remain historical and cannot resume.

The earlier `moke-selected-coordination-v2` adapter remains for existing
selected-count executions. Its narrower tools, limits and scope apply to that
specialized protocol. Packet review uses the full system instructions and its
own project/conversation root. Both paths preserve reviewer acceptance of
engineering count inputs; general model findings and prose do not become
accepted count facts.

Audit 3 adds a page-by-page contradiction search before missing-content claims.
The tool boundary requires current-run inspection of every source page, targeted
inspection at the claimed location, an explicit source search and permit-stage
basis. This is an evidence gate, not proof that model interpretation is correct;
live acceptance still checks the visible source against the released finding.

Packet review `moke-packet-review-v5` adds two host-written blocks. One tells the
model how to treat the reviewer's finding decisions in follow-ups. The other,
present only when the firm saved a checklist, is the checklist text under the
heading "Firm review checklist, revision N". It comes last, after the requested
scope, so reviews with and without a checklist share the cached prefix. The
upstream skill files are unchanged.

Packet review `moke-packet-review-v7` gives each parallel role and stage its own
tool list. Coordinator setup has inventory, rendering, research, project and
citation records, `ask_reviewer` and a new `finish_setup` tool; sheet reviewers
lose `record_project` and report a different project fact in their notes. The
coordinator's guidance describes setup's sheet and request limits. See
[docs/review-runtime.md](../../../docs/review-runtime.md#parallel-packet-reviews).
