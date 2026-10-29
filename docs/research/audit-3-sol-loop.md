# Audit 3 Sol review ledger

Base: `4f17b8b5492c5293996ae19fe5e6fe3c8609faf8`.
Review command for every round:
`git diff 4f17b8b5492c5293996ae19fe5e6fe3c8609faf8 -- backend desktop src scripts migrations tests`.

Reviewer: Codex provider, `gpt-6.1-sol`, verified `xhigh` reasoning.
Default budget: three rounds. The native return audit exposed a state/concurrency issue; the skill permits extending to five rounds for this evidenced should finding. Usage was not exposed.

| Round | ID  | Severity | Outcome                                                                                                                                                                                                                                              |
| ----- | --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | S1  | should   | Fixed plural absence nouns, including calculations, tables, schedules and matrices. Real packet-tool regressions reject these claims without the required source search.                                                                             |
| 1     | S2  | should   | Fixed historical display replacing the latest execution owner. The latest panel and controls stay present; history uses a separate read-only panel. Desktop regression preserves paused-run controls and blocks a new request while reading history. |

Round 1 verdict: CHANGES. No declined findings. Before fixes: 52 behavior/test
files, 2,817 insertions and 347 deletions. Later rounds review changed code and
these findings only. No push or PR during the loop.

Round 2 verdict: APPROVE. S1 and S2 resolved; no new in-scope issues. The reviewer
observed two failures in an earlier findings-menu step before the new paused-history
assertions. Investigation found a delayed source refresh closing a newly reopened
menu. The redundant asynchronous close was removed (the initial selection already
closes it). A real MessagePort regression now holds and releases that snapshot,
checks that the reopened menu remains visible, and reaches the paused-history
assertions. The focused desktop flow passes in 21 seconds. This behavior change
is submitted for round 3; round 2 alone does not approve that final change.

Round 3 verdict: APPROVE. No new S3 finding; S1/S2 remain resolved. The reviewer
independently passed the focused desktop flow in 22.4 seconds, including the
delayed snapshot/menu and paused-history assertions. Svelte analysis found no
issues. Final behavior/test diff: 53 files, 2,926 insertions and 365 deletions.
All three rounds used gpt-6.1-sol on verified xhigh; usage was not exposed.
Nothing was declined. The branch was not pushed during review.

Round 4 scope: repeat Windows acceptance found snapshot reads waiting behind the
entire cloud download (eventually a generic load error), and interrupted SDK
copies restarting hundreds of completed downloads and leaving an unlisted
scratch file. These are state/concurrency and workspace-return failures.

- S3 (should, own audit): snapshot reads now use the existing SQL exclusion
  shared with package replacement, rather than waiting for network maintenance.
  The pending-restore guard runs inside that SQL exclusion before opening SQLite.
  Held upload/download regressions require reads before transfer release while
  writes remain fenced.
- S4 (should, own audit): retries reuse only size/SHA-256 verified files from the
  immutable result manifest. After copy completes, cleanup removes only Modal
  0.11's exact scratch-file pattern from this job's download directory. Other
  unexpected files remain subject to full package validation.

Native proof: the same 482.8 MiB input / 503.8 MiB result recovered without
re-running inference, reached imported with seven findings and 12/12 passes,
released local controls, and left zero running Modal sandboxes. The focused
cloud tests pass 33 tests / 429 assertions. Full verification passes 343 smoke
tests and nine desktop tests; final typecheck/lint/format also pass. Round 4
reviews only these changes and confirms the prior resolved findings stay fixed.

Round 4 verdict: APPROVE. S1/S2 remain resolved; S3 and S4 resolved. No new
in-scope concurrency or recovery issues. The reviewer independently passed
33 focused cloud tests and 429 assertions. Final behavior/test diff: 53 files,
3,087 insertions and 393 deletions (round 1 began at 52 files, 2,817 insertions
and 347 deletions). All four rounds used gpt-6.1-sol on verified xhigh. Usage
was not exposed; no findings were declined. Push is authorized after this
approval by the user's full-send request.

Round 5 scope: the first PR Windows run failed a five-second source-selection
help assertion before asynchronous rendering had finished. Only the polish
desktop test changes: wait for the prior image before starting selection, hold
and release its real RenderSource response, assert rendering and readiness,
then retain the pointer-drag/PDF-coordinate/coverage checks. Readiness uses a
15-second bound. Application behavior remains exactly as approved in round 4.
This final focused recheck covers asynchronous test-state ordering.

Round 5 verdict: CHANGES. S5 (should) found that the prior image could still be
visible while scheduled acceptance was pending. A 500 ms delayed acceptance
response caused the render hold to capture acceptance's refresh instead of
selection. The smallest suggested fix is implemented: wait for the Select area
button to be enabled before checking the prior image and arming the hold.
A strict private probe fails the old ordering on the misidentified response and
passes the fix, with all three held responses belonging to Select area.
Application behavior is unchanged from round 4. The five-round budget is
exhausted; final recheck or a user-authorized waiver remains pending. Usage
was not exposed; nothing was declined and this follow-up has not been pushed.

Post-S5 proof: full `bun run verify` passes 343 smoke tests and nine desktop
tests, with polish in 9.9 seconds. The strict delayed-acceptance probe fails
without the enabled-control wait and passes with it. The application diff is
unchanged. This test follow-up remains local pending the user's review-budget
choice; the PR still points to the round-4 approved application commit.

The user explicitly authorized one additional focused Sol recheck after the
five-round budget was exhausted. Round 6 checks only the S5 enabled-control
ordering fix and confirms that prior application approvals remain applicable.
The test follow-up stays unpushed until this recheck returns.

Round 6 verdict: APPROVE. S5 resolved: the side-specific Select area button
must be enabled before the prior image check and render hold; the same locator
is clicked afterward. The reviewer confirmed the strict red/green probe
evidence and preservation of readiness, coordinates and coverage assertions.
No new blocker or should finding. No tests were rerun by this reviewer.

Final result: S1–S5 resolved, no declined findings. Six rounds used
gpt-6.1-sol on verified xhigh; usage was not exposed. Final behavior/test diff
is 54 files, 3,106 insertions and 398 deletions, compared with 52 files,
2,817 insertions and 347 deletions entering round 1. The user authorized the
sixth round. The CI follow-up is approved for push after this agreement.
