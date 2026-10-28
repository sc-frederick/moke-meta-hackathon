# Moke beta implementation

The beta extends the selected Nightdesk workbench with persisted projects,
conversations, PDF sources, and bounded drawing inspections. Chat remains the
main work surface. The product scope is one selected drawn-to-schedule count
check at a time. A discipline choice supplies relevant instructions within that
boundary; it does not review the rest of the discipline or permit packet.

This account follows the [product context](../../PRODUCT.md),
[implementation](../../src/lib/review/components/ReviewWorkbench.svelte), and
[project manifest](../../.project-kit/manifest.json). It records implemented
behavior. The [validation record](beta-validation.md) contains acceptance proof
and remaining limits.

## Work surface and review flow

Projects group their conversations in the left navigation. The breadcrumb names
the active project and conversation. Selecting a conversation restores its draft
and scroll position during the session. The top-right Findings popover holds the
current project's findings. Selecting one opens evidence on the right and keeps
the conversation visible; closing it returns that space to chat. Search filters
the project's findings. Ctrl/Cmd K opens search, and Ctrl/Cmd N creates a
conversation in the selected project.

1. Create a project and import a drawing PDF through the desktop file dialog.
   Import retains the original and opens the Sheets panel. It does not establish
   that a sheet has been reviewed.
2. View each source, confirm its sheet label, and choose Unreviewed, Partial, or
   Reviewer complete coverage. [Sheet setup](../../src/lib/review/components/SheetSetup.svelte)
   exposes those choices explicitly.
3. Create a coordination check with a title, one object class and bounded room
   or area, a confirmed drawn sheet, and a confirmed scheduled sheet. Confirm
   that both sources describe the same object type and review boundary.
4. Choose the check and discipline in the composer. Review with Moke saves the
   reviewer message before requesting an inspection. Save note records a message
   without starting model work. Failed provider admission reports that the
   message was saved and does not resend it automatically.
5. Inspect the proposed observations in Findings. Open a proposal's source
   region or request a 300 DPI detail. Use proposal as draft copies the count,
   statement, rationale, and region into editable fields and leaves coverage
   unconfirmed. The reviewer accepts each count and confirms scope coverage.
6. Evaluate coordination compares the accepted drawn and scheduled counts.
   Missing accepted evidence or coverage remains Needs evidence. Agreement or
   disagreement describes the selected count comparison. Reviewer closed and
   Completed task remain separate, explicit reviewer controls.

[Conversation admission](../../src/lib/review/conversation.ts), the
[finding inspector](../../src/lib/review/components/FindingInspector.svelte), and
the [deterministic check](../../src/lib/review/checks.ts) enforce these separate
steps. Model messages and completed inspections do not accept facts, confirm
coverage, close findings, or complete tasks.

## Routed Moke instructions

The embedded instructions come from `sc-frederick/skills/moke-review` revision
`8a0e2648738018631eaa6d24ee0b6ebaa239afb1`. The
[provenance manifest](../../backend/review/prompts/provenance.json) records the
unmodified source files and hashes. Prompt version
`moke-selected-coordination-v2` combines the master instructions, shared method,
General, and the selected discipline. The shared method's Report and release
section is excluded from model instructions.

The [router](../../backend/review/prompts/review-prompt.ts) supports eleven
choices: General, Civil, Building design, Life safety, Structural, Mechanical,
Electrical, Plumbing, Fire alarm, Fire sprinkler, and Fire protection. The four
fire responsibilities remain separate routes. Each run freezes the reviewer
request, conversation, discipline, prompt version, and instruction revision.
Responses return to that conversation, and proposals retain provider, model,
response, and instruction provenance. See the
[prompt contract](../../backend/review/prompts/README.md).

## Execution and beta boundary

Review settings expose the configured provider and model without credentials.
The desktop imports credential configuration through its File menu. The local
Bun engine owns APIs, SQLite, and Pi Durable journals; Electron owns the trusted
bridge and file dialogs. Local execution can still send selected drawing
evidence to hosted Meta or Baseten inference.

The UI offers limits of 4, 8, or 12 calls, with 12 selected initially. Each model
request reserves up to 64,000 text-input tokens and 4,096 output tokens. SAM,
when configured for the route, has a limit of two requests and proposes object
locations. Image-token usage and billing are unknown. Pause, resume, cancel,
state, and admitted calls are visible in the
[execution controls](../../src/lib/review/components/ExecutionControls.svelte).

