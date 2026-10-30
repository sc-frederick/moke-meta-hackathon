# MOKE

<!-- impeccable:product-schema 1 -->

## Platform

web

The project packages its Svelte interface in Electron for desktop use.

## Capabilities and Constraints

Use SvelteKit 3 and Svelte 5 from the project kit. The production workbench imports
PDF packets and starts whole-set or selected-discipline reviews from a project
conversation. A review does not require an existing finding or count check.
Bun and Effect own APIs, SQLite, migrations, PDF processing and Pi Durable
execution. Electron owns the trusted bridge, file dialogs and credential storage.

The full MOKE AGENTS.md, shared review method and applicable discipline files
supply Pi's system instructions. Whole-set review includes the general and all
discipline instructions; a discipline review includes general context and its
selected instructions. The review inventories the supplied documents, reads
source images and details, retrieves public governing text, performs repeatable
calculations, and records findings, coverage, citations and prior comments.
Fire Alarm, Fire Sprinkler, Life Safety and Fire Protection remain distinct.

Whole-set coverage tracks every discipline and all four passes for each supplied
sheet. An excluded discipline needs an explicit Not applicable reason. Follow-up
reviews retain coverage for unchanged sources; a prior comment can close only
after its revised deliverable is inspected in the current review.

Source access and review coverage stay explicit. Inaccessible official text,
unknown governing editions and absent project inputs remain Needs input. A
successful download does not establish applicability of a code requirement.
Calculations retain formulas, input values and declared units; units are not
automatically reconciled. Model findings are review results, not professional
approval. Sequential discipline passes are supported; the app does not claim to
launch parallel reviewers.

The conversation presents a short review summary with compact findings. Opening
a finding shows readable details and source evidence in the central canvas.
Saved self-contained HTML reports retain focused evidence, project configuration,
coverage, source status, findings, calculations and prior-comment follow-up.
Completed checkboxes track user corrections separately from finding status and
reviewer-verified closure. Reviewers can mark a finding valid, a false alarm, not
applicable or a duplicate, with a reason that follow-up reviews read. A firm's own
checklist applies to new reviews as firm practice, and earlier reviews in the same
jurisdiction offer their sources and agency comments as leads, never as evidence.
Unreviewed sheets and unresolved inputs remain visible even when execution
finishes. Complete packages retain original documents, evidence, review records
and execution journals.

Packet reviews default to no application call ceiling. Users can choose an
operational call budget, pause or cancel work, and explicitly extend an exhausted
budget to resume. Model context comes from provider metadata, with automatic Pi
compaction for long conversations. SAM is an optional geometric evidence tool;
it shares the review's durable request ledger and optional call budget.

Drawn-to-schedule count checks remain available as a specialized workflow.
Reviewers accept count inputs and confirm their coverage before deterministic
comparison. Earlier counts, corrections, checks and source correspondences retain
their history. These controls do not constrain ordinary packet review.

## Operating Context

The primary users are AEC engineers, contractors and project managers reviewing
drawings before submittal, during coordination or after revisions. Assume little
interest in model configuration and little patience for unfamiliar computer
workflows. Lead with the imported packet, the requested review, the findings and
the next action. Keep coordinates, model provenance, record identifiers and token
accounting behind disclosures. Use familiar labels and specific explanations.

Both project entry points open the same centered creation dialog. Settings use a
separate centered dialog. PDF imports use a centered drop area and native file
chooser, with a revision label requested for subsequent imports. The composer
names its model, reviewer, revision and whole-set, selected-sheet or discipline
scope. Optional sheet discipline assignments persist independently of count
verification. Explicit scopes take precedence over request wording. User requests appear as chat
bubbles, followed by elapsed progress and MOKE's saved response. A note is saved
without starting inference. Active reviews accept durable follow-up instructions
from the composer and show their delivery state. Findings open their source
evidence in a central canvas with zoom, pan and a return to the conversation.
Reviewers can select source areas visually and expand technical controls when needed.

Until a revised set arrives, an **Initial Review** button sits above the composer.
One click posts the preset first-submittal request (`initial-review-v1`, in
`src/lib/review/initial-review.ts`) as the reviewer's message and starts a review
of every sheet in the first set, with all disciplines and the four passes, on
Muse Spark 1.3. It runs in the cloud when cloud review is set up and can take the
workspace, and on this computer otherwise; one line beside the button says which.
The review records the preset's identity. The button is disabled while a review
runs in the conversation and can run again during the initial phase, for example
after sheet corrections. Each PDF import is a revision record, so a first set can
span several PDFs: the phase ends when a PDF is linked to earlier sheets through
revision correspondence, or when a PDF is imported after the project's first
drawing-set review started. After that, reviewers use typed requests.

The original desktop UI study established chat as the main work surface.
Projects group their conversations in navigation, and selecting a conversation
updates the project and conversation breadcrumb. Closing the source pane restores
the chat's width. The user referenced T3 Code's information menu and the existing
result-to-evidence behavior in the aec_pgrep codebase.

The separate design study contains sample content. The application uses persisted
projects, conversations, review requests, findings and source evidence. Sheet
confirmation and revision correspondence remain explicit for count checks.

## Brand Commitments

The user named OpenCode, T3 Code and Cloudflare OS as visual references, with
particular emphasis on T3 Code's desktop polish. The current workbench adapts the
Nightdesk template selected from the Uiverse catalog, with light and dark
appearances, compact navigation and evidence beside the conversation.
