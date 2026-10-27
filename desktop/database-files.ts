import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";

/** A safe failure at the database file, migration, or recovery boundary. */
export class DatabaseFileError extends Schema.TaggedError<DatabaseFileError>()(
  "DatabaseFileError",
  {
    message: Schema.String,
  },
) {}

const MigrationRow = Schema.Struct({ name: Schema.String, sha256: Schema.String });
const parseHistory = Schema.decodeUnknownSync(Schema.Array(MigrationRow));

const io = <A>(action: () => Promise<A>, message: string) =>
  Effect.tryPromise({
    try: action,
    catch: () => new DatabaseFileError({ message }),
  });

const sqlite = <A>(action: () => A, message: string) =>
  Effect.try({
    try: action,
    catch: () => new DatabaseFileError({ message }),
  });

const open = (filename: string, readOnly = false) =>
  Effect.acquireRelease(
    sqlite(() => new DatabaseSync(filename, { readOnly }), "The database could not be opened."),
    (database) => Effect.sync(() => database.close()),
  );

const loadMigrations = Effect.fn("loadMigrations")(function* (directory: string) {
  const entries = yield* io(() => readdir(directory), "The migration directory could not be read.");
  const names = entries.filter((name) => name.endsWith(".sql")).toSorted();
  const seen = new Set<string>();

  const migrations: Array<{
    readonly name: string;
    readonly sql: string;
    readonly sha256: string;
  }> = [];

  for (const name of names) {
    const id = name.slice(0, 4);

    if (!/^\d{4}_[a-z0-9_-]+\.sql$/.test(name) || seen.has(id)) {
      return yield* new DatabaseFileError({
        message: "Migrations require unique ordered names such as 0001_notes.sql.",
      });
    }

    seen.add(id);

    const sql = yield* io(
      () => readFile(join(directory, name), "utf8"),
      "A migration could not be read.",
    );

    migrations.push({ name, sql, sha256: createHash("sha256").update(sql).digest("hex") });
  }

  return migrations;
});

const validateHistory = (
  history: ReadonlyArray<typeof MigrationRow.Type>,
  migrations: ReadonlyArray<typeof MigrationRow.Type>,
) =>
  history.every((row, index) => {
    const migration = migrations[index];

    return (
      migration !== undefined && row.name === migration.name && row.sha256 === migration.sha256
    );
  });

const snapshot = Effect.fn("snapshot")(function* (
  database: DatabaseSync,
  directory: string,
  reason: string,
) {
  yield* io(
    () => mkdir(directory, { recursive: true }),
    "The backup directory could not be created.",
  );
  const name = `${new Date().toISOString().replaceAll(":", "-")}-${reason}-${randomUUID()}.sqlite`;
  const filename = join(directory, name);
  yield* io(
    () => backup(database, filename),
    "The database backup failed. The original database was preserved.",
  );

  return filename;
});

/** Apply immutable SQL migrations transactionally after a consistent SQLite backup. */
export const migrateDatabase = Effect.fn("migrateDatabase")(function* (
  filename: string,
  migrationDirectory: string,
  backupDirectory: string,
) {
  const migrations = yield* loadMigrations(migrationDirectory);
  const existing = existsSync(filename);
  yield* io(
    () => mkdir(dirname(filename), { recursive: true }),
    "The application data directory could not be created.",
  );
  const database = yield* open(filename);
  yield* sqlite(
    () => database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"),
    "The database could not be configured.",
  );
  yield* sqlite(
    () =>
      database.exec(
        "CREATE TABLE IF NOT EXISTS __project_kit_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)",
      ),
    "Migration history could not be initialized.",
  );

  const history = yield* sqlite(
    () =>
      parseHistory(
        database.prepare("SELECT name, sha256 FROM __project_kit_migrations ORDER BY name").all(),
      ),
    "Migration history is invalid.",
  );

  if (!validateHistory(history, migrations)) {
    return yield* new DatabaseFileError({
      message:
        "Applied migrations were edited or this database belongs to a newer app. Restore the matching app or backup.",
    });
  }

  const pending = migrations.slice(history.length);

  if (pending.length === 0) return;

  if (existing) yield* snapshot(database, backupDirectory, "before-migration");

  yield* sqlite(() => {
    database.exec("BEGIN IMMEDIATE");

    try {
      for (const migration of pending) {
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO __project_kit_migrations (name, sha256) VALUES (?, ?)")
          .run(migration.name, migration.sha256);
      }

      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  }, "Database migration failed. Existing data and the pre-migration backup were preserved.");

  const backups = (yield* io(
    () =>
      readdir(backupDirectory).catch((error) => {
        if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) return [];
        throw error;
      }),
    "Backups could not be listed.",
  ))
    .filter((name) => /^\d{4}-.*-before-migration-.*\.sqlite$/.test(name))
    .toSorted()
    .reverse();

  for (const old of backups.slice(5)) {
    yield* io(() => rm(join(backupDirectory, old)), "An old backup could not be removed.");
  }
});

/** Export a consistent database using SQLite's backup API, including WAL contents. */
export const exportDatabase = Effect.fn("exportDatabase")(function* (
  filename: string,
  destination: string,
) {
  const database = yield* open(filename, true);
  yield* io(() => backup(database, destination), "The database could not be exported.");

  return destination;
});

/** Restore a checked backup atomically. The application database must be closed. */
export const restoreDatabase = Effect.fn("restoreDatabase")(function* (
  filename: string,
  source: string,
  migrationDirectory: string,
  backupDirectory: string,
) {
  if (filename === source)
    return yield* new DatabaseFileError({ message: "Choose a separate backup file." });

  const migrations = yield* loadMigrations(migrationDirectory);
  const incoming = yield* open(source, true);

  const valid = yield* sqlite(() => {
    const integrity = Schema.decodeUnknownSync(
      Schema.Struct({ quick_check: Schema.Literal("ok") }),
    )(incoming.prepare("PRAGMA quick_check").get());

    const history = parseHistory(
      incoming.prepare("SELECT name, sha256 FROM __project_kit_migrations ORDER BY name").all(),
    );

    incoming.prepare("SELECT id, text, created_at FROM notes LIMIT 0").all();

    return (
      integrity.quick_check === "ok" && history.length > 0 && validateHistory(history, migrations)
    );
  }, "The selected file is not a compatible application backup.");

  if (!valid)
    return yield* new DatabaseFileError({ message: "This backup uses incompatible migrations." });

  if (existsSync(filename)) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const current = yield* open(filename, true);
        yield* snapshot(current, backupDirectory, "before-restore");
      }),
    );
  }

  const replacement = join(dirname(filename), `${basename(filename)}.${randomUUID()}.restore`);
  yield* Effect.acquireRelease(
    io(() => backup(incoming, replacement), "The backup could not be prepared for restore."),
    () => Effect.promise(() => rm(replacement, { force: true })),
  );
  yield* io(
    () => rename(replacement, filename),
    "The original database could not be replaced. It was preserved.",
  );
});
