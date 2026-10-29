# Audit 3 recheck: native walkthrough after the fixes

Checked 2026-10-29. This replaces the acceptance claims in
[audit-3-validation.md](audit-3-validation.md), which leaned on earlier screenshots
and test results.

## Question

Do the Audit 3 fixes hold up when the packaged Windows app is used the way Audits 1
and 2 were done: a full walkthrough of the real UI, with real drawing sets and real
Muse Spark Open reviews, rather than a spot-check of each finding?

## Method

- The app was built from branch `fix/audit-3` plus this pass's fixes and installed as a
  separate Windows copy. It ran on a **fresh, empty workspace**; the earlier audit
  workspaces already contained confirmed sheets and saved mappings, which hid
  first-run problems.
- Cua Driver 0.38 drove the window in the foreground. Every action saved a screenshot,
  and each observation was journaled with its frame and a box on the screenshot.
- The five Audit 3 sets were imported through the native file dialog. Reviews ran on
  Muse Spark Open (Baseten), plus one fire-alarm review on Muse Spark 1.3 using the
  default model a new user gets: brewery 29 sheets, laundry 13, porch 9, civil 5
  (Civil discipline scope), and fire alarm 3. Four ran concurrently.
- A civil revision was built that keeps four sheets, removes C-4 and adds one page, so
  removed and added sheets are both exercised.
- One cloud review (fire alarm, Muse Spark Open) ran on the audit worker image, with an
  app restart while the job was running. It uploaded 311.7 MiB (191 files), ran 36 calls,
  recorded 132/132 passes with 11 findings in 13:04, and synced back 340.5 MiB. Modal
  reported no running sandboxes afterwards.
- Fixes found in this pass were made, rebuilt into the same install, and re-checked in
  the native app. Those frames are marked AFTER FIX on the board.

The deliverable is an Excalidraw board in the format of `MokeAudit1/2.excalidraw`:
`.local/audit-3-recheck/MokeAudit3Recheck.excalidraw` (copied to the Windows Desktop).
It has screenshots in walkthrough order, red boxes and arrows to red notes for
problems, green for what works, and blue for fixes re-checked after a rebuild.

## Results by original finding

| ID                                      | Recheck result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3-01 full-set reviews stop early       | None of the five fresh reviews hit a provider failure, timeout or HTTP 400. All returned findings (17–46 min). Large sets still stopped early: brewery 25/29 sheets and 4/1,276 passes while summarizing "completed". **Fixed in this pass:** unbudgeted reviews that call `finish_review` with unopened sheets or unrecorded passes are sent back (see below). The brewery re-run opened 29/29 sheets and recorded 220 passes.                                                                                                                                                                                              |
| M3-02 error offers only Cancel          | Not re-exercised; no provider failure occurred in this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3-03 Connected before preflight        | Settings reads Connected after the image and secret preflight. A missing secret was not re-tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M3-04 reopen lands on the wrong project | Holds. A restart during the cloud job reopened on the job's conversation, model and location with edits locked. The card now names the job's project from the local list instead of `Project <id>`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M3-05 scope leaks across projects       | Scope stays per conversation. **Fixed:** after a restart the model fell back to the default, and one brewery re-run went to Muse Spark 1.3 by mistake. A conversation now restores the model of its last review. Rechecked after a restart.                                                                                                                                                                                                                                                                                                                                                                                  |
| M3-06 invisible count form              | Focus and scroll hold. **Was broken on a fresh project:** the sheet lists only offered "confirmed" sheets, so they were empty. **Fixed:** all sheets are listed and unverified ones are marked. The form asks the user to confirm the chosen sheets, and changing a sheet clears that confirmation (Sol S2).                                                                                                                                                                                                                                                                                                                 |
| M3-07 generic page names                | Holds for the five audit PDFs, which carry embedded page labels. **Open:** without page labels (a merged revision) the printed-text fallback named 1 of 5 pages. Rows are still tall (three per screen) and labels repeat the page number.                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-08 revision mapping                  | Removed, saved and paired-thumbnail mapping hold. **Fixed:** explicit "Added in this revision" state; Escape in the comparison no longer closes the panel; pre-apply copy. **Open:** no automatic matches for real (non-identical) revisions; the "larger" comparison is an upscaled thumbnail.                                                                                                                                                                                                                                                                                                                              |
| M3-09 sheet navigation                  | Previous/next/jump hold. **Fixed:** zoom leaked into unrelated sheets and crops; the jump popover opened off the window edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-10 evidence layout                   | Holds. **Fixed:** a saved crop is now labeled "partial view of this page".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-11 cloud progress                    | Holds: tool, drawing, file counters and stage. **Fixed:** missing spaces in the job line, raw IDs, repeated status lines, a finished upload bar left on screen, and no status between Send and the first receipt. **Open:** the local review card shows only counts.                                                                                                                                                                                                                                                                                                                                                         |
| M3-12 stale receipts                    | Scoped per conversation. **Fixed:** Dismiss is remembered across restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-13 cancel rewrites duration          | Holds: pause freezes the clock, and cancel keeps the active time and saved work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M3-14 notices leak                      | Holds across projects. **Fixed:** "Review status refreshed." stayed stacked above a changed state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M3-15 coverage wall                     | Discipline table and filters hold. **Fixed:** the "coverage gaps" headline sat above "132 of 132 recorded" with no explanation; raw `camelCase` configuration keys and Title Case values.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3-16 compact window                    | Sheets and More stay reachable. **Fixed:** threads opened at the top after a resize or project switch. They now stay at the latest message unless the reader scrolls up, even during rapid updates (Sol R1). At 900×900 the active cloud card pushed Send below the window; its details now scroll within a height that fits the window. Both rechecked at 900×900.                                                                                                                                                                                                                                                          |
| M3-17 Windows copy                      | Ctrl K and plurals hold. **Partly fixed:** search covers only the current conversation and the project's count checks; the field now says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-18 false absence claims              | Both reviews read the battery and NAC calculations correctly. **New P1, seen twice:** the local Muse Spark 1.3 review said the NAC#2 table continuation was "not located". The cloud Muse Spark Open review said the matrix input column was "truncated/clipped in supplied PDF" and made up row labels. Both tables are complete on FA-1 (checked against the PDF at 150 DPI), and each time the model's own crop had cut them off. **Partly fixed:** "not located/not found/unable to locate" now trigger the absence gate, and round 2 adds crop-edge guidance to `render_sheet`. Model reading accuracy remains a limit. |
| M3-19 report export                     | Holds (native Save, 12.5 MB HTML). **Fixed:** the export had the same unexplained gap headline, raw keys and ISO timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3-20 maintenance error                 | Not seen during upload or while browsing other projects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-21 Pause                             | Pause, Refresh and Resume work. **Partly fixed:** Resume right after Pause failed with internal "draining" wording; the message is now plain, but the card still cannot show that a request is in flight.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3-22 invalid package                   | Holds for the original empty-folder case ("The package manifest is missing").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-23 governing sources                 | Holds: URL, retrieval time, Open in browser, saved text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-24 cloud capacity                    | The estimate and limits hold. **Fixed (P1):** Send was enabled while other projects had local reviews running. The request was saved as an orphan, and the error named nothing. Send is now disabled, and the panel names the blocking projects. Returning to a conversation set to cloud re-measures the workspace (Sol S1). **Open:** a fresh five-project workspace reached 252–363 MiB within an afternoon, and every cloud job still transfers all of it.                                                                                                                                                               |

