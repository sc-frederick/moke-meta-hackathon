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
| M3-05 scope leaks across projects       | Scope stays per conversation. **Open:** after a restart the model falls back to the default (a brewery re-run went to Muse Spark 1.3 by mistake). Round 2 restores the conversation's last review model.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-06 invisible count form              | Focus and scroll hold. **Was broken on a fresh project:** the sheet lists only offered "confirmed" sheets, so they were empty. **Fixed:** all sheets are listed, unverified ones are marked, and the form asks the user to confirm them.                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-07 generic page names                | Holds for the five audit PDFs, which carry embedded page labels. **Open:** without page labels (a merged revision) the printed-text fallback named 1 of 5 pages. Rows are still tall (three per screen) and labels repeat the page number.                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-08 revision mapping                  | Removed, saved and paired-thumbnail mapping hold. **Fixed:** explicit "Added in this revision" state; Escape in the comparison no longer closes the panel; pre-apply copy. **Open:** no automatic matches for real (non-identical) revisions; the "larger" comparison is an upscaled thumbnail.                                                                                                                                                                                                                                                                                                                              |
| M3-09 sheet navigation                  | Previous/next/jump hold. **Fixed:** zoom leaked into unrelated sheets and crops; the jump popover opened off the window edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-10 evidence layout                   | Holds. **Fixed:** a saved crop is now labeled "partial view of this page".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-11 cloud progress                    | Holds: tool, drawing, file counters and stage. **Fixed:** missing spaces in the job line, raw IDs, repeated status lines, and no status between Send and the first receipt. **Open:** the local review card shows only counts, and the active cloud card is very tall.                                                                                                                                                                                                                                                                                                                                                       |
| M3-12 stale receipts                    | Scoped per conversation. **Fixed:** Dismiss is remembered across restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3-13 cancel rewrites duration          | Holds: pause freezes the clock, and cancel keeps the active time and saved work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M3-14 notices leak                      | Holds across projects. **Fixed:** "Review status refreshed." stayed stacked above a changed state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M3-15 coverage wall                     | Discipline table and filters hold. **Fixed:** the "coverage gaps" headline sat above "132 of 132 recorded" with no explanation; raw `camelCase` configuration keys and Title Case values.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3-16 compact window                    | Sheets and More stay reachable. **Fixed (round 2):** threads opened at the top after a resize; the active cloud card pushed Send below the window at 900×900.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-17 Windows copy                      | Ctrl K and plurals hold. **Partly fixed:** search covers only the current conversation and the project's count checks; the field now says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-18 false absence claims              | Both reviews read the battery and NAC calculations correctly. **New P1, seen twice:** the local Muse Spark 1.3 review said the NAC#2 table continuation was "not located". The cloud Muse Spark Open review said the matrix input column was "truncated/clipped in supplied PDF" and made up row labels. Both tables are complete on FA-1 (checked against the PDF at 150 DPI), and each time the model's own crop had cut them off. **Partly fixed:** "not located/not found/unable to locate" now trigger the absence gate, and round 2 adds crop-edge guidance to `render_sheet`. Model reading accuracy remains a limit. |
| M3-19 report export                     | Holds (native Save, 12.5 MB HTML). **Fixed:** the export had the same unexplained gap headline, raw keys and ISO timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3-20 maintenance error                 | Not seen during upload or while browsing other projects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-21 Pause                             | Pause, Refresh and Resume work. **Partly fixed:** Resume right after Pause failed with internal "draining" wording; the message is now plain, but the card still cannot show that a request is in flight.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3-22 invalid package                   | Holds for the original empty-folder case ("The package manifest is missing").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M3-23 governing sources                 | Holds: URL, retrieval time, Open in browser, saved text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M3-24 cloud capacity                    | The estimate and limits hold. **Fixed (P1):** Send was enabled while other projects had local reviews running; the request was saved as an orphan and the error named nothing. **Open:** a fresh five-project workspace reached 252–312 MiB after one round of reviews, and every cloud job still transfers all of it.                                                                                                                                                                                                                                                                                                       |

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
without calling `finish_review` again, so the run showed "Review stopped". Round 2
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
