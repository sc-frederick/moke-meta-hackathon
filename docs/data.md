# Data lifecycle

Application queries use Effect SQL. Parse rows with Effect Schema before returning
domain values.

## Desktop

The database is app.sqlite in Electron's userData directory. Electron passes that
directory to its private Bun backend, which exclusively owns database operations.
Startup closes its migration connection before accepting API requests. Application
queries use Effect SQL with the Bun SQLite driver. The migration and backup code
uses Bun's node:sqlite compatibility API so the existing backup format, migration
hashes, and recovery behavior remain intact. No separate SQLite addon is required.

A process holds the canonical data-directory ownership lock before recovery or
migrations. Queries open scoped Effect SQL connections with foreign keys and FULL
synchronization. A shared short semaphore serializes SQL and replacement; PDF
processing and hosted inference run outside it, allowing reviewer corrections
during an inspection. Maintenance stops admission, drains work, and closes Pi
journals before taking SQL exclusion.

The renderer receives project-scoped review commands, artifact reads and execution
controls. Absolute import, report export and restore paths remain shell
capabilities, and provider credentials stay outside renderer RPC.

Packet reviews freeze the supplied sheet inventory, original hashes, request,
conversation, model and scope at start. Their structured records retain project
configuration, sheet/pass coverage, general findings, sources, citations,
calculations and prior comments. Follow-up reviews can retain stable issue IDs.
User completion changes a finding's task-tracking state with an optimistic
version check; it does not change the finding's evidence status or prior-comment
closure. Original source changes stop further work against a stale packet.

New findings retain the original technical title, observation and correction at
their existing capacity. A separate host-owned Pending/Ready summary records a
revision and, when valid, concise display text. Summary retries cannot overwrite
technical fields, evidence, status or completion. Technical updates invalidate
the old summary. Pending summaries survive reopening and prevent a finished
sheet or completed review. Legacy findings without summary metadata remain
readable, exportable and usable in follow-ups without forced rewriting.

Selected-count facts and calculation history remain append-only. Their current
finding pointers change only with matching source/fact versions. Model tools
propose count inputs and cannot accept them. Command receipts are checked before
freshness checks, preserving replay of an already committed operation.

Model and SAM intent is saved before dispatch, including the provider request
identity and whether a send began. Unknown outcomes stay uncertain across
restarts and never resend automatically. A compatible paused packet review
resumes only on an explicit request; an exhausted optional call budget can be
extended without resetting admitted-call history. Unresolved provider attempts
block resume. The selected-count protocol's separate possible-charge
acknowledgement does not resolve or remove its old provider evidence.

Add migration files named 0001_name.sql, 0002_name.sql, and so on. Files may contain
multiple SQL statements. The runner owns transactions; migrations must not contain
transaction control statements. It verifies hashes of previously applied files,
backs up the database using SQLite's consistent backup API, then applies pending
files and history records in one transaction. Failures preserve existing data.
The five most recent automatic pre-migration backups are retained.

Migration 0008 adds nullable execution timestamps for elapsed review time. Older
runs keep unknown timing instead of an estimated duration. Complete packages
accept the original, prompt-context, and timed execution layouts, retaining the
timestamps when exporting and restoring historical reviews.

Migration 0009 adds packet review roots, model/SAM attempts and durable tool
receipts. A packet review belongs to a project and conversation and can begin
before any count finding exists. SQLite records and Pi journals preserve its
progress independently of the workbench connection. Reopening the app does not
start a saved review or issue new model requests automatically.

Follow-ups retain coverage and inspection history only for the same sheet,
revision, source hash, page and page box. Optional payload metadata separately
records baseline sheets and inspections made in the current review, so retained
baseline evidence cannot close a newly revised comment. Whole-set coverage
requires every discipline and pass, including reasons for Not applicable entries.
Shutdown and startup classify a review as uncertain while any admitted attempt
has no completed receipt; reopening never retries that request automatically.

A reviewer's decision on a packet finding (valid, false alarm, not applicable or
duplicate, with an optional reason and the time) is saved on the finding with the
same version check as completion. Model tools cannot set it, and a model update
to the same issue ID keeps it. Follow-ups copy findings with their decisions.

Migration 0011 adds `firm_checklist_revisions`, the firm's own review checklist.
Each save appends a revision; rows cannot be updated or deleted, and saving
checks the revision the reviewer edited. A packet review copies the latest
non-empty revision into its payload at start, so a resume or cloud run uses the
checklist the review began with. Saves are refused while the cloud owns the
workspace, like other local writes.

When `record_project` names a jurisdiction, the host reads project configuration,
source metadata without text, citations and agency comments from the 200 most
recent packet reviews in other conversations. It offers those from the same state
or county/city to the model as leads. The review records which earlier reviews
were offered and how many items, not the leads themselves; they never become
this review's sources, citations or prior comments.

Each unresolved prior comment also retains its required revision sheet targets.
New source revisions advance that target; follow-ups without new sources preserve
it. The model cannot rewrite this host-owned metadata to close a comment against
an older baseline. Closure requires current inspection evidence from the target.

