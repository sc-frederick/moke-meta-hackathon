# Audit 3 fixes and repeat acceptance

The source audit is `.local/audit-3/report/index.html` (2026-10-29), with 24
comments and recorded live Windows reproductions. This change preserves the
Nightdesk interface and the existing complete-workspace cloud ownership protocol.

## Changes and acceptance checklist

| Original finding               | Change                                                                                                 | Acceptance                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3-01 full-set failures        | Eight-image Spark Open request window, five-minute deadline, safe diagnostics and no uncertain replay  | Five live sets returned findings; HTTP 400 reproduced at nine images and eliminated by the eight-image window.                                             |
| M3-02 recovery mismatch        | Explicit possible-charge and cancel-to-unlock guidance; saved diagnostic/failure history               | Native cancellation retained 1:29 duration and failure details; runtime and desktop regressions passed.                                                    |
| M3-03 premature Connected      | Provider-secret, immutable image and worker-identity preflight before transfer                         | Real Modal image/worker/provider-secret preflight passed before transfer.                                                                                  |
| M3-04 reopen project lock      | Snapshot reads share SQL exclusion with replacement; startup restores cloud project/conversation/model | Native reopen restored fire-alarm conversation/model/job; read-only project navigation passed.                                                             |
| M3-05 scope leakage            | Per-conversation view preferences, fresh scopes reset                                                  | Desktop scope isolation and conversation restore regression passed.                                                                                        |
| M3-06 hidden count form        | Scroll and focus Check name when created                                                               | Native form was brought into view; desktop focus/viewport assertions passed.                                                                               |
| M3-07 generic inventory        | Advisory PDF labels, original page refs, search, compact rows and lazy thumbnails                      | Fresh native import identified G-1/FA-1/FA-2 with original page refs and previews; PDF tests passed.                                                       |
| M3-08 removed revisions        | Explicit removed/unresolved mappings, exact-PDF proposals, saved summary                               | Desktop five-to-four mapping and saved Removed summary survived reload; native retained-four/removed-one decisions saved and survived reopening the panel. |
| M3-09 sheet navigation         | Previous/next and sheet picker with position and zoom preservation                                     | Native previous/next page navigation and position passed; desktop regression passed.                                                                       |
| M3-10 evidence below text      | Collapsible observation/correction and fitted source canvas                                            | Native evidence canvas and collapsed details inspected; delayed-source/menu regression passed.                                                             |
| M3-11 cloud activity           | Transfer bytes, elapsed/remaining time, opened sheets, findings and last activity                      | Native cloud card showed 482.8 MiB, elapsed/remaining time, current scope/model, sheets, findings and passes.                                              |
| M3-12 old global receipts      | Scope terminal receipts to project/conversation; dismiss action; terminal reconnect copy suppressed    | Desktop scoping and terminal-message checks passed; native terminal receipt dismissed and stayed absent on Civil.                                          |
| M3-13 history duration         | Accumulate active intervals; retain failure through cancellation; open saved review                    | Native failure/cancel duration unchanged; separate latest/paused-history regression passed.                                                                |
| M3-14 unrelated notice         | Clear transient notices at source/conversation changes                                                 | Conversation/source changes cleared notices; desktop context regression passed.                                                                            |
| M3-15 coverage wall            | One collapsed summary per sheet with recorded counts and denominator explanation                       | Desktop collapsed per-sheet coverage and actual pass counts passed.                                                                                        |
| M3-16 compact navigation       | Preserve Sheets/project and secondary actions in a compact More menu                                   | Native 1280×900 retained Sheets/project; desktop 850px layout passed; compact More retains secondary actions.                                              |
| M3-17 copy                     | Platform shortcut, singular counts, safe formatted review notes                                        | Native Windows Ctrl K copy inspected; singular/plural and safe formatted notes checked.                                                                    |
| M3-18 false missing claims     | Page inventory/detail/contradiction instructions and host absence-evidence gate                        | Local fire-alarm result recognized supplied battery/NAC calculations and matrix; absence and plural regressions passed.                                    |
| M3-19 report handoff           | Export review report beside saved result, using existing HTML report API                               | Real HTML report export through desktop chooser API passed; native standalone HTML export succeeded.                                                       |
| M3-20 maintenance errors       | Read-only snapshots avoid network locks and retain SQL/recovery exclusion                              | Real-application cloud maintenance/read regression and recorded preparation/reopen passed.                                                                 |
| M3-21 stale Pause              | Accept compatible idempotent pause/cancel across progress versions                                     | Real SQLite/Pi stale-version Pause regression passed.                                                                                                      |
| M3-22 invalid restore          | Validate package before replacement confirmation; show specific selection error                        | Missing-manifest preflight and desktop invalid-folder regression passed without replacement confirmation.                                                  |
| M3-23 hidden governing sources | HTTPS-only native open action, exact URL, timestamp and saved text                                     | Native URL/time disclosures inspected; HTTPS-only link and saved-text desktop regression passed.                                                           |
| M3-24 capacity/start failure   | Bounded 1GiB workspace allowance, measured-byte errors, persistent start errors                        | Live 482.8 MiB workspace admitted and uploaded; raised-bound and persistent failure regressions passed.                                                    |

