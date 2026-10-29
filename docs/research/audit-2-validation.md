# MOKE Audit 2 implementation and validation

## Cloud integration (2026-10-29)

Approved audit commit `9aa92c1f041a7c589d011f378451a330f35bed24` was
rebased onto PR10's `c359e522f06f1a73888057233b4854193e2da9b2` as
`2596c9ecd06b3525c444949054bdb45b6cfee45b`. The three conflicts combine
Modal setup with trusted PDF drop imports, cloud ownership controls with the
audit composer/canvas, and cloud-return assertions with saved-answer,
source-generation and count-selection regressions. Auto-merged RPC, fixtures,
package scripts and subscription paths were inspected.

Local steering now enters the application's existing cloud ownership fence.
The centered import dialog, scope/reviewer controls, count edits and mirrored
finding completion also honor cloud ownership. Existing backend reconciliation,
automatic package return and immutable history remain in use; remote steering
is unavailable. Explicit scope travels through the shared cloud request and
worker JSON contracts. Offline round trips cover legacy requests and whole-set,
selected-sheet and discipline scopes, excluding later revisions as requested
and retaining sheet discipline metadata.

Cloud protocol 3 rejects PR10 worker images before model dispatch because those
images would silently discard the new scope fields. A matching worker image
must be built and published separately before cloud use. No image build, cloud
operation, credential change, dependency upgrade or migration was performed.
`bun install --frozen-lockfile` installed upstream's pinned Modal dependency.
The hardened isolation runner and packaged-executable support are unchanged
from the approved audit commit. The isolated launch adapter also strips ambient
Modal configuration so it cannot reintroduce credentials removed by each test.

Integration evidence is recorded in `.local/audit-2/integration-verify.log`,
`.local/audit-2/integration-svelte-autofixer.log`,
`.local/audit-2/integration-desktop/manifest.json` and the ignored review ledger.
Final `bun run verify` passes 316 smoke tests across 33 files (1,988 assertions),
all builds and checks, and all seven Electron tests. Both GUI runs passed the
hardened preflight. All five Svelte components/routes have zero autofixer issues;
the existing dialog-ref and Map/Set suggestions remain advisory. The 24 existing
class-instance-spread lint warnings remain. Fresh cloud-owner, mirrored-finding
and missing-source screenshots were inspected from the final run. No live
provider/cloud validation ran. Windows/macOS hosted CI and packaged execution
remain external validation; no inference-quality claim is added.

The focused comparison is
`git range-diff 0fe032e3e..9aa92c1f0 c359e522f..HEAD`, preserved in
`.local/audit-2/integration-range-diff.txt`. Parent round 3 reviews this
integration; publication remains with the parent. The sections below record
the pre-integration audit approval and its historical evidence.

## Approved audit baseline

Work resumed on `fix/moke-audit-2` from base
`0fe032e3e1b9aac35967545065a8c7677e089e44`. The existing implementation diff
was retained and completed. No migration, dependency upgrade, deployment, PR,
push, merge, or paid provider probe is part of this change.

## Isolation and reproducibility

All GUI evidence for this handoff comes from `scripts/isolated-desktop.ts`.
Earlier screenshots and GUI logs under `.local/audit-2` are **not isolation
proof** and are excluded from the acceptance evidence below.

The parent-hardened runner uses private user, mount, network, IPC and PID
namespaces, kills children when its parent exits, mounts a private X11 socket
directory, hides `/mnt/wslg`, and brings up only private loopback networking.
It starts Xvfb explicitly on `:99`, verifies 1600×1000 with `xdpyinfo`, and
checks that desktop `:0` is unreachable before Playwright can launch Electron.
Desktop buses, portals, audio, notifications and inherited display variables are
disabled. Electron tests use temporary data and profile directories and one
worker. No user desktop, live MOKE profile, clipboard, input, browser, or provider
endpoint is used.

Run the required verification with Bun 1.4.4 and the prepared local Xvfb:

```sh
MOKE_XVFB_BINARY="$PWD/.local/audit-2/xvfb/usr/bin/Xvfb-private" \
LD_LIBRARY_PATH="$PWD/.local/audit-2/xvfb/usr/lib/x86_64-linux-gnu" \
nice -n 10 bun run verify
```

The ordinary E2E and screenshot package scripts now route through this runner.
`test-packaged.ts` delegates to `test:e2e`; it was inspected but packaging was
not required or run. Tests and builds ran sequentially at reduced CPU priority.

## Acceptance evidence

A01–A07 and A09–A13 are implemented and verified by the fixtures below. A08 has
verified lifecycle recovery; the original live-profile transport trigger remains
unconfirmed, as described under limits.

| Item | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Concrete proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01  | Settings labels and the optional call-budget input use a full-width grid with border-box sizing. Text inputs use a single focus underline; other controls retain keyboard-visible focus.                                                                                                                                                                                                                                                                                                                                                                                                                                              | `audit-2.spec.ts` measures the input width and absence of an outline; `polish.spec.ts` exercises keyboard selectors. `audit-settings.png` was inspected.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A02  | Centered import dialog supports a native chooser and real file drops. Preload resolves the actual OS file path with Electron `webUtils`; main validates the trusted top-level frame, absolute PDF path and regular file, then issues a short-lived opaque token. Only Electron/backend see the path. The successful import directory is remembered in a private preference file for both entry paths. Invalid or superseded drops cannot retain a previously selected file.                                                                                                                                                           | Real native selection and an OS-backed dropped file from a different directory pass through the isolated preload/main/backend. The next chooser defaults to the dropped file's directory. `audit-import.png` and `audit-revision-import.png` were inspected.                                                                                                                                                                                                                                                                                                                                   |
| A03  | Later imports request `Rev 1`, `Rev 2`, etc. The Revision tab contains an actionable Import revision button. The selected revision changes after import; old sources, findings and explicit correspondence remain intact.                                                                                                                                                                                                                                                                                                                                                                                                             | E2E checks both default labels and the selected imported revision. Backend regression imports a second PDF, rejects mixed-revision selection and verifies that import creates no correspondence. Existing revision/reconciliation suites cover immutable history and explicit mapping.                                                                                                                                                                                                                                                                                                         |
| A04  | Compact sheet rows show optional discipline assignment and selection. Bulk assignment saves selected sheets in one command. Count verification lives behind a disclosure and remains separate from ordinary review.                                                                                                                                                                                                                                                                                                                                                                                                                   | A 52-sheet Electron fixture bulk-assigns Fire alarm, verifies compact row height, changes selected-sheet scope to 51, and reopens with assignments retained. SQLite regression confirms assignments do not mark coverage or confirmation. `audit-52-sheets.png`.                                                                                                                                                                                                                                                                                                                               |
| A05  | Explicit Whole set, Selected sheets and Selected discipline scopes carry a revision and sheet selection through shared Schema/RPC contracts. Backend freezes only eligible sheets. All-disciplines modes show that fact in the composer; a discipline scope requires a named reviewer and assigned sheets. Explicit scope wins over conflicting prose. Distinct fire responsibilities are preserved.                                                                                                                                                                                                                                  | SQLite/Pi regressions check selected-sheet inventory, electrical-only context, contradictory whole-set wording under explicit discipline, explicit whole-set inventory after another revision, mixed-revision rejection, empty discipline rejection and persistence. E2E checks 51/52/0 scope counts for selected sheets/Fire alarm/Fire sprinkler.                                                                                                                                                                                                                                            |
| A06  | Source views occupy the main work surface. Zoom/pan and Back to conversation remain available. Compact floating findings open readable central details, source images and PDF-coordinate bounding boxes; focused locations can request a high-DPI crop. Obsolete source requests cannot reopen a closed pane.                                                                                                                                                                                                                                                                                                                         | Electron asserts a canvas wider than 1100px and taller than 550px, uses zoom and keyboard pan, and opens a persisted finding with its bounding-box overlay. `audit-large-drawing.png` and `audit-finding-canvas.png` were inspected.                                                                                                                                                                                                                                                                                                                                                           |
| A07  | Conversation and composer expand to 1120/1180px. Review summaries have a short default presentation with full notes in a disclosure. Saved response text is not duplicated next to the same review summary. Compact finding actions open details centrally. HTML export is removed from the main review UI; saved report data and backend export remain compatible.                                                                                                                                                                                                                                                                   | Packet E2E opens a persisted summary and findings, checks absence of the HTML-report action, changes conversations and reopens. `packet-review-workbench.png` and `audit-conversation.png` were inspected.                                                                                                                                                                                                                                                                                                                                                                                     |
| A08  | A terminated subscription previously set a permanent disconnect flag, retained a dead controller, swallowed its error and never recovered. The owned subscriber now reloads durable records and resubscribes with bounded abortable backoff. A warning appears after repeated failures and clears on resumed events. Refresh does not block stream acknowledgement. No inference work is restarted by reconnecting.                                                                                                                                                                                                                   | A real SQLite/Pi service test interrupts the stream three times, records completion during a gap, verifies saved-state backfill and a fourth live subscription, clears the warning and aborts cleanly. Electron logs contain no renderer errors or progress warnings in ordinary flows. See the limitation below about the original transport trigger.                                                                                                                                                                                                                                         |
| A09  | Enter submits; Shift+Enter adds a newline. IME/composition and key-code 229 are respected. Pointer dropdown opening avoids forced focus while keyboard navigation remains visible. New count check is a secondary header action.                                                                                                                                                                                                                                                                                                                                                                                                      | Electron exercises Shift+Enter, Enter and a composing Enter that preserves the draft. The polish test exercises keyboard dropdown navigation. Settings and conversation screenshots were inspected.                                                                                                                                                                                                                                                                                                                                                                                            |
| A10  | Visible workbench, page title, settings, summaries, native export labels, saved packet reports and auxiliary generated reports use MOKE. Vendored instruction sources and historical records retain their provenance.                                                                                                                                                                                                                                                                                                                                                                                                                 | Electron asserts the brand text; screenshots show MOKE. Existing report suites exercise generated output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A11  | Render requests fit source regions into the existing 16-million-pixel budget. Actual fractional DPI and forward/inverse source transforms travel with the artifact. Worker-side limits, original metadata validation, source-region checks and requested-DPI bounds remain enforced. Detail crops retain 300 DPI when they fit.                                                                                                                                                                                                                                                                                                       | Real PDF regressions render a 36×48-inch coordinate page with UserUnit 2 at rotations 0 and 90. The former fixed 150-DPI request exceeds the ceiling; fitted output succeeds under it, a focused 300-DPI crop succeeds, inverse coordinates round-trip and actual PNG dimensions match. A large source is also rendered through Electron.                                                                                                                                                                                                                                                      |
| A12  | `SteerPacketReview` saves the reviewer message and pending delivery atomically, then submits to the active conversation's installed Pi Durable 1.4.0 `root.submit({type:"input",requestId,whenBusy:"steer"})`. Retried command IDs reuse Pi admission. Delivery states are persisted and visible. Settlement closes steering admission and waits for admitted steering before finalizing. Drafts survive rejected delivery. Explicit resume carries unresolved instructions into its durable continuation and updates their delivery status after the resumed answer. Existing ownership, budget and provider-attempt controls apply. | Real SQLite/Pi tests queue steering during both a tool round and a final answer, retry the same command concurrently, reject another conversation, inspect the next provider fixture request for the instruction, assert exactly two model attempts and one message, then reopen with no dispatch. An additional budget-exhaustion test verifies that explicit resume answers the queued instruction with exactly two paid-attempt fixtures in total and corrects its delivery state. Installed README Busy Conversations and Request IDs sections were read. No live inference claim is made. |
| A13  | Adjacent fixes include bulk-assignment event lifetime, central finding overlays, source-request cancellation, invalid-drop state, explicit-scope precedence, saved project-version consistency, accurate prior-scope labels, accessible finding buttons, and separating active steering from next-review settings.                                                                                                                                                                                                                                                                                                                    | Full verification covers import, review/pause/resume/cancel/uncertainty, event delivery, persistence, evidence transforms, corrections, revision isolation and complete-package recovery. The final suite and evidence paths are recorded below.                                                                                                                                                                                                                                                                                                                                               |