The partial database export creates a consistent backup, including committed WAL data,
then finalizes it in DELETE journal mode so it can be opened as a standalone,
read-only file on every OS. Automatic backups use the same format.
Legacy notes-only database restore checks integrity and migration compatibility after prior
operations have closed their connections, keeps a pre-restore backup, asks SQLite
to checkpoint and leave WAL mode, replaces the database, and restarts the desktop
app. SQLite manages its journal files; never remove live WAL files manually.
Failed restores leave the backend usable and preserve the current database.
A migration or restore failure must never reset or delete user data.
The obsolete notes UI and RPC are removed. Migration `0001_notes.sql` remains
immutable, and legacy notes are still preserved by database and package recovery.

## Complete review packages

Use **Export complete package** and **Restore package** for review data. A package
is a versioned directory containing a consistent application database, immutable
originals/rendered artifacts, closed Pi journals, and a manifest written last.
The manifest verifies hashes, migration prefixes, engine format, paths and limits.
Credentials, logs, `.env`, and the ownership lock are excluded. Database-only
restore refuses review-bearing data in either the current or incoming database.

After maintenance closes journal writers, export lets SQLite checkpoint each Pi
journal and leave WAL mode before read-only inspection. This avoids the closed-WAL
read failure tracked in [Bun #45171](https://github.com/oven-sh/bun/issues/45171)
on macOS. SQLite owns sidecar cleanup; export rechecks the resulting file size and
identity before backup. A later local resume opens WAL mode again through the
normal journal adapter.

Restore validates the entire package before replacement, retains a complete
pre-restore snapshot, and journals replacement phases. Startup rolls an
interrupted replacement back before opening databases. Restored runs have a
persistent historical engine marker and cannot resume their copied Pi journals;
no model or SAM work starts on reopen. This applies to packet reviews and
selected-count runs. Uncertain model and SAM attempts and their accounting are
retained.
See [package recovery](research/review-packages.md) and
[execution safety](research/pi-runtime.md) for exact contracts and limitations.

## Offline review reports

HTML report export reads the saved packet review and embeds its focused evidence.
It includes the frozen inventory, actual coverage, findings, source access and
citation status, calculations, prior comments and unresolved inputs. Missing
images or unreviewed passes remain explicit. The report is a portable result,
while the complete package preserves the source files and durable execution.

Completed checkboxes in an exported HTML report synchronize repeated issue IDs
and save user selections in browser localStorage scoped to project, review and
report revision. Those browser selections do not travel with a copied HTML file.
Unavailable storage leaves controls usable and identifies choices as temporary.
Print output retains the current completion state. User completion is separate
from finding status, engineering acceptance and reviewer-verified comment closure.

## Sync

Cloud reviews use the same complete-package validation and replacement journal.
The separate `<dataDirectory>.cloud/state.json` ownership record is flushed
before dispatch and fences local writes across desktop reopen. It is excluded
from portable packages so import cannot erase its own fence. A confirmed remote
stop precedes result replacement or cancellation. See [cloud review recovery](cloud-reviews.md)
for seven-day checkpoints, whole-workspace scope, and uncertain-call handling.
The backend automatically returns completed results and resumes reconciliation
after reopen. Live status streams replay the current receipt; persistent receipt
revisions prevent stale replies from rolling the interface back. The synced
notification follows package validation and completion of application maintenance.
Read-only snapshots use the same SQL exclusion as replacement, so network
uploads and downloads do not block project navigation. The recovery-journal
guard runs under that exclusion before a review connection opens. Download
retries reuse only files whose size and SHA-256 match the selected result
manifest; interrupted Modal copy scratch files are cleared before package validation.

New cloud receipts record the admitted worker protocol. Older unmarked receipts
can recover matching protocol-2 or protocol-3 progress only for already-dispatched
`dispatching`/`running` jobs. Protocol-3 receipts recover protocol-3 results, and
protocol-4 receipts can recover their already-dispatched packet prompt v3 results
after the v4 prompt upgrade. The current protocol-4 request and warm-worker
handshake require packet prompt v4. This changes neither SQL migrations nor saved
review content and never replays model work. Existing explicit sync pauses
remain paused until **Retry sync**; ownership returns only through verified result
restore or confirmed stop.

Cloud connectivity is optional. Decide the source of truth, offline writes,
conflict rules, idempotency keys, deletions, and compatibility with older desktop
clients for the particular application. RPC provides transport and contracts;
it does not supply synchronization semantics.

Confirmed sheet correspondence is one-to-one and immutable. Migration 0006 adds
unique predecessor/successor indexes and rejects updates/deletes. Unconfirmed
proposals retain separate append-only history; later confirmation inserts a new
confirmed association. They never authorize reuse of baseline facts. Evaluation
records only current operands and their dependencies; excluded revision inputs
remain in earlier fact/check history and get an explicit unresolved explanation.

Migration 0010 adds append-only removed and unresolved revision decisions without
inventing a replacement sheet. Retained matches continue using the immutable
one-to-one links. A removed or unresolved operand keeps its original source in
history, loses current confirmation, and cannot authorize reuse of accepted facts.
The workbench shows saved decisions after reopen. Identical PDF hashes propose
page matches, but a reviewer must still confirm them before evidence is reused.
