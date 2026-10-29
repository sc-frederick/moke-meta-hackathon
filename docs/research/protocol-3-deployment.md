# Protocol 3 deployment and operator synchronization

Protocol 3 is deployed to Modal app `moke-reviews`, environment `main`.
The deployment and this checkout's private operator setup are synchronized.
The one live validation returned its package safely, but did not complete model
inference. Its single sent request remains uncertain and was not retried.

## Published image

| Field                                            | Verified value                             |
| ------------------------------------------------ | ------------------------------------------ |
| Source commit                                    | `d7ba4f87415b1715189b1ee364108bef96ed87f0` |
| Immutable tag                                    | `moke-review-engine:d7ba4f874`             |
| Latest alias                                     | `moke-review-engine:latest`                |
| Image ID for both names                          | `im-01M630XTWWQWB3FM0K4NY8NR0D`            |
| Selected private operator image                  | `moke-review-engine:d7ba4f874`             |
| Protocol                                         | `3`                                        |
| Engine                                           | `review-pi-1.4.0-v1`                       |
| Count prompt                                     | `moke-selected-coordination-v2`            |
| Packet prompt                                    | `moke-packet-review-v1`                    |
| Instructions                                     | `8a0e2648738018631eaa6d24ee0b6ebaa239afb1` |
| Published                                        | `2026-10-29T05:08:07.883Z`                 |
| Latest alias and operator selection synchronized | `2026-10-29T05:08:37.406Z`                 |
| Final alias and cleanup verification             | `2026-10-29T05:10:29.540Z`                 |

The SDK resolved the previous immutable tag and `latest` before publication.
Both named `im-01M62TGRYMR5FNNF3BJVSXR2PX`. A bounded, network-blocked
probe verified its protocol-2 identity. The old tag and image remain available.

An ignored operator script followed `scripts/modal.ts image`: Bun 1.4.4 built
the current worker and PDF worker, the Modal base image installed exact canvas
1.0.13 and PDF.js 6.4.299 dependencies, and preparation copied only those two
workloads and the nine existing SQL migrations. The script additionally retained
image and owned-sandbox receipts. It checked the current identity, took a
non-expiring filesystem snapshot and published the immutable tag first.

A fresh sandbox resolved from that tag passed the worker readiness probe and
strict protocol/engine/prompt/instruction decoding. All nine remote migration
SHA256 values matched this checkout. The real PDF worker inspected the authored
two-page fixture and rendered its first page to a 612 x 792 PNG of 49,988 bytes.
This readiness sandbox blocked networking and made zero model calls. The first
readiness attempt stopped on a local probe-script schema construction error;
the corrected probe passed. Both attempts were confirmed stopped. No application
implementation changed.

Only after readiness passed did the operator publish `latest` and change this
checkout's selected image. Final SDK reads confirmed both names resolve to the
same new image ID. The existing private connection files were copied into this
checkout's ignored `.local/modal/session.json` and `.local/provider/session.json`
with permissions 600. The ignored `.env` now selects those files, preserving
unrelated content. The provider copy is unchanged; the Modal copy differs only
in its selected image. The old worktree's private configuration remains unchanged.
The timeout remains 15 minutes, `poolQueue` remains null, and no warm controller
or capacity was started. The named Secret `moke-reviews-meta-api` was reused
through outbound header injection. No model key was retrieved from Modal.

## One bounded live validation

The unmodified `bun scripts/validate-cloud.ts --live --calls 12` ran against the
freshly built headless `BackendApi` at `2026-10-29T05:08:42.067Z`. It used only
the repository-authored Rev A two-sheet schematic in a new isolated data
directory. It did not access the live desktop or user workspace.

- Cloud job: `1773f02d-546f-4363-9009-ced31ca284cb`.
- Sandbox: `sb-01M630YXGCYGG5K4N1J4MBAMQ2`.
- Input snapshot: `im-01M630Z26DRAVRV31PTJAEXQV0`.
- Result snapshot: `im-01M630Z6W3T6MJE33STE9DPB56`.
- Provider/model: Meta `muse-spark-1.3`, without provider fallback.
- Limits: 12 calls, 64,000 input tokens and 2,048 output tokens per admitted
  call, 15-minute cloud deadline, zero automatic provider retries.
- Actual accounting: one admitted and sent model request, one unresolved
  attempt, no successful response receipt, zero SAM calls. Cost and image input
  tokens are unknown. Reserved text/output tokens are 64,000 / 2,048.