## Verification results

Final `bun run verify` passed with Bun 1.4.4 at reduced CPU priority:
282 smoke tests across 29 files, 1,727 assertions, all seven isolated Electron
tests, type checking, concept checks, lint, formatting, frontend build, Electron
build and compiled Bun backend/PDF worker builds. The complete result is
`.local/audit-2/sol-g1-verify.log`. All GUI launches in this run used the
hardened wrapper and passed its private-display and unreachable-desktop probes.
There are 24 preexisting class-instance-spread lint warnings and no new warning
category or lint error.

Focused evidence includes real SQLite/Pi finish-boundary tests for successful,
budget-limited, cancelled and interrupted steering admission; concurrent token
claims and backend receipt replay; real Electron lost-response/retry and delayed
source delivery in both orderings; and accepted-count refreshes on a 36×48 sheet.
The targeted large-count run passed in `.local/audit-2/repair-count-desktop.log`.
The Svelte autofixer reported no issues in the five changed components/routes.
Its existing focus/dialog refs and local Map/Set suggestions remain advisory.
No dependency or migration was added, no model provider was contacted, and no
commit, push, PR, reviewer, publication, or deployment was started.

Earlier verification logs and screenshots are historical context, not the GUI
isolation evidence for this handoff. Impeccable was not repeated for these
behavioral fixes; its earlier static report is not new acceptance evidence.

