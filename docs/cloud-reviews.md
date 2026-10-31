# Cloud reviews

The workbench calls this **Push to cloud**. A reviewer chooses it beside the
message composer, chooses a whole-set or discipline review, and sends their instructions.
The same cloud protocol also supports selected count-check requests.
Moke transfers the workspace, runs a new bounded review away from the computer,
and automatically syncs verified results back when the review finishes.
The infrastructure provider is Modal; that name belongs in operator setup rather
than the review controls.

The implementation uses `modal@0.11.1`, TypeScript, and Bun 1.4.4. Both the
desktop orchestrator and Linux review worker use the existing Effect application
and Pi Durable engine. There is no Python deployment script, public web function,
or incoming HTTP tunnel.

## Operator setup

Configure the existing model connection first; see [inference setup](inference.md).
Create a named Secret in the [Modal Secrets dashboard](https://modal.com/secrets)
with the key `MOKE_API_KEY` holding that provider's API key. Its name is
`<appName>-<provider>-api`: the defaults are `moke-reviews-meta-api` and
`moke-reviews-baseten-api`. The current JS SDK can reference named Secrets but
cannot create them; use the dashboard or Modal's admin CLI for that one-time step.
The application and sandbox workloads remain TypeScript on Bun.

For development, put these additional values in the local, ignored `.env`:

```dotenv
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
MODAL_ENVIRONMENT=main
MOKE_MODAL_APP=moke-reviews
MOKE_MODAL_IMAGE=moke-review-engine:latest
MOKE_MODAL_TIMEOUT_MINUTES=15
# Optional; omit to avoid paying for unused warm capacity:
# MOKE_MODAL_POOL_QUEUE=moke-review-pool
```

Publish the worker image from the current checkout:

```sh
bun run modal:image
```

This command builds the two Bun workloads, installs pinned Linux PDF dependencies
in an image preparation sandbox, copies only those workloads and SQL migrations,
checks the protocol, engine, count/packet prompt and instruction identities, snapshots the filesystem, publishes the named image,
and stops the preparation sandbox. It uses Modal compute credits. Source PDFs,
local data, `.env`, logs, and credentials are not copied into the image. Publish a
matching image again when changing review engine code or migrations. Keep an
immutable image tag per deployed desktop version when distributing builds.

Packaged launches use `MOKE_MODAL_CONFIG` pointing to a private JSON file. They
do not read these credentials automatically from `.env`. The file contains:

```json
{
  "tokenId": "...",
  "tokenSecret": "...",
  "appName": "moke-reviews",
  "environment": "main",
  "imageName": "moke-review-engine:latest",
  "timeoutMinutes": 15,
  "poolQueue": null
}
```

On Unix, set permissions to `600`. The shell parses this file and sends redacted
configuration through the private backend startup pipe. Credentials never enter
renderer RPC or review packages. This is an operator-managed desktop connection;
a hosted account service that provisions end-user cloud access is outside this
implementation.

## Workspace transfer and ownership

The existing portable package contains the **whole application workspace**,
including every project, original PDF, referenced artifact, message, and closed
execution journal. Cloud transfers are capped at 1 GiB and 5,000 files. The UI
discloses this scope before the reviewer sends the request. Files already in the
[workspace cache](#workspace-cache) are not uploaded again.

Finish or cancel local inspections first and acknowledge unresolved paid
requests. Cloud review starts a **new run** with the exact saved reviewer message,
model, discipline, conversation, and call budget (plus the finding for a count check). Copied Pi journals remain historical and cannot
resume. Continuing an already running or paused local agent is not supported.

The application drains local work and exports a consistent package before
dispatch. A flushed local ownership record lives beside the data directory at
`<dataDirectory>.cloud/state.json`; it is deliberately outside portable packages.
While it names an active cloud review, all local domain writes, PDF imports,
render writes, execution controls, and restores are fenced. Read-only review
snapshots and existing artifact reads remain available. Closing or reopening the
desktop preserves this fence. A lost connection never releases it.
The file keeps every receipt, up to 1,000, within an 8 MiB budget that writes and
reads share. A refused write leaves the previous file in place. Retries compare
a SHA-256 digest of the request. Imported and cancelled receipts drop their
finding preview and selected sheet list, about 1 KiB each. A new review is
admitted only if its receipt and 512 KiB of progress still fit; otherwise it fails
before allocation or upload. A larger file from an earlier build is compacted the
same way on the next launch, keeping the active owner and command identities.
Complete package exports remain available as backups of the preserved local
workspace; they do not include cloud changes until results have been imported.

Dispatch is recorded before sending the exec request. Retrying the same command
returns its recorded result and never redispatches it. The remote worker also
claims an exclusive dispatch file before starting the engine. Reopen/status
requests only reconnect; they never start another worker or replay paid calls.

Import checks the original local project/source/fact versions, downloads only
manifest-authorized files, confirms the original sandbox has stopped, then uses
the existing complete-package validation and journaled restore. The pre-restore
package remains available under the normal recovery rules. Interrupted imports
retain their fence and can retry the same downloaded package. Proposed evidence
remains proposed; transfer never accepts counts, asserts coverage, or closes a
finding.

## Workspace cache

Upload time is set by the reviewer's uplink, about 1.8 MiB/s on the measured
development host, so Send no longer uploads files that Modal already holds. See
[the fast initial review research](research/fast-initial-review.md) for the
measurements.

Each workspace has its own Modal Volume (v2), named `<appName>-cache-<id>`, where
`<id>` is a random 16-hex-digit identifier saved in `<dataDirectory>.cloud/cache.json`.
That file sits beside the ownership record, outside portable packages. Every
package file except `app.sqlite` is stored once as `/cache/sha256/<sha256>`:
original PDFs, rendered PNGs and closed journals. Uploads land in `/cache/.staging`
and become visible only after their bytes match the hash in their name; `sync`
then commits the Volume.

- **After import.** A PDF or revision import, opening the cloud composer, and each
  backend launch wake one background seeder. It compares local artifacts with the
  last cache listing and, if anything is missing, starts a short-lived uploader
  sandbox: 0.25 CPU, 512 MiB, network blocked, no provider secrets. It uploads the
  missing files, commits every 64 MiB, and stops early when a Send starts so the
  review gets the uplink. Seeding never holds the cloud review lock.
- **At Send.** The review sandbox mounts the Volume read-only at `/cache`. The
  upload lists `/cache/sha256` once and skips every file whose hash and size match;
  the database is always uploaded. The manifest still describes the complete
  package. Before restore, the protocol-4 worker copies each skipped file from
  `/cache` and checks its size and SHA-256. A missing or mismatched file stops the
  review before any model call. Transfer progress counts skipped files as
  completed and reports them as reused.
- **After Send.** Files uploaded this time are copied into the Volume from the
  input directory snapshot by an uploader sandbox, inside Modal. They do not cross
  the uplink twice.
- **On return.** Result artifacts are content-addressed. Before downloading one,
  the backend copies the matching file from the local artifact store and verifies
  it against the result manifest. Only the database, journals and new crops
  normally download, eight files at a time; files a previous attempt already
  verified are counted first. A 29-sheet result of 435 files (380 MB) took 60 s this
  way and 5.6 minutes one file at a time. New cloud-rendered crops are then copied
  into the Volume from the result snapshot.

**Retention.** The seeder deletes cached files that the workspace no longer
stores locally and that the latest sent or returned package manifest does not
list. It prunes only while no cloud review owns the workspace. A running review
sandbox keeps the Volume view from its start until it stops, so a later prune or
seed cannot change files it is reading. One Volume per workspace means pruning
never removes another workspace's files. Deleting `cache.json` starts a new
Volume; the old one remains until an operator deletes it in Modal.

A failed seed only means more bytes at the next Send. Warm-pool sandboxes have no
cache mount, so a claimed warm sandbox receives every file. The composer shows
the estimated upload beside the bytes already synced.

## Live progress and automatic return

The Bun backend owns synchronization independently of open workbench views.
It streams the current cloud receipt and subsequent updates through Effect RPC:
authenticated NDJSON on the existing loopback endpoint, then Electron's trusted
MessagePort to the renderer. The renderer does not hold Modal credentials or
open a connection to a public sandbox endpoint.

For an active review the backend watches `/moke` with Modal's filesystem watch
API, filtering atomic updates of `progress.json`. These are wake-up hints, not
the source of truth. It reconciles on initial attachment and every ten seconds
as well, covering missed events, unsupported watchers, and connection loss.
The watcher is bounded to thirty seconds and reconnects; local iterator cleanup
has a two-second bound. No watcher starts model work or an additional sandbox.

A drawing-set worker writes `progress.json` at most once a second. Each write
keeps only the latest review state, and the final state is always written.
Besides counts and the current tool, the record carries a **findings preview**:
the 50 most recently recorded findings with ID, severity, discipline, sheet
labels (up to six) and a title cut to 200 characters. The preview is kept under
32 KiB by dropping older entries. It has no observations, corrections, evidence,
prompts or sources. Parallel reviews also report how many sheet reviewers are
queued, running, finished and stopped. The backend refuses progress records over
256 KiB.

The cloud card lists the preview newest first under **Findings so far**, labelled
as a preview. It is read-only: findings cannot be accepted, edited or completed
until the result package is imported. The preview is saved with the local
receipt, so it survives reconnects and restarts. When results are imported, or
the review is stopped, the preview is removed from the receipt and the imported
findings replace it. Upload and download progress also shows how many bytes came
from the cloud cache or a matching local file rather than the network.

When a completed result snapshot is ready, the backend automatically downloads,
confirms remote stop, validates, and restores it through application maintenance.
The interface shows **Syncing results** and refreshes the local conversation and
findings after maintenance completes. It does not require a return/import click.
Progress is live; new artifacts and final conversation results become local only
after complete-package verification, rather than merging a live cloud database.

Closing the application stops its local watcher. The review can continue within
its existing deadline; reopening resumes observation and automatic return without
dispatching the review again. Each receipt has a persistent revision so a late
RPC reply cannot roll the screen back to an earlier phase. New subscribers get
the current state immediately rather than needing an event-history cursor.

Transient network failures retry on reconciliation. Invalid packages, storage
failures, and source conflicts preserve the local fence and surface a safe
explanation with **Retry sync**. They do not cause an automatic download loop.
The pause and its explanation are stored with the receipt, so closing and
reopening the app does not retry an invalid package. Retry sync durably clears
that pause before another attempt. If local results are already imported but
the workbench snapshot fails to refresh, only the screen refresh retries; the
package is not imported again and the receipt is acknowledged only on success.
If a replacement journal needs recovery, reopen the application first.

An invalid package rejected before replacement can be retried with **Retry sync** or
abandoned with **Stop cloud review and return to local work**. If a replacement
journal exists, reopen the application to recover it before stopping or retrying.
Sync errors retain the package validator's safe explanation.

**Stop cloud review and return to local work** requires an explicit acknowledgement
that prior calls may have used credits. Local editing resumes only after the
sandbox is confirmed terminated. This preserves the original local workspace;
it does not silently merge partial remote results.
An explicit provider response that the recorded sandbox no longer exists also
confirms stop, even after it expires from provider history. Permission failures,
connection failures, and an owner still reported as running keep the local fence.

## Secrets and network access

Modal tokens stay in the desktop backend. Model keys are supplied to a Modal
Secret referenced by an outbound HTTPS header policy. Modal injects the real
Authorization header outside the review sandbox, scoped to the exact Meta or
Baseten host. The worker receives a placeholder key and its existing canonical
provider route; neither real credential appears in its environment or source
package. The engine uses the selected model connection; configured Meta tooling remains
available alongside a Baseten chat model. Each connected provider needs its own named
Secret. Both connections use their canonical provider endpoints. Modal's
current injection API cannot be combined with a separate network allowlist, so
this configuration does not claim sandbox-wide egress restrictions. Header
injection is scoped to the exact provider hostname; other destinations do not
receive the model key. See [Modal's injection limitations](https://modal.com/docs/guide/sandbox-secret-injection#limitations).

Header replacement and exit snapshots currently use Modal's experimental SDK
APIs. An unavailable capability fails visibly; there is no fallback that injects
the real key into the worker. A live account check is required before treating
the feature as validated against Modal's service.

## Lifetimes, recovery, and cost controls

Review workers request four physical CPU cores and 8 GiB memory, with matching hard limits,
no GPU, a 15-minute review
limit, and no warm pool. The operator can choose 1–60 minutes. The sandbox gets
an additional two minutes for transfer/checkpoint cleanup. Selected count reviews
retain their call/token admission budget. Drawing-set reviews honor the optional call budget and the shared time limit. Inference remains on the
selected Meta/Baseten service; Modal credits pay for the sandbox, storage, and
related Modal usage. Moke does not read a Modal wallet or promise a dollar cap.
Configure account budgets in Modal separately from these runtime limits.
Transfer and setup consume the same deadline used to claim warm capacity.
Exec timeouts are rounded down to whole seconds, as required by the SDK; a
transfer leaving less than one minute fails before inference dispatch.

The uploaded part of the source package reaches an acknowledged external directory
snapshot before inference dispatch; files skipped at Send are already committed in
the workspace cache Volume. Completed results reach a separate directory snapshot
before the UI reports them ready. Both snapshots have an explicit **seven-day**
lifetime. Result download can mount the result snapshot in a short, network-blocked
reader sandbox, even after the original execution sandbox has stopped. Reader
sandboxes stop on release and have a two-minute maximum lifetime.

If the desktop disconnects before it observes completion, the execution sandbox
continues until its configured deadline. Exit snapshots are enabled so a later
refresh can try to recover its progress and completed output without starting
inference again. Exit snapshot availability and retention are governed by Modal;
failure to obtain one is reported rather than hidden. If the sandbox is lost
before a complete result package exists, the original local package remains
intact, but uncheckpointed remote progress may be lost and prior paid calls may
be uncertain. No automatic inference restart is attempted from any snapshot.
A confirmed stopped worker with unfinished progress is recorded as **Review
stopped**. That state survives reconnects without repeatedly creating reader
sandboxes, and local work stays fenced until the reviewer confirms stop.

Optional prewarming:

```sh
# Requires MOKE_MODAL_POOL_QUEUE in the operator configuration.
bun run modal:warm
```

This checks the queue and offers one credential-free, single-use sandbox if no
unexpired candidate is recorded. It has the review limit plus a ten-minute demo
window, capped at 65 minutes. Claiming is atomic through a Modal Queue; the
backend checks engine identity, liveness, and enough remaining time for the full
review before using it. Otherwise it creates a fresh sandbox with the workspace
cache mounted. Warm sandboxes have no cache mount and receive every file. A used sandbox is
never returned to the pool. There is no scheduled replenishment or always-on
controller. Unclaimed sandboxes still consume credits until their deadline.
Rejected live candidates are confirmed terminated. A compatible claimed sandbox
gets the durable job name before allocation returns so receipt recovery can find
it. Queue messages use JSON to preserve millisecond expiry times through the SDK.

## Validation

Protocol 3 is deployed from `d7ba4f874` as `moke-review-engine:d7ba4f874`.
That immutable tag, `moke-review-engine:latest` and this checkout's private
operator selection resolve to `im-01M630XTWWQWB3FM0K4NY8NR0D`.
The published image passed strict identity, migration-hash and native PDF
readiness checks. The bounded protocol-3 live run verified ownership fencing,
backend close/reopen, RPC progress and automatic verified-package return.
Its single sent Meta request remains uncertain, with no successful response
receipt, counts or final answer. It was not retried. The strict live validator
exited nonzero; successful inference remains unverified. See
[the deployment record](research/protocol-3-deployment.md) for identities,
receipts, cleanup and the retained rollback image.

`cloud-reviews.test.ts` exercises persisted ownership, duplicate commands,
ambiguous dispatch, stop failures, wrong job identity, required checkpoints,
stale source versions, interrupted imports, corrupted ownership records, and
transfer path/size limits. `cloud-workspace.test.ts` uses the real application,
PDF import, complete-package export/restore, and a local sandbox port to test
workspace fencing across reopen and importing source-linked results without
accepting evidence. Existing execution tests cover provider and SAM admission.
`cloud-cache.test.ts` covers delta upload, worker fill-in with a mismatched or
missing cache file, local reuse during result download, launch seeding, prune
scoping and in-cloud copies after Send.

Protocol 4 is not deployed yet. A bounded live probe on 2026-10-30 (random bytes,
no drawings, secrets or model calls; test Volume and snapshot deleted, sandboxes
terminated) confirmed the Volume behavior this design relies on: a v2 Volume
mounted read-write accepts `copyFromLocal`, `sync` commits it, a read-only mount
rejects writes, `listFiles` on a missing folder raises not-found, a mounted
`/moke` directory snapshot keeps its `input/` layout, and a running sandbox keeps
its mount-time view until it reloads.

Live validation is available with `bun scripts/validate-cloud.ts --live --calls 12`
after configuring the two private connection files. It uses only the authored
two-sheet schematic and preserves receipts under `.local/cloud-validation/`.
The historical protocol-2 bounded live run returned proposed drawn **2** and scheduled **3**
through a durable result snapshot after a complete backend close/reopen. It
reached its eight-call budget before the final model answer; the UI identifies
this as partial results. No facts were accepted, source hashes were unchanged,
and local writes resumed only after import confirmed the remote sandbox stopped.
The normal twelve-call-budget run completed in seven calls and returned the same
proposed **2 / 3** counts, plus its final conversation response, in 34.1 seconds.
Recovery of that completed review through its stopped sandbox's exit snapshot
also passed. A separate live probe with zero model calls verified stale candidate
skipping, rejected sandbox cleanup, name-based claim recovery, and cold fallback.
See [the recorded cloud validation](research/cloud-validation.md).

## Primary references

- [Modal JavaScript/TypeScript SDK](https://modal.com/docs/guide/sdk-javascript-go)
- [Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox)
- [Image API](https://modal.com/docs/sdk/js/latest/Image)
- [Volumes](https://modal.com/docs/guide/volumes)
- [Outbound secret injection example](https://modal.com/docs/examples/sandbox_secret_injection)
- [Warm sandbox pool example](https://modal.com/docs/examples/sandbox_pool)
- [Parallel evaluation example](https://modal.com/docs/examples/harbor_evals)

The examples inform isolation, separate credentials, health/expiry checks, and
bounded concurrency. This implementation runs one review owner per workspace;
it does not deploy Harbor or a parallel evaluation fleet.

## Compatibility with drawing-set reviews

The cloud composer follows the whole-set and discipline workflow introduced in
[PR #9](https://github.com/sc-frederick/moke-meta-hackathon/pull/9); it does not require
an existing count check. The chosen model selects its own provider connection.
Configured Meta tools remain available with Baseten chat through separate
outbound header policies. Packet findings, coverage, evidence and reports return
through the same complete-package boundary. Packet controls and finding completion
are fenced while the cloud owns the workspace.

### Current admission and recovery

New reviews are admitted only to a protocol-5 worker whose identity matches this
build exactly: package engine `review-pi-1.4.0-v1`, count prompt
`moke-selected-coordination-v2`, packet prompt `moke-packet-review-v6`, and the
current instruction revision and code index version. Every new ownership receipt
records `workerProtocol: 5`. An image with a different identity fails the
identity probe before transfer. Migrations are not part of the identity: a worker
restores only packages whose migration history is a prefix of its own, so an
image built before a new migration passes the probe and refuses the package after
upload. Publish a matching image with `bun run modal:image` whenever worker code,
prompts, migrations or the code index change.

Recovery only observes work already `dispatching` or `running`; it never
redispatches or restarts a model. Earlier identities must still match the current
engine, count prompt and instruction revision, and omit the code index:

| Receipt `workerProtocol`                  | Progress accepted while dispatched           |
| ----------------------------------------- | -------------------------------------------- |
| Absent, saved by protocol-2 or 3 desktops | Protocol 2 or 3 with packet prompts v1 to v3 |
| `3`                                       | Protocol 3 with packet prompts v1 to v3      |
| `4`                                       | Protocol 4 with packet prompts v3 to v5      |
| `5`                                       | Protocol 5 with the current identity         |

Receipts in every other phase accept only current progress.

### Protocol history

Each entry records what an upgrade required when it shipped.

**Protocol 4** adds the workspace cache: new receipts record the cache Volume and
`workerProtocol: 4`, and the worker fills skipped files from `/cache` before
restore. Publish a new worker image with `bun run modal:image` before sending
protocol-4 reviews; a protocol-3 image fails the identity probe before transfer.
Packet prompt `moke-packet-review-v5` (finding decisions, the firm checklist and
jurisdiction leads, with migration 0011) also needs a newly published image; a
protocol-4 image built with v3 or v4 fails the probe. Jobs already sent to a v3
or v4 worker remain recoverable.
Receipts already dispatched to protocol-3 workers stay readable and return
normally. Unmarked receipts may recover protocol-2 or protocol-3 progress, and
`workerProtocol: 3` receipts accept protocol-3 progress only.

**Protocol 5** adds the Florida code index to the worker identity, the
`search_code` tool and PDF text in `read_source`, with packet prompt
`moke-packet-review-v6`. Publish a new worker image with `bun run modal:image`
before sending protocol-5 reviews; a protocol-4 image fails the identity probe
before transfer. New receipts record `workerProtocol: 5`. Receipts already
dispatched to protocol-4 workers stay readable and accept protocol-4 progress
with packet prompts v3 to v5 only.

The protocol-3 handshake required support for explicit revision, selected-sheet
and persisted-discipline scope, and includes both packet and count prompt versions.
The operator deployment above now supplies that matching worker. Rebuild and
publish again when worker code, prompts or migrations change. Protocol-2 workers
would discard the new selection fields and fail the handshake before admitting
new model work. This deployment requirement is separate from recovery
of reviews already dispatched to protocol-2 workers. Protocol-3 desktops saved new
ownership receipts with `workerProtocol: 3`. Unmarked receipts in `dispatching` or `running` may recover
protocol-2 progress with the same engine, count/packet prompt and instruction
identities and matching job ID. Unmarked protocol-3 receipts remain readable too.
Recovery only observes existing work; it never redispatches or restarts a model.
Ready results still require the external snapshot, bounded complete-package
validation, source-version checks, confirmed remote stop and journaled restore
before local ownership returns. An incompatible sync pause saved by an earlier
build still requires **Retry sync** after upgrading; it is not cleared implicitly.

Before transferring, the desktop resolves the selected published image and required provider
secrets, including their MOKE_API_KEY keys. A credential-free, network-blocked probe
validates the worker identity before ownership is recorded; successful compatibility
is cached by immutable image ID for the runtime. The probe has a one-minute lifetime
and is released after validation. Cloud setup reports readiness failures explicitly.

Complete cloud packages support up to 1 GiB and 5,000 files. The package still
describes the entire workspace, although cached files are not uploaded again: a project-only package would need a merge protocol before
it could safely replace the local database. The selected project, model, scope,
package bytes and live sheet/finding/coverage totals identify the active job.
Terminal receipts stay in their originating conversation and can be dismissed.
See [Audit 3 cloud research](research/audit-3-cloud.md) for resource pricing,
capacity decisions and regression evidence.

Cloud requests retain the selected scope through transfer
and automatic return. Local steering and editing remain fenced while the cloud
owns the workspace; remote steering is unavailable.

Offline validation runs the actual packet service and recorded Baseten transport,
exports a real capped package, automatically restores it in the local application,
and reopens without dispatching again. Desktop proof replays a terminal receipt,
hydrates packet findings and enables editing. The merged source's latest
validation passed 321 smoke tests with 2,152 assertions, seven isolated Electron
flows and seven packaged flows. Linux, macOS and Windows hosted checks also
passed, including packaged execution. These offline tests add no paid model
requests. The protocol-3 live transfer evidence above does not establish a
successful live drawing-set review on this protocol.