## Research and decisions

See [review reliability](audit-3-review-reliability.md) and
[Modal resources](audit-3-cloud.md) for primary-source research through Exa via
Executor. Four CPU cores and 8GiB RAM cost approximately $0.76/hour, four times
the prior worker, with inference billed separately. The audit image uses a unique
non-production tag. A larger worker can help PDF processing; inference runs at a
separate provider and no throughput improvement is assumed.

Project-only transfer is deferred because automatic return replaces the entire
workspace. Sending a subset through that protocol could lose unrelated work.
The original 259MiB workspace and the repeated-audit 482.8MiB workspace fit the raised bounded allowance.

Coverage receipts and the new absence gate enforce collection and explicit source
search, not engineering correctness. The local and cloud fire-alarm results were compared with the supplied page 2
battery and NAC tables and input/output matrix. Both recognize supplied
calculations; incompleteness and field verification are distinguished from
absence. Stronger prompts alone are not completion proof.

## Repeated live reviews

Same supplied drawing content, native Windows packaged application, Muse Spark Open.
All five runs stopped on HTTP 400 before the image fix; the corrected runs returned
usable findings. Completed execution does not mean full engineering coverage:

| Set                   | Opened / supplied sheets | Recorded passes | Findings | Calls |
| --------------------- | ------------------------ | --------------- | -------- | ----- |
| Brewery               | 27 / 29                  | 7 / 1,276       | 11       | 39    |
| Laundry               | 13 / 13                  | 16 / 572        | 11       | 34    |
| Porch                 | 9 / 9                    | 29 / 396        | 10       | 19    |
| Civil latest revision | 4 / 4                    | 31 / 176        | 11       | 37    |
| Fire alarm            | 3 / 3                    | 12 / 12         | 8        | 25    |

The civil project retains its five-sheet baseline and the prior audit's four-page
removal fixture. Its latest whole-set scope is four sheets, not a missing fifth
page. The larger reviews still leave coverage gaps; the UI and reports retain
these actual counts. No independent parallel reviewers were added. Addressing
provider rejection and enforcing source evidence was the measured priority.

The completed fire-alarm result explicitly reads the supplied 8.90Ah battery
requirement and NAC current/resistance tables. It describes the supplied matrix
as incomplete rather than absent. Engineering adequacy of those conclusions
still requires review of the cited source regions.

## Verification and evidence

Exact Bun 1.4.4. `bun run verify` passes 343 smoke tests in 36 files and nine
isolated Electron desktop tests, including a delayed snapshot/menu regression and
paused-history admission. Sol approved application behavior in four rounds and the test follow-up in the authorized sixth round;
[the review ledger](audit-3-sol-loop.md) records findings and fixes.