## Review and verification

The Sol review (gpt-6.1-sol, xhigh) is still in progress. Round 1 found
two problems. The pre-send blocker list could go stale after switching
conversations (S1). A ticked source confirmation survived changing the sheet
(S2). Round 2 found that the thread's own automatic scroll could cancel
follow mode when updates arrived quickly (R1). All three were fixed with
regression tests. The S2 and R1 tests failed before their fixes.

Round 3 confirmed R1 but found T1: manually returning to the same bottom
position did not restore following. Commit `185c6f315` clears the old automatic
scroll marker after reader input. Its new regression failed twice without the
fix and passed three times with it. Round 4 confirmed T1, then found U1: the
numeric sentinel `-1` is within the two-pixel tolerance of scroll position zero.
If a resize makes the thread fit, that scroll event can be ignored, leaving
following disabled when the window shrinks again. U1 is fixed with an absent marker and a resize regression. The new case
failed before the fix, 5,915 pixels behind the latest message, then passed in
three consecutive desktop runs. Round 4 is not approval of the current
change. The loop extends to five rounds for these evidenced UI state and event
ordering findings; no additional round is authorized beyond that budget.

Usage was not exposed. The private Xvfb runner is available to the parent at
`/tmp/moke-invisible-display/runtime/usr/bin/Xvfb`; the round-4 reviewer reported
it unavailable in its own environment, so its reproduction used headless Chromium.

## Coverage gate

`finish_review` previously accepted a finish at any time. The brewery review stopped
after opening 25 of 29 sheets and recording 4 of 1,276 required passes, and summarized
the work as complete.

When the user has set no call budget, the host now returns an early finish while sheets
are unopened or required passes are unrecorded. The message lists the unopened sheets
and tells the reviewer to open them and record passes with `record_coverage_batch`,
marking disciplines that do not apply as not applicable with a reason. Budgeted reviews
are never sent back, because every retry spends a call against the user's limit.

With the first version, which returned a finish up to twice, the brewery re-run opened
29/29 sheets and recorded 220 passes in 33:34. After the second return, the model ended
without calling `finish_review` again, so the run showed "Review stopped". The gate now
returns a finish once and says the next finish will be accepted with gaps recorded.

The audit cloud worker image predates the gate; cloud reviews get it with the next image
build.

## Provider timeouts

