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
execution journal. Cloud transfers are capped at 256 MiB and 5,000 files. The UI
discloses this scope before the reviewer sends the request.

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

Defaults are one CPU, a one-CPU hard limit, 2 GiB memory, no GPU, a 15-minute review
limit, and no warm pool. The operator can choose 1–60 minutes. The sandbox gets
an additional two minutes for transfer/checkpoint cleanup. Selected count reviews
retain their call/token admission budget. Drawing-set reviews honor the optional call budget and the shared time limit. Inference remains on the
selected Meta/Baseten service; Modal credits pay for the sandbox, storage, and
related Modal usage. Moke does not read a Modal wallet or promise a dollar cap.
Configure account budgets in Modal separately from these runtime limits.
Transfer and setup consume the same deadline used to claim warm capacity.
Exec timeouts are rounded down to whole seconds, as required by the SDK; a
transfer leaving less than one minute fails before inference dispatch.

The complete source package reaches an acknowledged external directory snapshot
before inference dispatch. Completed results reach a separate directory snapshot
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
review before using it. Otherwise it creates a fresh sandbox. A used sandbox is
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

The protocol-3 handshake requires support for explicit revision, selected-sheet
and persisted-discipline scope, and includes both packet and count prompt versions.
The operator deployment above now supplies that matching worker. Rebuild and
publish again when worker code, prompts or migrations change. Protocol-2 workers
would discard the new selection fields and fail the handshake before admitting
new model work. This deployment requirement is separate from recovery
of reviews already dispatched to protocol-2 workers. New ownership receipts save
`workerProtocol: 3`. Unmarked receipts in `dispatching` or `running` may recover
protocol-2 progress with the same engine, count/packet prompt and instruction
identities and matching job ID. Unmarked protocol-3 receipts remain readable too.
Recovery only observes existing work; it never redispatches or restarts a model.
Ready results still require the external snapshot, bounded complete-package
validation, source-version checks, confirmed remote stop and journaled restore
before local ownership returns. An incompatible sync pause saved by an earlier
build still requires **Retry sync** after upgrading; it is not cleared implicitly.

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
