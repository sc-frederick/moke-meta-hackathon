# Selected Pi runtime slice

Implemented against installed `@earendil-works/pi-durable`, `pi-ai`, `chord`, and
`pi-telemetry` 1.4.0, Effect 4.0.4, and TypeBox 1.3.27. Production imports use
installed packages. The read-only preflight at `/tmp/moke-pi-preflight-RSsqwv`
established the published SQLite facade, telemetry identity propagation,
recovery resend behavior, and safe-tool receipt pattern. This slice uses the
published Harness and SQLite storage rather than replacing their internals.

## Composition contract

Acquire `acquireDataDirectoryOwnership(dataDirectory)` in the parent's application
scope **before migrations**, domain SQL, or journal work. Its realpath-canonical
directory and generation go into:

```ts
ReviewExecution.layer({
  owner,
  queries, // The same Semaphore used for short domain SQL and recovery.
  port,
  runPromise: (effect) => applicationRuntime.runPromise(effect),
  provider: {
    provider: "meta",
    apiKey, // Redacted<string>, private startup configuration only.
    baseUrl: "https://api.meta.ai/v1",
    model: "muse-spark-1.3",
    route: "live",
  },
  closeTimeoutMs: 2000,
});
```

The parent owns one ManagedRuntime. The service creates none. During Layer
finalization, its callback entry uses `Effect.runPromiseWith` with that
finalizer's Context because ManagedRuntime marks its public entry disposed
before releasing Layers. Tool callbacks do not acquire another runtime.

The explicit alternative is provider `baseten`, endpoint
`https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`.
Endpoint/model mismatches fail closed. No ambient credential fallback or dynamic
catalog refresh is enabled. Recorded execution requires an injected HTTP
transport. Without provider configuration, start returns a typed unavailable failure
and creates no phantom run. No execution RPC carries credentials, filesystem paths, journals, or
transcripts.

`backend/review/execution-port.ts` defines the parent's required capabilities:

| Operation                  | Contract                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `inspect(selection)`       | Selected finding, sheets, artifacts, facts/checks, source version, and fact version.        |
| `render(fence, detail)`    | Bounded PDF region plus a named missing fact; returns an application Artifact.              |
| `readImage(artifact)`      | Application-resized PNG pixels, actual delivered dimensions, and both PDF/pixel transforms. |
| `propose(fence, proposal)` | Proposed count and evidence; never accepts or confirms coverage.                            |
| `evaluate(fence)`          | Parent's deterministic check over accepted inputs.                                          |
| `message(fence, text)`     | Application progress or a reviewer clarification request.                                   |

The optional segmentation capability is application-owned and not exposed as a
paid tool by this slice. SAM integration remains separate.

Every mutation fence includes project/finding/run/journal IDs, owner generation,
captured source/fact versions, and a stable command UUID derived from journal ID
and durable tool task ID. Overview render commands also include a stable sheet
discriminator. The parent must return an existing receipt **before** checking
current versions, then atomically check the fence and commit mutation plus
receipt. Already admitted work may drain while state is `pausing`; `paused`,
`cancelled`, `uncertain`, stale owner, and changed source/fact versions cannot
promote fresh mutations. Network and rendering must run outside the shared SQL
permit.

The inspect tool delivers up to two full selected-sheet overview images,
rendering missing overviews through that port. Targeted render delivers the newly
rendered image. Both return actual SDK image blocks and text metadata with exact
delivered dimensions/transforms. Moke owns resizing and provenance.

## Persistence and admission

`0003_review_execution.sql` stores runs, attempts, and cursor-based status events
in `app.sqlite`. It deliberately makes no assumption about the parent's project
table key; project authorization is through the port. Each short SQL operation
opens a scoped Effect SQL connection and shares the recovery semaphore. No
provider wait holds that permit.

Each run has an immutable UUID journal identity and dedicated file under
`execution-journals/`. Opening uses `openNodeSqliteDatabase` followed by
`SqliteStorage.open`. It explicitly enables and reads back foreign keys, WAL, and
FULL synchronous durability. A host identity table records the journal UUID and
`review-pi-1.4.0-v1` format. Missing or incompatible existing journals are surfaced
as incompatible execution; no silent journal recreation or engine migration is
attempted.

The separate `.execution-owner.sqlite` connection holds `BEGIN IMMEDIATE` with
busy timeout zero for the process lifetime. Recovery/export must exclude this
lock file. When uncooperative shutdown exceeds the bound, an exit listener
retains the native lock handle through process exit, even after Layer disposal.
The parent must terminate its Bun process within the overall three-second
shutdown policy when `close` returns false. A local lock on a network filesystem
or after machine power loss has not been validated.

Both Provider `stream` and `streamSimple` are guarded, so Models
`complete`/`completeSimple` cannot bypass admission. Only host-created validated
`pi.durable.phase` generation/request spans supply task ID and checkpoint attempt
through a WeakMap. Compaction phases and absent identities are rejected at this
boundary. Hooks do not enforce policy. Automatic/manual compaction, durable
retries, SDK retries, deferred calls, and parallel tools are unavailable.

