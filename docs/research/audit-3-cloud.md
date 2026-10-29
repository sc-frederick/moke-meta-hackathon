# Audit 3: cloud readiness, capacity, and progress

Date: 2026-10-29. Question: how should MOKE address M3-03, M3-04, M3-11,
M3-12, M3-20, and M3-24 while allowing roughly 3–5 times the previous sandbox
compute cost?

## Evidence and decisions

The Windows audit observed a missing named Baseten secret, an acknowledged job
that survived reopen while the workbench displayed another project, repeated
maintenance errors during normal refresh, and a 271,986,285-byte workspace that
exceeded the former 256 MiB transfer cap. The preserved evidence is in
`.local/audit-3/report/findings.json`; the original audit changed no app code.

Modal's [Secret API](https://modal.com/docs/sdk/js/latest/Secret) exposes
`fromName` with `requiredKeys`. The installed `modal@0.11.1` source confirms
that it issues `secretGetOrCreate` with the requested key names. Its
[Image API](https://modal.com/docs/sdk/js/latest/Image) resolves published
images by name to immutable image IDs. MOKE now checks every configured outbound
provider secret and image before package preparation and ownership recording.
A credential-free, network-blocked, one-minute probe runs the strict worker
identity command. Successful identity validation is cached by immutable image ID
for the runtime, while name and secret lookups repeat before every start. The
probe is always released; its hard lifetime also bounds an ambiguous allocation.
Cloud setup reports the safe actionable failure instead of saying Connected.
No provider key is injected into the probe and no drawings are uploaded to it.

Cold and optional warm review workers now request and cap **4 physical CPU cores
and 8 GiB RAM**, retaining no GPU and no automatic warm pool. Old warm offers
without the new resource profile are rejected and stopped, so they cannot
silently preserve the old one-core configuration.

The complete-package cap is now **1 GiB**, preserving the 5,000-file and strict
path/hash checks. This admits the actual 259.4 MiB audit workspace without
discarding projects or histories. The package size appears during transfer;
limit failures describe the measured manifest size and safe reduction path.
Whole-workspace transfer and atomic replacement remain explicit: transferring
only a selected project requires a separately designed merge protocol. Omitting
unrelated rows from the existing replacement package would lose local projects
on return. Project-scoped cloud sync is therefore unresolved future work,
rather than an unsafe shortcut in this patch.

Read-only workbench snapshots wait for maintenance exclusion to release rather
than emitting an expected-maintenance command error. Local mutations remain
fenced during cloud ownership. The root workbench restores the active job's
project and conversation on reopen. Public cloud status now retains the requested
conversation, model and scope before worker acknowledgement, plus transfer bytes.
Worker progress publishes opened and total sheets, findings, recorded passes and
last review activity. The card shows elapsed and remaining time with an explicit
Ends by deadline. Terminal receipts appear only in their originating project and
conversation and can be dismissed. Disconnected observers do not show a reconnect
warning for a terminal receipt.

## Cost calculation

Research used **Exa through Executor**, fetching the official pricing page and
resource/API guides. [Modal pricing](https://modal.com/pricing) currently lists
Sandbox CPU at **$0.00003942 per physical core-second** and memory at
**$0.00000667 per GiB-second**. These are the Sandbox rates, including the
non-preemptible multiplier; using the lower Function list rates would understate
the cost. [Sandbox resources](https://modal.com/docs/guide/sandbox-resources)
and [resource configuration](https://modal.com/docs/guide/resources) say billing
uses the greater of requested and actual CPU/memory. Hard caps make the following
estimates bounded for the configured resources; transfer, storage, regional
multipliers and provider inference are separate.

| Review worker          | Per hour | 60-minute review + 2-minute cleanup | 6:48 audit runtime |
| ---------------------- | -------: | ----------------------------------: | -----------------: |
| Previous 1 CPU / 2 GiB | $0.18994 |                            $0.19627 |           $0.02153 |
| Selected 4 CPU / 8 GiB | $0.75974 |                            $0.78507 |           $0.08610 |

The selected resource cost is exactly **4 times** the earlier worker at equal
runtime, within the requested 3–5 times allowance and comfortably below $25 for
one hour. A full one-minute 1 CPU / 2 GiB readiness probe costs at most about
$0.00317 in these CPU/memory rates; normal identity validation should finish much
sooner. Setup validates an image once per runtime, not once per status update.

More CPU and memory should help local PDF rasterization, image processing,
package transfer overhead, and memory headroom. It does **not** make the remote
Muse model reason faster or establish that provider timeouts/accuracy are solved.
The exact performance improvement remains an inference pending live measurement.
No GPU or additional always-on service was added.

## Validation and limits

`bun test tests/smoke/cloud-reviews.test.ts tests/smoke/cloud-sync.test.ts
tests/smoke/cloud-workspace.test.ts` covers preflight failure before ownership or
compute, the actual accumulated-workspace size, the raised bound, responsive reads
during held uploads/downloads, real complete-package return, write fencing,
reopen recovery, and legacy in-flight observation. Recovery accepts the prior known packet-prompt
identity only for already-dispatched jobs, preserving earlier paid work without
relaxing new worker admission. Existing strict image identity,
path limits, snapshot requirements and uncertain-request protections remain.
The Svelte autofixer reported no issues for `CloudReviewControls.svelte`.

The unique audit-only image `moke-review-engine:audit3-fixes-20261029` was
last rebuilt as `im-01M63P54VRN8PXFH7FJV3NZMS8`, retaining the existing production
tag and private operator configuration. The real preflight checked both provider
secrets and the new worker identity in 2272 ms. Its cached repeat took 312 ms,
and an independent SDK listing showed zero active preflight sandboxes afterward.
The image was rebuilt after the Baseten eight-image request-window fix and Sol's
plural-absence guard correction, then after the native cloud-return fixes. Fresh current-source bundles match the uploaded
files exactly. A separate network-blocked sandbox read the remote worker bytes:
[both remote hashes match](audit-3-cloud-worker-proof.json), and that proof sandbox
was confirmed terminated. [The safe preflight receipt](audit-3-cloud-preflight.json) records the
image, prompt identities, resource bounds and migration hashes. This preflight
issued no model requests and does not prove successful inference. The parent
validation report records the observed live Windows/cloud outcomes separately.
