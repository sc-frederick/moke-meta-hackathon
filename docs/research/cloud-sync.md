# Automatic cloud result synchronization

The reviewer pushes a new cloud review once. Progress appears live, and verified
results return automatically. A WebSocket by itself would not guarantee durable
delivery or safe workspace replacement, so transport is separated from recovery.

## Selected design

Reuse the existing trusted Effect RPC stream through Bun's private loopback
NDJSON endpoint and Electron MessagePorts. Modal's JavaScript SDK supports
`sandbox.filesystem.watch`, including directory events for atomic file replacement.
The backend watches `/moke/progress.json` through its parent directory and reads
the durable, schema-validated progress record after notifications. It also reads
on attachment and every ten seconds, since notifications can be missed and
watching can be unsupported. No public tunnel, incoming webhook service, or
renderer cloud credential is needed.

The backend, rather than a mounted component, owns one synchronizer. Observation
only fans out its latest snapshot; opening two windows cannot admit two imports
or dispatch more model requests. Once the result snapshot exists it runs the
existing download, confirmed stop, complete validation, and journaled restore
under application maintenance. The imported receipt reaches the UI only after
maintenance ends. Proposed facts remain proposed.

Reopen reconstructs ownership from the sidecar and performs the same reconciliation.
No renderer event cursor or old socket is needed. Persistent receipt revisions
reject out-of-order RPC responses. An unavailable service retries later; invalid
or conflicting input requires an explicit sync retry and does not repeatedly
download the same invalid result. Cancellation still requires acknowledged
possible charges and confirmed stop or explicit provider absence.
Paused errors are persisted in the receipt across restart. UI delivery is
acknowledged only after its local snapshot and execution status refresh succeed;
failed refreshes retry separately from the package import, with concurrent
deliveries coalesced for the same receipt.
Hydration captures the selected project, check, and receipt before awaiting a
snapshot or execution-status request. It rechecks those identities before
applying the response; switching checks cannot attach the old run's controls to
the new selection. Deferred-response tests cover check, project, and receipt changes.

The streaming payload is review progress and synchronization state. Final messages
and evidence artifacts appear after a complete validated return. This change does
not implement token streaming, partial SQLite replication, persistent PDF caching,
or background PDF pre-upload.

## Alternatives considered

- Direct browser-to-sandbox WebSocket: adds a public connection/authentication
  boundary and still needs durable reconnect reconciliation.
- A background renderer timer: stops with the view and duplicates controllers
  across windows; it cannot own package replacement.
- Watching only filesystem events: misses already-completed offline work and
  notifications lost during disconnection.
- Shared live SQLite on a Volume: conflicts with the existing single-owner and
  consistent-package recovery rules. The Volume/PDF-cache proposal is separate.

## Primary references

- [Modal JavaScript Sandbox filesystem watch](https://modal.com/docs/sdk/js/latest/Sandbox#watch)
- [Modal networking boundaries](https://modal.com/docs/guide/sandbox-networking)
- Installed Effect `SubscriptionRef`, scoped fibers, Streams, and TestClock,
  plus `repos/effect/LLMS.md` and matching read-only references.
- Existing `ObserveExecution`, authenticated backend RPC, and renderer bridge.

Regression coverage includes automatic return without a renderer, completed-offline
reopen without redispatch, missed notifications, interrupted downloads, invalid
packages requiring retry, and real package restore with original hashes preserved.

## Observed validation

The live native-watch probe received an atomic `progress.json` replacement through
Modal's SDK stream with zero model calls. Disconnect cleanup took 2,004 ms with a
two-second local cleanup budget. Its sandbox was confirmed stopped.

The compiled-backend live check closed and reopened the backend, then subscribed
to `ObserveCloudReview`. It observed `ready`, `importing`, and `imported` without
calling `ImportCloudReview` or `RefreshCloudReview`. Source hashes were preserved,
and a subsequent local message succeeded. See the [recorded result](cloud-auto-sync-validation-result.json).

That live review did **not** complete its inspection: one request was marked sent
and remained uncertain, with no facts produced. Its cause was not established;
the request was not replayed or acknowledged automatically. The ordinary
completed-review assertion failed for that reason. Read-only receipt inspection
and a local write separately verified automatic return and preserved uncertainty.
This is transport/recovery evidence, not evidence of a newly completed model review.
The earlier completed seven-call review remains recorded in [cloud validation](cloud-validation.md).

Final verification passed 156 smoke tests and two Electron desktop tests.