Before dispatch, the service commits an uncertain attempt keyed by journal,
task, and attempt, a request fingerprint, owner generation, and reservations. Its
transport permits one fetch only, forces SSE and maxRetries zero, and overrides
caller sampling limits. Successful responses are parsed, bounded, and committed
as normalized receipts **before** Pi sees the final response or can run a tool.
Matching completed receipts replay without another send. Error, timeout,
interruption, or an ambiguous pre-send crash retains uncertain evidence.

Reopen reads all durable state before any Harness is scheduled. Interrupted work
with an uncertain attempt cannot resume or start another generation for that
selection. Cancel records its intent before invoking Pi abort; subsequent tool
admission fails. A late response can remain historical but cannot authorize a
fresh mutation. Closing a Harness is distinct from aborting its conversation;
waiting for a submission's terminal receipt is not a shutdown drain condition.

Pause is persisted and serialized with model/tool admission. An admitted
operation drains; the next operation waits. Reopen leaves safe interrupted work
paused and requires explicit resume. Public controls are start, status,
pause/resume/cancel, and event cursors. An explicit reconciled new attempt after
uncertainty is intentionally a separate future user operation, not an automatic
retry or a currently exposed control.

## Budget meaning

The bound is calls, conservative **text** input tokens, and output tokens. UTF-8
bytes of the serialized request with base64 image payloads removed reserve an
upper bound on text tokens. Each admission reserves the configured maximum;
reservations are not refunded after ambiguous failure. SDK output tokens are
bounded and checked on the normalized receipt.

Each model image is at most 1 MiB decoded and 2048 pixels per dimension. Each
request allows at most six images, 2 MiB aggregate decoded image data, and 3 MiB
serialized body bytes. Repeated images in the accumulated transcript count
against these limits. Larger work fails closed and requires a smaller region or
a separately approved execution design. Image-token accounting is unknown and
reported as `imageInputTokens: null`; text reservation is not a claim about total
vision tokens or paid cost. `costUsd` remains null. Pi requires numeric model
rates for its internal types; the uncatalogued Baseten route uses zero sentinels
internally, which are never reported as application cost estimates.

## Observed evidence and remaining gates

`bun test tests/review-execution.test.ts` exercises the production service with
real SQLite, actual Pi Harness, and actual Meta Responses SDK using injected
synthetic HTTP/SSE. No SDK internals are mocked and no paid calls are made.
The final focused run passed 13 tests and 71 assertions on Bun 1.4.4, Linux x64.

- Successful normalized response receipt persists before terminal completion.
- Pause drains its current provider operation and admits no next tool; safe
  reopen stays paused with zero sends until explicit resume.
- Duplicate stable command receipts return one committed proposal even after the
  run becomes terminal. The preflight separately exercised crash immediately
  before and after domain commit; that crash-window probe has not been repeated
  against the parent's final domain adapter.
- Timeout, retry-bearing 503, malformed arguments, stale late proposal, call
  bound, and conservative text bound are exercised.
- Cancel intent persists before abort and blocks a late proposed-count response.
- A changed host journal identity yields explicit incompatible state and zero
  additional dispatches.
- Both provider entrypoints exercise successful receipt replay; manual
  compaction identity is denied before transport.
- Compiled independent owner processes prove exclusion and SIGKILL reacquisition.
- A full compiled Pi process run from `/` is SIGKILLed after persisted dispatch;
  reopen, attempted resume, and attempted fresh generation keep exactly one send.
- An uncooperative compiled transport exceeds bounded close, returns false,
  preserves uncertain state, and exits without a second send.
- Actual PNG overview/targeted blocks, larger than 64 KiB of base64 each, reach
  subsequent actual SDK HTTP requests with delivered 200×200 dimensions.

These establish local process-crash and admission behavior, not real provider
acceptance, billing, retrieval, power-loss guarantees, or target-OS installed
Electron packaging. Parent integration owns the explicit budgeted live probe,
real domain/PDF acceptance, complete export/restore consistency, E2E, council,
and final repository verification. Gates 0C/0D are not declared fully passed by
this slice alone.

## Lifecycle command receipts and explicit new attempts

Migration 0005 adds stable command receipts for start, pause/resume/cancel and
uncertainty acknowledgement. Matching replay returns the committed receipt before
version or owner checks; changed input conflicts. A start committed before a crash
reopens paused, schedules nothing, and can be resumed explicitly. Only one
inspection may be running/pausing across the application.

The public acknowledgement requires `possibleChargeAcknowledged: true`, a fresh
run version and command ID. It records the decision and cancels the old run; its
uncertain attempts remain in the ledger. A separate StartExecution creates a new
run/journal and budget. Acknowledgement itself never sends. Restored historical
journals cannot resume; cancelling historical paused work permits a new run.

## Image request window

The stateless SDK transcript retains all text, artifact metadata, tool and response
identities. Each outbound request includes only the newest images that fit six
images and 2 MiB decoded bytes; omitted older pixels are replaced with explicit
text notices. The original images remain in the journal/artifact store and can
be requested again. No image is silently resized or cropped at this boundary.
The deterministic bounded transcript participates in the dispatch fingerprint.
The wire cap remains 3 MiB. This prevents repeated detail/SAM turns from filling
the request with every earlier raster. Image tokens and billing remain unknown.