## Screenshot and diff inventory

All listed screenshots were regenerated in the passing G1 follow-up full run
through the hardened runner. The saved-results and missing-source captures were
inspected with `view_image`. Supporting captures remain available for parent
review. Files are preserved under this absolute directory:

`/home/scfred/Work/moke-meta-hackathon/.local/audit-2/sol-g1-desktop/`

- `audit-large-count-refresh.png`: refreshed 36×48 source at fitted fractional DPI.
- `audit-large-count-saved.png`: persisted corrected count and source provenance.
- `audit-source-race.png`: second source image and distinct box after stale delivery.
- `audit-import-retry.png`: lost-success response with the retained request/label.
- `audit-settings.png`: legible call-budget label, field and single underline.
- `audit-import.png`: centered drop/picker modal.
- `audit-revision-import.png`: real dropped PDF with the Rev 1 label.
- `audit-52-sheets.png`: compact rows, selected sheets and bulk assignment.
- `audit-large-drawing.png`: large source canvas with zoom and keyboard focus.
- `audit-finding-canvas.png`: readable finding details, source image and bounds.
- `packet-review-workbench.png`: expanded conversation and compact saved results.
- `audit-missing-source-finding.png`: missing-source finding clears prior source/count.
- `audit-conversation.png`: saved Enter/Shift+Enter message after revision import.
- `polished-workbench.png`: narrower desktop navigation/interaction regression.
- `review-workbench.png`: count correction and revision-history workflow.

`manifest.json` records the full-run log associated with these files. The
uncommitted tracked and untracked file inventory and exact insertion/deletion
counts are in `.local/audit-2/sol-g1-diff-stat.json`. Both the existing task edits
and the parent's hardened isolation wrapper are included; no unrelated changes
were discarded. The base/HEAD is unchanged from the SHA at the top of this note.

## Limits and decisions for independent review