See [audit-3-provider-timeout.md](audit-3-provider-timeout.md#recheck-what-the-300-second-limit-measures).
The 300-second limit applies only until the response headers arrive. Baseten returned
headers in 0.7 s, and the stream showed no gap over 142 ms. A 259-second call
therefore completes normally, and the earlier stop was a request that sent no headers
for five minutes. The limit is unchanged.

## Open items

- Disciplines are not proposed from sheet prefixes (C-, S-, M-, E-, P-), so discipline
  reviews on large sets need manual assignment.
- The sidebar does not show which projects have reviews running.
- There is no workspace-wide search and no project-only cloud transfer.
- Revisions get no automatic matches unless the PDFs are byte-identical, and the
  comparison view is low-resolution.
- The local progress card does not show the current tool or drawing.
- Compact windows leave little room for the thread.
- Polish: light native menu bar in dark mode; the settings dot is a status indicator
  shown without a label; the revision label defaults to "Rev 1" on a second import; the
  Save dialog suggests "MOKE-review" as the filename.

## Closing the desktop during CI

The final full run reproduced the old macOS failure on Linux:
`audit-2.spec.ts:133` completed its UI assertions, saved its final screenshot
and empty console diagnostics, then timed out inside `app.close()`. The worker
also timed out during teardown. Twelve other desktop tests passed. This was
not evidence of a failing import or count interaction.

The desktop had prevented `before-quit` while disposing the RPC runtime, keeping
renderer windows and their streaming connections alive during shutdown. Cleanup
now runs at `will-quit`, after the windows close and their ports disconnect. The
same runtime disposal and backend cleanup remain awaited before process exit;
no process-kill workaround or longer test timeout was added. A private compiled
probe of that event change passed all three Audit 2 desktop flows twice, including
the previously hanging flow in 4.9 and 5.7 seconds.

[Electron's app event documentation](https://www.electronjs.org/docs/latest/api/app),
checked through Exa via Executor on 2026-10-29, confirms this event ordering and
that `will-quit` supports `preventDefault`. A fresh complete verification and
macOS CI remain required; the Linux probe alone does not establish macOS success.

Final local verification for U1 and the shutdown change passed on Bun 1.4.4:
`bun run verify` completed all 359 smoke tests (39 files), 13 desktop tests,
typecheck, lint, formatting and builds. The formerly hanging flow finished in
4.7 seconds. The Svelte autofixer reported no issues. Final Sol approval and
fresh macOS CI are still pending.

The latest Civil cloud follow-up returned and imported successfully: 22 calls,
5/5 sheets opened and 14/220 passes recorded. The native receipt says Results
synced. That is successful transfer, with incomplete review coverage. The earlier
separate Opus delegate failed with `Provider turn failed`; it is not counted as an
approval. The subsequent fresh-workspace walkthrough was performed by Opus 5.5
in this parent thread, then reviewed and corrected through the Sol rounds above.

The packaged Windows resize check used two saved audit notes, without starting
inference. After scrolling up in a 900×700 window, enlarging to 1633×1600 made
the entire thread fit (frame 1606); shrinking back to 900×700 kept the end of
note B visible (frame 1610). An earlier 1132-pixel-high attempt did not establish
that the thread fitted, so it is not counted as acceptance. File → Exit closed
the rebuilt app, its PID disappeared from the running-app list, and reopening
retained both notes (frame 1593). The audit copy is idle; the user workspace is
unchanged.

## Fifth review: exact-top resize case

Round 5 returned CHANGES, not approval. It accepted C1 (the shutdown order) and
found V1: U1 remained open when the reader was already at scroll position zero.
Making the whole thread fit then need not produce a scroll event, so the earlier
nullable marker fix could not restore following on its own.

The observer now follows when following is already enabled **or the whole thread
fits in the viewport**. The nullable automatic-scroll marker stays in place.
The regression keeps the prior cases and adds an explicit scroll to zero before
the fit/shrink sequence. It verifies full fit before shrinking; the meaningful
pre-fix run failed at 6,315 pixels behind after shrinking, then three post-fix
runs passed. An initial probe that did not reach full fit is excluded.

Five rounds exhaust this recheck's budget. The current correction has parent
validation but has not been approved by a further Sol review. Nothing is pushed
or merged on the basis of the exhausted budget. Usage was not exposed.

The exact-top case was then repeated in the packaged Windows app, using the
same two saved notes. The previous build remained on note A after the
fit/shrink sequence (frame 1647). In the corrected build, Ctrl+Home established
the top (frame 1677); both full notes fitted in the enlarged window (frame 1681);
after shrinking, the end of note B stayed visible (frame 1685). No inference was
sent for these checks. This is direct native evidence, independent of the test.

The final V1 implementation passed `bun run verify` on Bun 1.4.4: all 359 smoke
tests (39 files), 13 desktop tests, typecheck, lint, formatting and builds. The
Svelte autofixer reported no issues. The scoped regression also passed three
consecutive runs. The latest native board contains 71 selected screenshots.
Sol round 5 accepted shutdown fix C1; its remaining resize finding is corrected
and parent-verified, with any further independent recheck awaiting the user's
review-budget decision. Fresh macOS CI is still pending.
