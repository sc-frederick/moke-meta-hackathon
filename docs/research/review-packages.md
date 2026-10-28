# Review package export, restore, and restart recovery

Status: local behavior tested on Linux x64 through WSL2. This is the whole-application package used before a parent wires it into the desktop shell. It is not a single-project subset, and it does not start Pi or dispatch a model call.

Primary demo target: Linux x64. The writer uses same-filesystem rename, directory fsync, and `O_NOFOLLOW`. Those were not re-checked on Windows or macOS.

## Package directory

Format name `moke-review-package`, format version `1`, hash `sha256`, engine `review-pi-1.4.0-v1`. The only scope this writer produces is `application` with scope label `whole-application`. That means the whole local application database plus the originals, renders, and closed Pi journals that database references.

```text
manifest.json
app.sqlite
artifacts/<sha256>.pdf
artifacts/<sha256>.png
journals/<journal-id>.sqlite
```

`manifest.json` is written last, after each other file is fsynced. The directory is staged beside the destination and renamed into place. The destination must not already exist, and it must sit outside the application data directory.

`app.sqlite` and each journal are copied with the existing SQLite backup API and then finalized to DELETE journal mode. The package does not contain `-wal` or `-shm` sidecars. An open database file is not copied directly.

Journals in the live data directory stay at `execution-journals/<journal-id>.sqlite`. The package stores them under `journals/` and restore maps them back. Each journal must contain `review_journal_identity` for that id and format `review-pi-1.4.0-v1`.

The manifest lists migration name and sha256 pairs. Restore accepts that history only when it is a non-empty prefix of the migrations installed with this build, with the same file hashes.

Default caps are 5,000 files and 2 GiB. Callers may pass `limits`. Values outside 1 to 100,000 files, or 1 byte to 8 GiB, fail before any copy.

Symbolic links are rejected. Manifest paths must be the exact relative layout above. `..`, absolute paths, and backslashes are rejected. A file whose bytes or size differ from the manifest is rejected. A referenced artifact that is missing, or whose hash or recorded size disagrees with the file, fails the export instead of producing a partial package.

These paths are never part of a package: `.env`, `logs/`, `credentials.json`, `.execution-owner.sqlite`, and anything else not listed above. The process owner lock stays in the data directory and is not replaced.

`scope: "database-only"` is recognized and always refused by this module. The refusal reason is `incomplete`. Self-contained notes backups stay on the existing database restore path, with the guard below.

## Restore and run state

Validation, including hashes, quick_check, migration compatibility, artifact references, and journal identity, finishes before any live file is renamed. When `app.sqlite` already exists, a whole-application snapshot of that current data is written to `.package-restore/retained/<uuid>/` first. That snapshot is kept.

Running and pausing runs with no uncertain attempt are saved as `paused`. A run that has an uncertain attempt, and is not already `cancelled` or `uncertain`, is saved as `uncertain`. `paused`, `uncertain`, `cancelled`, `completed`, `failed`, and `incompatible` are otherwise left as they were. Version and `review_execution_events` advance only when the state changes. This uses the columns in `migrations/0003_review_execution.sql`. If those tables exist but the column names differ, or a row does not match the current run schema, restore stops before replacement and the current files stay in place.

Migration 0003 has no historical state. `paused` does not start Pi by itself, and the current execution service can still resume a paused run when a provider is configured. Uncertain attempts already block resume inside that service. This package does not call resume and does not open a Pi harness.

`PackageAdmission` is the contract:

| Field                     | Meaning                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admitWork`               | True only when every restored run is terminal and has no uncertain attempt. False when any run is `running`, `pausing`, `paused`, or `uncertain`, or has an uncertain attempt. |
| `resumeBlocked`           | True for each run that must not be resumed or dispatched.                                                                                                                      |
| `reason`                  | `uncertain-attempt`, `foreign-owner`, `restored-historical`, or `terminal`. An uncertain attempt wins over a foreign owner.                                                    |
| `previousState` / `state` | State in the package, then state written into the restored database.                                                                                                           |
| `parentAction`            | The instruction below. Use the fields above in code.                                                                                                                           |

When `admitWork` is false, `parentAction` is:

> Before admitting review work, retire every resumeBlocked run. Do not call ControlExecution resume and do not open a Pi harness for those journals. Migration 0003 has no historical state: running and pausing runs were saved as paused, and runs with uncertain attempts were saved as uncertain. Those rows do not start work by themselves, and paused rows can still be resumed by the current execution service. Block that resume. Uncertain attempts must not be dispatched. A run whose ownerGeneration is not this process is foreign and must not resume. Start later work with a new run id.

When `admitWork` is true:

> Restored runs are terminal or absent. Do not resume their ids. New work needs a new run id. No Pi session was started.

A run is foreign when `ownerGeneration` is omitted or differs from that run. Matching the current process still does not make a restored run eligible to resume. Pass the ownership generation so the reason is accurate.

The restored `app.sqlite` can differ from the package hash after those state updates. The manifest hash is the unmodified package file.

Extra artifact files already in the data directory are left in place. Content-addressed names whose bytes differ from the hash are refused before replacement. Restore does not delete unreferenced artifacts or journals.

## Restart journal

`.package-restore/journal.json` records a replacement that has not finished. It is not part of the exported package. `recoverInterruptedRestore(dataDirectory)` reads it. Call that after this process owns the data directory and before migrations, domain connections, or Pi journals open. It does not take the SQL semaphore and it does not start Pi.

| Journal phase | Recovery                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No journal    | `idle`. Live files are untouched.                                                                                                                                            |
| `prepared`    | `rolled-back`. Staged incoming files are removed. Live files were not renamed. The retained pre-restore package stays.                                                       |
| `swapping`    | `rolled-back`. Replaced files are moved back from `.package-restore/saved/`. Files that did not exist before are moved to `.package-restore/discarded/`.                     |
| `complete`    | `completed`. Incoming and saved copies are removed. The retained pre-restore package stays. If that package's manifest is missing, recovery fails and the saved copies stay. |

A successful restore writes phase `complete` and then clears the journal. If that cleanup fails, the restored files are already in place and the next startup recovery finishes the cleanup. If recovery fails, do not open the databases. SQLite sidecars are not unlinked by hand. A live database is finalized with `PRAGMA journal_mode = DELETE` before it is renamed. If a `-wal` or `-shm` file remains, replacement stops and the current data stays.

`interruptAfter` of `prepared` or `first-replaced` is a test seam. Production callers omit it.

## Parent integration

`PackagesConfig` is the whole dependency set:

- `dataDirectory`: canonical data directory.
- `migrationDirectory`: installed SQL migrations.
- `queries`: the existing short SQL semaphore.
- `quiesce`: an effect that stops admission and closes active Pi and PDF jobs. It runs before the semaphore is acquired. It must not itself hold that semaphore, because those jobs may need SQL to finish.
- `limits`: optional file and byte caps.
- `ownerGeneration`: optional current owner generation.
- `interruptAfter`: omit.

Suggested startup order:

1. Acquire the data-directory owner lock.
2. `recoverInterruptedRestore(canonicalDirectory)`. On failure, stop before opening databases.
3. Run migrations and only then open domain connections and journals.

Suggested export and restore order:

1. Build `quiesce` so it closes `ReviewExecution` and PDF work without holding `queries`.
2. Call `exportReviewPackage` or `restoreReviewPackage`.
3. On restore, if `admission.admitWork` is false, do not call `ControlExecution` resume for any `resumeBlocked` run and do not construct a Pi harness for those journals. New work needs a new run id.

`hasReviewBearingRows(filename)` opens one short read-only connection and does not take the semaphore. Call it while the semaphore is already held, before the legacy database-file restore. If it returns true, refuse that database-only restore. This package module does not replace that path.

This module does not edit `application.ts`, the RPC contracts, or migrations. A second runtime is not created.

## Limitations

- Schema drift in `review_execution_runs`, `review_execution_attempts`, or `review_execution_events` fails closed. The column list is the 0003 list, not a guessed superset.
- There is no remote-owner column. Foreign means a different `owner_generation`, or no generation was supplied.
- `paused` remains resumable by the current execution service until the parent blocks that call.
- Database-only packages are refused here even when they contain no review rows.
- Orphan artifacts and journals are not deleted.
- The retained pre-restore directories are not pruned.
- Windows and macOS package behavior was not run.
- Full `bun run verify`, packaged E2E, and the desktop shell wiring are left to the parent.

## Council recovery corrections

A replacement journal now blocks public review mutations, note operations, and
package/database maintenance until startup recovery completes. The barrier is
checked inside the SQL permit for legacy notes, so queued writes cannot land in
a database that is about to be rolled back. A failed replacement requires reopen;
the UI says so. A waiting maintenance request cannot clear another request's
admission flag when cancelled.

Rollback persists a `reverting` intent and the saved original's SHA-256/size before
renaming any file. If interrupted after the original returns to its live path,
the next recovery verifies that identity and finishes rather than treating a
missing saved file as corruption. Directory sync precedes the reverted receipt.
Tests cut before discard, after discard and after the original returns; a wrong
identity stays blocked without changing the original. Another test leaves the
incoming database installed, verifies application writes are refused, then
reopens and confirms post-recovery writes survive another restart.

## Windows filesystem compatibility

Windows CI exposed the absence of `fs.constants.O_NOFOLLOW`. Package reads now
reject symlinks before opening and compare bigint device/file identities from
`lstat`, the opened handle and another `lstat`. Without a native no-follow flag,
a filesystem with no usable file identity is refused. New files still use
exclusive creation. The same fallback is exercised on Linux by passing flag 0.
See the [Node file-handle stat API](https://nodejs.org/api/fs.html#filehandlestatoptions)
and [Bun Stats API](https://bun.com/reference/node/fs/Stats) for the underlying APIs.

OS-generated relative paths are converted to slash-separated manifest paths;
internal restore paths use portable joins. Untrusted manifest paths are still
validated without rewriting backslashes. POSIX directory fsync remains enabled.
Windows flushes files before atomic rename; this adapter omits POSIX directory
fsync there, so directory metadata durability on hardware power loss is not claimed. Process-interruption recovery remains journaled.
