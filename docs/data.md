# Data lifecycle

Application queries use Effect SQL. Parse rows with Effect Schema before returning
domain values. Do not assume D1 supports the same transaction APIs as local SQLite;
use its atomic batch primitive for fixed multi-statement operations.

## Desktop

The database is app.sqlite in Electron's userData directory. Electron passes that
directory to its private Bun backend, which exclusively owns database operations.
Startup closes its migration connection before accepting API requests. Application
queries use Effect SQL with the Bun SQLite driver. The migration and backup code
uses Bun's node:sqlite compatibility API so the existing backup format, migration
hashes, and recovery behavior remain intact. No separate SQLite addon is required.

Each note operation opens and closes its scoped SQL Layer. A backend-owned
semaphore serializes queries, exports, and restores, so restore never replaces an
open application database. The renderer receives only note APIs. Export and
restore are typed operations available to the authenticated desktop shell.

Add migration files named 0001_name.sql, 0002_name.sql, and so on. Files may contain
multiple SQL statements. The runner owns transactions; migrations must not contain
transaction control statements. It verifies hashes of previously applied files,
backs up the database using SQLite's consistent backup API, then applies pending
files and history records in one transaction. Failures preserve existing data.
The five most recent automatic pre-migration backups are retained.

File > Export database creates a consistent backup, including committed WAL data.
File > Restore database checks integrity and migration compatibility after prior
operations have closed their connections, keeps a pre-restore backup, replaces
the database, and restarts the desktop app. Failed restores leave the backend
usable and preserve the current database. A migration or restore failure must
never reset or delete user data.

## Web

Alchemy owns D1 provisioning and migration application through the migrations
property in alchemy.run.ts. Commit reviewed SQL before deploying. Do not run a
second migration tracker through Wrangler or an application startup hook. Separate
statements inside a web migration file with `--> statement-breakpoint`, which the
local smoke runner and Alchemy migration parser both recognize.

Development, staging, and production have separate databases. Set up an explicit
export/restore procedure before destructive production schema changes. Schema
changes must remain compatible with the currently deployed app during rollout;
an app rollback does not reverse a database migration.

## Sync

Cloud connectivity is optional. Decide the source of truth, offline writes,
conflict rules, idempotency keys, deletions, and compatibility with older desktop
clients for the particular application. RPC provides transport and contracts;
it does not supply synchronization semantics.