The model can inspect the selected PDF sheets, request original-PDF crops,
propose counts, ask for missing input, and evaluate accepted counts. It has no
browser or verified governing-code library. Printed drawing citations do not
verify an adopted edition or a regulatory claim. Relevant missing jurisdiction,
permit stage, code text, calculations, or prior comments remain Needs input.
This beta does not verify governing code, complete a permit or discipline
review, or generate a complete permit-review report. The offline fixture
worksheet is a separate report path. Modal execution remains deferred and
optional in the [runtime decision](../review-runtime.md).

## Evidence, revisions, and recovery

Evidence stays attached to original source sheets and PDF regions. The panel
shows the revision, page, render DPI, and source hash alongside the observation.
Accepted facts and evaluations retain versioned history. Corrections invalidate
dependent current results rather than erasing earlier evidence.

Importing another PDF revision retains earlier originals. The Revision panel
maps old sheets to new sheets and asks the reviewer to confirm correspondence
and whether content changed. Confirmed correspondence is one-to-one and
immutable. Reusing baseline facts requires confirmed unchanged correspondence;
changed or unresolved inputs need fresh evidence. The
[data lifecycle](../data.md) defines the source and fact version checks.

Reopen does not start model work automatically. Safe interrupted runs stay
paused until explicit resume. Unknown provider or SAM outcomes retain uncertain
evidence and are never resent automatically. An acknowledgement of a possible
prior charge permits a separate new run; it does not clear the earlier evidence.
Runs from incompatible engine or instruction versions cannot resume under the
new version. See [execution safety](pi-runtime.md).

Export complete package includes the whole local application database, source
artifacts, review history, and closed execution journals. It excludes
credentials, logs, environment files, and the ownership lock. Restore validates
the package before replacement and retains a pre-restore snapshot. Startup
recovers interrupted replacement before opening databases. Restored runs remain
historical and cannot resume copied journals. A database-only export is not a
complete review backup. See [data recovery](../data.md) and
[package format](review-packages.md).

## Existing design and responsive behavior

The [selection record](../../design/selection.json) pins Nightdesk from
`sc-frederick/uiverse-templates` revision
`88f6fb4b913606085633292659ac60ec6918cf28`. The
[selected surface brief](../../design/concepts/DESIGN.md) records its neutral
surface hierarchy, compact controls, system typography, Tabler outline icons,
and rounded findings popover. The beta extends that world. The study's sample
content is not application data.

The workbench CSS defines a dark shell, panel, and raised surface as `#141414`,
`#1b1b1b`, and `#262626`. Light appearance uses `#fdfdfd`, `#f6f6f6`, and `#ededed`
for the same roles. Both appearances share the workflow and header toggle.
Conversation text uses 15px type with a 1.75 line height and a reading width of
68ch. Controls and supporting text generally use 13px. Focus has a visible
outline, and the running indicator respects reduced motion.

At widths from 701px through 1180px, opening evidence hides the sidebar to retain
chat width; the navigation toggle can reveal it as an overlay. At 700px and
below, navigation and evidence use dismissible overlays. Escape closes search,
navigation, or the source pane as appropriate; closing the source returns focus
to Findings. Narrow headers hide secondary context instead of shrinking text.
These are implemented behaviors, with live responsive acceptance still pending.

The original source [DESIGN.md](../../design/reference/nightdesk/DESIGN.md),
assets, and [license](../../design/reference/nightdesk/LICENSE.md) are retained
together in the ignored `design/reference/nightdesk/` directory at the recorded
revision. The license permits adapted application use and prohibits republishing
or repackaging the design-system pack. Preserve its attribution and keep the
reference source outside public distributions. This extension does not replace
those source materials or create a second UI system.

## Validation

Use Bun `1.4.4` from [.bun-version](../../.bun-version). Completed automated checks,
bounded live acceptance, responsive review, and actual limitations are recorded
in [beta validation](beta-validation.md). Council results belong to the pull request.
Relevant commands from [package.json](../../package.json) are:

```sh
bun test tests/review-conversation.test.ts tests/review-execution.test.ts tests/review-fences.test.ts tests/review-packages.test.ts
bun run test:e2e tests/e2e/review.spec.ts
bun run verify
```

With the intended provider configured, the desktop review test also exposes an
explicit live path:

```sh
MOKE_E2E_LIVE=1 bun run test:e2e tests/e2e/review.spec.ts
```

Record its actual provider receipts, accepted evidence, remaining uncertainty,
and council disposition separately. Synthetic transport tests and standalone
design-study builds do not establish live model acceptance.