The Windows audit ran through Cua Driver 0.38.0 with fresh accessibility snapshots,
foreground delivery where background selection failed, native file dialogs,
1280×900 and larger windows, and light/dark views. Raw screenshots, interaction
logs, recordings and provider probes are private under `.local/audit-3-fixes` and
Windows Downloads `Moke-audit-3-fixes-2026-10-29`. The original audit workspace and
recordings were preserved. Two apparent import stalls were a driver-target error:
the file-type dropdown and dialog submit both expose Open; selecting submit id=1
imports all three sheets correctly. This was not an app regression.

## Native cloud return and recovery

The same native job uploaded 506,303,815 bytes (482.8 MiB), executed 30 review
calls, and returned a 528,285,726-byte (503.8 MiB) package across 289 files. It
recorded seven findings and 12/12 passes across all three fire-alarm sheets.
Reopening restored the correct project, conversation, scope and Muse Spark Open
model. Native read-only navigation continued during download. The final native
view shows Results synced, enabled local controls and no reconnect error.

The repeat audit caught two remaining return failures: reads queued behind
network maintenance, and retries copying all prior files after a transient
network failure. Reopening mid-copy also left a Modal SDK scratch file that
correctly failed full package validation. Snapshot reads now share the existing
SQL exclusion with replacement and check pending recovery under that exclusion.
Retries reuse only exact size/SHA-256 matches and clear only the SDK's precise
scratch-file pattern in the job's output directories. Other unexpected files
still fail validation. Recovery used the original result snapshot, without
re-running inference. Final cloud state is imported with no sync failure; the
account's running-sandbox list was empty at 11:17 UTC.

The completed cloud result reads the supplied 8.90 Ah battery requirement,
recognizes the new NAC #2 voltage-drop calculation, and distinguishes missing
existing-system verification from absent calculations. The native Export review
report action saved a 9,771,955-byte standalone HTML report with embedded
evidence. Dismiss removed the terminal cloud receipt; navigating to Civil
showed no unrelated receipt.

Completed inference receipts in this isolated native audit estimate $5.41 using
the documented Baseten rates. Seven terminal sent attempts remain unresolved
and can carry additional charges; this is not an invoice or a total cost cap.
There were no active inference requests or SAM receipts at the final read.
Modal compute and the small synthetic provider probes are separate.

Native revision acceptance retained four pages as unchanged/confirmed and marked
page 5 removed in the prior audit's five-to-four fixture. The saved dispositions
survived closing and reopening the Revision panel. Windows accessibility
snapshots briefly retained an old checkbox name after selection changed; direct
screenshot inspection showed the correct visible label, and actions used the
original-page row plus a fresh element token. No DOM scripting was used.

## PR Windows render-readiness regression

The first PR run passed Linux and the Windows check/smoke/build stages. Windows
then failed the polish test's five-second assertion for selection help. That
assertion ran before waiting for asynchronous source rasterization to finish. The test now waits for the prior image before
starting each selection, holds that selection's real RenderSource response,
checks the rendering state, and releases it before asserting the ready image
and selection help. The render readiness bound is 15 seconds. The pointer drag,
expected PDF coordinates and coverage-reset assertions are retained. Application
code is unchanged. The isolated focused flow passed before the final readiness
refinement; the full verification suite covers the submitted test.

The fifth Sol review caught one test-ordering issue: the old image remained
visible while acceptance was pending, so the next render hold could capture
acceptance's refresh. The test now waits for the Select area control to be
enabled before awaiting the prior image and arming the hold. A strict probe
delaying scheduled acceptance by 500 ms fails without that enabled-control
wait and passes with it; all three held responses then belong to selection.
The probe uses the existing private Linux desktop boundary and unmodified
application handlers. Only the test response delivery is delayed.

After the S5 ordering fix, full Bun 1.4.4 verification passes 343 smoke tests
and all nine isolated desktop tests (polish 9.9 seconds). Linux and macOS CI
passed on the initial PR head. Its Windows render-readiness test follow-up is
approved in the explicitly authorized sixth Sol round; no application code changed. See PR #13 for current CI.
