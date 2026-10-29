# Moke review instructions

`assets/` contains unmodified files from `sc-frederick/skills/moke-review` at
revision `8a0e2648738018631eaa6d24ee0b6ebaa239afb1`. `provenance.json` records
the upstream paths and SHA-256 hashes. Read the original skill repository to
update them; this application does not edit that source repository.

`review-prompt.ts` imports the files with Bun's text loader, embedding them in the
compiled backend. Packet review version `moke-packet-review-v1` supplies the full
master AGENTS.md and REVIEW_METHOD.md, including Report and release, as Pi
Durable's conversation `agent.instructions`. The reviewer request and document
inventory are separate input data. Each run records the prompt version and
instruction revision.

A whole-set review includes General and every discipline file. A selected
discipline includes General and its own file. Fire Alarm, Fire Sprinkler, Life
Safety and Fire Protection keep their separate responsibilities. The model works
through the supplied packet and records its actual coverage; it is not restricted
to one count finding or two sheets.

The host registers tools for packet inventory, original-PDF pages and crops,
public-source discovery and text retrieval, repeatable calculations, project
configuration, findings, citations, coverage and prior-comment tracking. SAM can
provide geometric observations when Meta is configured, including when the chat
model uses Baseten. Model and SAM requests share durable admission and receipt
records. An optional user call budget pauses work; there is no separate two-SAM
cap in packet review.

Official-source retrieval retains the URL, access status, content hash and text.
Verified citation records require retrieved official text, an exact quote,
edition, section and applicability. Search results alone do not verify a claim.
Login requirements, inaccessible sources and unknown governing inputs remain
unverified or Needs input. The text lookup does not extract remote PDF sources;
import PDF documents for visual inspection and obtain readable governing text
before marking a citation verified. Retrieved documents and tool output remain
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