- The original user's transport-level disconnect trigger was not reproduced
  against their live app or profile. The permanent failed-subscription lifecycle
  was reproduced with deliberate termination through the real service seam and
  fixed. A continuing transport defect remains visible through diagnostics and
  the reconnect warning; it is not treated as success or used to restart work.
- Model/SAM inference uses deterministic external transport fixtures. No real
  provider request ran inside the isolated network, and no new live inference
  quality or provider behavior is claimed. Electron proves the actual desktop
  result/import/evidence surfaces; service tests prove durable inference and
  steering mechanics.
- Whole-set and selected-sheet scopes inspect all applicable disciplines for
  their selected revision. Selected discipline filters by persisted assignment.
  Blank assignments are deliberately excluded from a discipline scope and remain
  included in whole-set/selected-sheet review. Scope does not authorize automatic
  revision correspondence or count verification.
- Large full-page renders trade DPI for bounded memory. A focused crop retains
  detail resolution. The hard resource limit remains 16 million output pixels.
- Local GUI proof requires private Xvfb and namespace support and fails closed.
  Disposable GitHub-hosted runners have a separate path requiring both
  `GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`. Generic CI and
  self-hosted runners cannot enter it. Windows/macOS use their hosted native
  desktop; hosted Linux uses the workflow's Xvfb. Every path uses private
  profiles, one worker, muted audio and disabled notifications. The hosted
  platforms were not executed locally.
- The parent owns independent Grok review, Sol-loop, PR work and any publishing.
  This handoff is an uncommitted implementation diff for that review.

## Accepted review repairs (G1–G4, P1)

- **G1:** Installed Pi 1.4 admits input asynchronously on its session line. An
  idle `whenBusy: "steer"` creates a new run; checking a host flag immediately
  before `submit` cannot make it a busy-only operation. The existing pending
  lease now explicitly owns that continuation through settlement, including
  errors after Pi admission. Completion includes every instruction's outcome
  and converts undelivered durable intents to `unanswered` instead of claiming
  completion from the first run alone. Concurrent identical command admissions
  share one result; changed input conflicts. Existing provider admission still
  enforces the persisted call budget, cancellation and ownership. Once the
  original submission settles, new drafts are rejected clearly; already staged
  instructions drain within the owned lifecycle. Failed Pi runs withdraw queued
  instructions as unanswered before the host awaits their admission leases.
  The deterministic regression
  pauses the real host runtime after SQL intent, waits for the original Pi
  submission to be durably `done`, then releases admission. Success, budget,
  cancellation and admission interruption preserve one message and bounded
  provider calls. Existing explicit-resume and reopen regressions still apply.
- **G2:** A dropped PDF capability claims the complete import command before
  asynchronous backend work. Other command IDs or changed versions/labels
  conflict; identical retries retain the path and successful receipt for the
  desktop session. Claimed entries are not evicted; a bounded session capacity
  refuses further drops instead of forgetting claims (native selection remains
  available). The real backend's receipt handles a response lost before shell
  caching. A cached success needs no source reread. The import UI retains the
  command after failure, locks its label and chooser, refreshes project version,
  and requires an explicit new drop/cancel to start a new request. The desktop
  transport regression loses one successful response and retries the exact
  payload, proving one added revision. Same-version duplicate imports already
  had backend optimistic concurrency; that broader reproduction was declined.
- **G3:** Intended overlays travel into `loadSheetSource` and commit with the
  accepted image/artifact generation. Packet fallback reuses its existing
  request generation; focus requests no longer write overlays after a stale
  loader returns. Real Electron RPC responses are held while another finding
  on another sheet renders, then released in both focus/fallback orderings.
  The selected image and second box remain together. Returning to conversation
  while a render is held cannot reopen its source pane. Project/conversation
  switches and component disposal retain their request invalidation.
