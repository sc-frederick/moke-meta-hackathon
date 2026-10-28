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

The renderer receives project-scoped review commands, bounded artifact reads,
and execution controls. Absolute import/export/restore paths and credentials
remain shell capabilities. Facts and calculations are append-only; current
finding pointers change only with matching source/fact versions. Model tools
propose facts and cannot accept them. Command receipts precede freshness checks.

Provider and SAM intent is saved before dispatch. Unknown outcomes remain
uncertain across crashes and never resend automatically. An explicit recorded
acknowledgement of a possible prior charge permits a separate new run with its
own budget. It does not resolve or remove the old provider evidence.

Add migration files named 0001_name.sql, 0002_name.sql, and so on. Files may contain
multiple SQL statements. The runner owns transactions; migrations must not contain
transaction control statements. It verifies hashes of previously applied files,
backs up the database using SQLite's consistent backup API, then applies pending
files and history records in one transaction. Failures preserve existing data.
The five most recent automatic pre-migration backups are retained.

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

Restore validates the entire package before replacement, retains a complete
pre-restore snapshot, and journals replacement phases. Startup rolls an
interrupted replacement back before opening databases. Restored runs have a
persistent historical engine marker and cannot resume their copied Pi journals;
no model or SAM work starts on reopen. Uncertain model and SAM counts are retained.
See [package recovery](research/review-packages.md) and
[execution safety](research/pi-runtime.md) for exact contracts and limitations.

## Sync

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