The durable receipt records `workerProtocol: 3`. The backend rejected a local
write while the cloud owned the fixture, closed completely, reopened with the
same job and observed progress over RPC. The observed phases were `dispatching`,
`ready`, `importing` and `imported`. It automatically restored the returned
package through the existing verification and maintenance boundary. A separate
read of all three manifest-authorized output files confirmed their byte counts
and SHA256 values. The original PDF hash remains
`5fcb96c2fd1893b714218bb931ac50697db19e30f19735f0f58d49a81ceace91`.

The model execution became `uncertain` after its first sent request. The normal
validator therefore exited 1 after import because it requires completed
inference, proposed drawn 2 / scheduled 3, and a final conversation answer.
This run produced no count facts or final model answer. No successful provider
receipt or reliable HTTP failure classification is retained, so the cause is
unknown; it is not evidence that credentials are invalid or inference succeeded.

A subsequent headless reopen inspected the same saved job and snapshot, confirmed
there was still only one run and one admitted call, and successfully saved a
fixture-only local message. The unresolved attempt remains unacknowledged and
was never resumed or replayed. Findings remain open. Source hashes are unchanged.
The original review sandbox was confirmed stopped with exit 137, the result of
the orchestrator's explicit termination after checkpointing.

This proves protocol-3 admission and the safe cloud transfer/return path even
when inference is unresolved. It does not establish successful protocol-3 model
counts, a live packet/scope review, or the original A08 transport disconnect
trigger. Existing offline scope and lifecycle recovery evidence remains as
recorded in [Audit 2 validation](audit-2-validation.md).

## Rollback, retained evidence and cleanup

Rollback reference: `moke-review-engine:c359e522`, image
`im-01M62TGRYMR5FNNF3BJVSXR2PX`, source
`c359e522f06f1a73888057233b4854193e2da9b2`. It was verified as protocol 2 before
this deployment. An authorized rollback can republish that image under `latest`
and select its immutable tag in the private operator configuration. New
protocol-3 clients would refuse it for fresh reviews, so an application rollback
must be coordinated. Recovery of existing jobs retains its separate compatibility
rules. No image was deleted or rollback performed.

Sanitized tracked evidence is in
[protocol-3-deployment-result.json](protocol-3-deployment-result.json).
Local operator artifacts are under `.local/protocol-3-deployment/`:

- `before.json`, `previous-identity.json`, `published.json`, `readiness.json`,
  `promoted.json` and `final-check.json` record identities and resource state.
- `inspect.log`, `publish.log`, `readiness-attempt-1.log`, `readiness.log`,
  `promote.log` and `backend-build.log` retain deployment/build output.
- `live-validation.log`, `inspect-live.log` and `live-evidence.json` retain the
  nonzero validation outcome and inspection without retry.
- `*-owned.json` and `*-cleanup.json` record the previous-image probe,
  preparation sandbox and both readiness attempts. `final-check.json` also
  records the live-review sandbox and confirms all five are stopped.

The fixture, admitted request, complete input/output packages, ownership receipt
and execution journal are preserved under
`.local/cloud-validation/2026-10-29T05-08-42.067Z/`. Durable snapshots are retained
under the existing seven-day checkpoint policy. Final SDK lists found zero
running sandboxes with this operation's probe/preparation tags or live job tag.
Only owned resources were stopped. No queue, warm capacity or user dataset was
changed. No GUI, preview, development server, desktop restart, push, PR or merge
was performed.

## Repository validation

The deployment record introduces no application changes. The deployed
application source remains the already verified `d7ba4f874`. Its existing local
evidence is 321 smoke tests with 2,152 assertions, seven isolated Electron tests
and seven packaged tests in `.local/audit-2/ci-11-verify.log` and
`.local/audit-2/ci-11-packaged.log`. The parent supplied passing Linux, macOS and
Windows hosted checks, including packaged tests, for merged PR #11. Those checks
were not rerun here. The backend build, repository formatting and diff checks
passed for this deployment. No application behavior or isolation guard changed.

SDK operations were checked against the installed `modal@0.11.1` source and the
official [Image API](https://modal.com/docs/sdk/js/latest/Image) and
[Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox).

The first Windows CI run exceeded Bun's default five-second deadline in three
integration tests; a single rerun still timed out the continuation case at about
seven seconds. Those three cases now use explicit 15-second test limits, matching
adjacent integration tests. Their assertions, application deadlines and isolation
controls are unchanged. Focused validation passed three tests with 114 assertions;
full verification passed 321 smoke tests with 2,152 assertions and seven isolated
Electron tests. Evidence is retained in `ci-timeout-focused.log` and
`ci-timeout-verify.log` under the local deployment evidence directory.