- **G4:** The accepted source request remembers integer requested DPI separately
  from the fitted artifact's fractional actual DPI. Count acceptance still
  saves first, then refreshes at the intended 96 or 300 DPI. A 36×48 two-page
  source proves both refreshes, visible evidence overlays, fractional fitted
  DPI, the 16-million-pixel bound, and PDF/pixel transform round trips. G3 also
  exercises 150-DPI fallback and 300-DPI focus. The former issue broke the
  refresh after saving; it did not lose the accepted count.
- **P1:** A narrow disposable-hosted-runner path preserves the existing
  Ubuntu/Windows/macOS workflow and packaged test entrypoint. All tests honor
  `PROJECT_KIT_EXECUTABLE`, including audit tests. Non-GUI guard regressions
  reject generic CI, self-hosted and incomplete/spoofed hosted flags, missing
  profiles, inherited local displays and Wayland. No desktop safety control
  was weakened for local runs. Windows/macOS/package execution is left to
  external CI; no package or hosted session was launched here.

Repair logs use `.local/audit-2/repair-*.log`. The first repair verification
passed all 281 smoke tests (1,710 assertions) and builds, then exposed two new
GUI fixture issues: reload before initial navigation and a finding locator in
the hidden conversation. The targeted rerun passed source races and lost-response
recovery, and exposed an assertion made before count-refresh RPC dispatch.
Those test synchronizations were corrected without changing desktop isolation.
A later assertion incorrectly assumed all 36×48 renders must fit below 96 DPI;
96 DPI already fits, while a 300-DPI full-page request fits to approximately
96.1769 DPI. The corrected regression distinguishes requested/actual DPI and
passes. Final verification passed all 281 smoke tests, 1,710 assertions and
seven Electron tests. Its log and screenshot manifest are listed above.

## Sol round 1 G1 follow-up

The remaining G1 failure was reproduced through the real packet service and Pi
1.4 journal. The fixture holds the provider after dispatch, queues a stable
instruction, then throws. Before the repair, the review became uncertain but
the instruction stayed queued. The bounded regression failed in
`.local/audit-2/sol-g1-red.log`.

The production change selects Pi's existing `afterFailedRun: "withdraw"`
policy. Installed `README.md` Failures and Recovery and Busy Conversations,
`dist/harness/types.d.ts`, `generation.js` and `inbox.js` were inspected.
Pi withdraws the queued inputs in the failed-run settlement transaction, before
the host waits for steering admission leases. No new queue or retry mechanism
was added. The original submission is `unanswered` with `model_error`; steering
is `unanswered` with `run_failed`. The saved instruction and reviewer message
remain, and the host review retains `uncertain` with one sent provider attempt.

The new non-GUI regression also proves bounded cleanup, reopen, same-command
start and steering replay, rejected resume and exactly one provider fixture
call. All 17 focused service tests passed with 226 assertions in
`.local/audit-2/sol-g1-focused.log`, including successful tool/final boundaries,
normal failed admission, call budgets, cancellation and explicit resume.

The parent's S1-S3 behavior and test changes were preserved. Initial full
verification found three missing blank lines in those changes, plus five in the
new regression. Only the three required blank lines were added to
`ReviewWorkbench.svelte` and `tests/e2e/packet.spec.ts`. That failed lint run is
preserved in `.local/audit-2/sol-g1-verify-lint.log`. The Svelte autofixer still
reports zero issues in `.local/audit-2/sol-g1-svelte-autofixer.log`.

Final `.local/audit-2/sol-g1-verify.log` passes all checks and builds, 282 smoke
tests with 1,727 assertions, and all seven Electron tests. Its preflight confirms
private Xvfb `:99` at 1600x1000 and desktop `:0` unreachable. The parent's S1-S3
persisted-result regression also passes: count comparison clears packet
selection, earlier saved answers remain visible, and a finding without source
evidence clears prior source/count state. New screenshots are recorded above.
The only remaining lint warnings are the same 24 class-instance-spread warnings.
Sol round 2 approved the behavior diff with no open findings. Its independent
non-GUI checks passed 11 tests with 113 assertions and the Svelte analyzer
reported zero issues. G1 and S1-S3 are resolved; G2-G4 and P1 remained resolved.
The two Sol rounds used GPT-6.1 Sol on xhigh with priority service. Grok 4.6 on
xhigh supplied the initial adversarial findings. Neither reviewer exposed usage.

