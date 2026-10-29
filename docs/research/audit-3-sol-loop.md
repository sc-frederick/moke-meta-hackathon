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
