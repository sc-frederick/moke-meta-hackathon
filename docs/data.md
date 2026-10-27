# Data lifecycle

Application queries use Effect SQL. Parse rows with Effect Schema before returning
domain values. Do not assume D1 supports the same transaction APIs as local SQLite;
use its atomic batch primitive for fixed multi-statement operations.

## Desktop

The database is app.sqlite in Electron's userData directory. Startup closes its
migration connection before acquiring the application SQL Layer. The Node SQLite
driver uses the built-in node:sqlite module, so no separate native SQLite addon is
required. Heavy database work can move to a utility process when the app needs it.

Add migration files named 0001_name.sql, 0002_name.sql, and so on. Files may contain
multiple SQL statements. The runner owns transactions; migrations must not contain
transaction control statements. It verifies hashes of previously applied files,
backs up the database using SQLite's consistent backup API, then applies pending
files and history records in one transaction. Failures preserve existing data.
The five most recent automatic pre-migration backups are retained.

File > Export database creates a consistent backup, including committed WAL data.
File > Restore database checks integrity and migration compatibility, closes the
application runtime, keeps a pre-restore backup, replaces the database, and
restarts. A migration or restore failure must never reset or delete user data.

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