## Sol integration round 3 S4 recovery repair

S4 reproduced a recovery regression after the protocol-3 scope handshake: an
already-dispatched protocol-2 worker's progress failed decoding before the
result directory could be snapshotted. Reopening or retrying could not return
the paid work. Publishing a new image cannot change that existing worker.

New ownership receipts now record `workerProtocol: 3`. The actual Modal progress
decoder permits protocol 2 only for unmarked saved `dispatching`/`running`
receipts, preserving protocol-3 recovery for receipts saved before the marker.
Engine, count prompt, packet prompt, instruction revision, job ID, phases and
progress payloads remain validated. Requests, warm admission and newly admitted
jobs remain strict at protocol 3. No worker is dispatched by recovery, no model
call is replayed, no SQL migration changes, and no existing receipt is rewritten
on load. Persisted incompatible sync pauses still require explicit **Retry sync**.

The offline regression uses the decoder called by Modal and the real cloud
services, synchronization and application package restore. It reopens old
dispatching and running receipts, decodes protocol-2 ready progress, creates a
separate local result snapshot, downloads it once, confirms stop, verifies and
restores the actual package, and proves local writes return. A paused old receipt
recovers after Retry sync. A corrupt old result fails hash validation and retains
the fence. A packet-service/Pi fixture also returns its saved answer across reopen
with exactly one model-transport fixture call and one dispatch. Reopening again
and replaying the original command do not download, dispatch or infer again.
Negative cases cover the wrong job, unrelated protocols, each identity field,
invalid phase/execution/message, protocol-2 warm admission and new-job progress.
Existing strict protocol-3 request and scope tests remain.

Before repair, `.local/audit-2/s4-red.log` recorded two passing current-protocol
package cases and three failing legacy cases with the actual unreadable-progress
error. Focused validation is in `.local/audit-2/s4-focused.log`; full verification
is recorded in `.local/audit-2/s4-verify.log`.

Final focused validation passes 34 tests with 398 assertions. Full verification
passes all type/design checks, formatting and builds, 321 smoke tests with 2,152
assertions, and all seven Electron tests (54.1 seconds). The same 24 baseline
class-instance-spread lint warnings remain. Desktop preflight again confirms
private Xvfb `:99` at 1600x1000 and desktop `:0` unreachable. Fresh screenshots
and their hashes are retained in `.local/audit-2/s4-desktop/manifest.json`.
The first lint-only failures are retained as `s4-verify-lint.log` and
`s4-verify-receipt-spacing.log`; the earlier complete passing run before tightening
the persisted dispatching-receipt assertion is `s4-verify-before-receipt-assertion.log`.

All checks use Bun 1.4.4 at `nice -n 10`, sequentially. Desktop proof runs only
when full verification invokes the unchanged hardened `scripts/isolated-desktop.ts`
with the prepared private Xvfb. No inherited/user desktop, Windows/Helium browser,
development app, live provider/Modal request, image build/publish, external write,
credential change, push, PR or merge is part of this repair. Protocol-3 image
deployment for new reviews and live/Windows/macOS/package validation remain
separate work.

Sol round 4 approved the recovery delta with S4 resolved and no new scoped
findings. Its independent non-GUI validation passed 29 tests with 386 assertions.
The complete review used four rounds with GPT-6.1 Sol on xhigh and priority
service; usage was not exposed. All accepted Grok, Sol and parent findings are
resolved. The final behavior diff against the integrated cloud base spans 56
files with 4,565 insertions and 740 deletions before this approval note. Growth
from the initial 43-file audit includes regression evidence, desktop isolation,
cloud scope integration and recovery of existing cloud work.
