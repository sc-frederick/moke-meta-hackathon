# Live cloud review validation

Observed October 29, 2026 UTC (October 28 in New York), using Bun 1.4.4,
`modal@0.11.1`, the `moke-reviews` App, and `moke-review-engine:latest`.
Only Moke's authored two-sheet schematic was uploaded. No customer drawings
were used. Account credentials were delivered privately and are excluded from
the repository and worker image.

## Completed review

The normal run used a twelve-call admission budget and completed after **seven
admitted calls**. The end-to-end acceptance script took **34,149 ms**, including
source preparation, cloud transfer, closing/reopening the compiled local backend,
progress reconnection, external result snapshot download, confirmed remote stop,
complete-package import, and a subsequent local edit.

| Check                      | Observed result                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Execution                  | Completed; Meta `muse-spark-1.3`; zero unresolved attempts                                |
| Drawing count              | Proposed 2 type A luminaires in Room 101                                                  |
| Scheduled count            | Proposed 3                                                                                |
| Domain acceptance          | Both facts remained proposed; no finding closed or task completed                         |
| Source integrity           | Original SHA256 unchanged across return                                                   |
| Evidence                   | Five retained artifacts and the final conversation response                               |
| Disconnect/reopen          | Same cloud job reconnected after the local backend exited                                 |
| Local ownership            | Writes rejected during cloud execution, accepted after import                             |
| External result checkpoint | Downloaded from a directory snapshot through a separate reader sandbox                    |
| Exit recovery              | Completed progress and output recovered from the stopped original sandbox's exit snapshot |

[Recorded result](cloud-validation-result.json) contains the actual run/job IDs,
execution status, source hash, counts, and elapsed time. The complete package and
closed journals are retained under the ignored local validation directory. The
reported 448,000 reserved input tokens and 14,336 reserved output tokens are
conservative admission reservations, not measured usage. **Verified dollar cost
and image token accounting remain unknown.**

## Partial result behavior

An earlier eight-call-budget run reached its admission cap after proposing the
same drawn **2** and scheduled **3**. Its execution state was `failed`, with zero
unresolved attempts, and it had not written a final model answer. Its complete
package still returned successfully in 43,921 ms. The product identifies this
case as **Partial results ready** instead of claiming the inspection finished.

## Issues discovered by live checks

- The base Bun image exits without an explicit long-lived sandbox command. All
  preparation, review, warm, and recovery sandboxes now use `sleep infinity`
  alongside their bounded lifetime.
- The current outbound secret injection API cannot be combined with a separate
  domain allowlist. The engine uses canonical provider routes, and authorization
  injection is scoped to the exact provider host. Sandbox-wide egress filtering
  is not claimed for this configuration.
- Injection requires a named Secret. The application references
  `moke-reviews-meta-api` or its configured app/provider equivalent. Creating the
  named Secret is an operator step; the application and workers use Bun.
- SDK exec timeouts must be whole-second millisecond values. Transfer deadlines
  are rounded down before dispatch, and the worker contract rejects incompatible
  precision. This failure was caught before any model request in the affected
  setup attempts; those empty test sandboxes were confirmed stopped.
- SDK failures now emit bounded diagnostics with known credential values
  redacted. Renderer errors retain safe application messages.

## Remaining limits

A killed sandbox without a complete result package is not automatically replayed from a source snapshot;
the local source remains intact, while uncheckpointed remote work can be lost and
prior calls can remain uncertain. This implementation starts new cloud reviews
and does not migrate a paused local Pi journal. These boundaries are also listed
in [cloud setup and recovery](../cloud-reviews.md).

## Warm sandbox lifecycle probe

A separate live probe made **zero model calls** and verified that an expired
candidate is skipped, an image mismatch is terminated, a valid candidate is
claimed, and the claimed execution can be found and stopped by its durable job
name even before its sandbox ID is saved. An incompatible worker was terminated,
and allocation then succeeded through the cold fallback. All probe sandboxes
were stopped and the temporary queue was deleted.

The first probe exposed an SDK queue serialization issue: a numeric millisecond
deadline was truncated to a signed 32-bit integer. Queue records now use JSON
strings, preserving the full deadline. Rejected candidates must finish stopping
before allocation continues. Warm capacity remains opt-in and is disabled in the
configured desktop connection.
