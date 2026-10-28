import { Effect } from "effect";
import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";
import { exportDatabase, migrateDatabase, restoreDatabase } from "../../backend/database-files.ts";
import { DatabaseFileError } from "#lib/backend-rpc.ts";

test("an upgrade backs up real data; export and restore recover it", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-files-"));
  const migrations = join(root, "migrations");
  const backups = join(root, "backups");
  const filename = join(root, "app.sqlite");
  await mkdir(migrations);
  await copyFile("migrations/0001_notes.sql", join(migrations, "0001_notes.sql"));

  const migrate = () =>
    Effect.runPromise(Effect.scoped(migrateDatabase(filename, migrations, backups)));

  try {
    await migrate();
    const initial = new DatabaseSync(filename);
    initial.prepare("INSERT INTO notes(text) VALUES (?)").run("Keep this note");
    initial.close();
    await writeFile(
      join(migrations, "0002_add_settings.sql"),
      "CREATE TABLE settings (name TEXT PRIMARY KEY); CREATE INDEX notes_text ON notes(text);",
    );
    await migrate();
    const snapshot = (await readdir(backups))[0];
    expect(snapshot).toBeDefined();
    const exported = join(root, "export.sqlite");
    await Effect.runPromise(Effect.scoped(exportDatabase(filename, exported)));
    const current = new DatabaseSync(filename);
    current.exec("DELETE FROM notes");
    current.close();
    await Effect.runPromise(
      Effect.scoped(restoreDatabase(filename, exported, migrations, backups)),
    );
    const restored = new DatabaseSync(filename);
    expect(restored.prepare("SELECT text FROM notes").all()).toEqual([{ text: "Keep this note" }]);
    expect(
      restored.prepare("SELECT name FROM sqlite_master WHERE name = 'notes_text'").all(),
    ).toHaveLength(1);
    restored.close();
    const applied = await readFile(join(migrations, "0002_add_settings.sql"), "utf8");
    await writeFile(join(migrations, "0002_add_settings.sql"), applied + " -- edited");
    expect(
      await Effect.runPromise(
        Effect.scoped(migrateDatabase(filename, migrations, backups)).pipe(Effect.flip),
      ),
    ).toBeInstanceOf(DatabaseFileError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed migrations roll back and corrupt restore files leave data intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-failure-"));
  const migrations = join(root, "migrations");
  const backups = join(root, "backups");
  const filename = join(root, "app.sqlite");
  await mkdir(migrations);
  await copyFile("migrations/0001_notes.sql", join(migrations, "0001_notes.sql"));

  try {
    await Effect.runPromise(Effect.scoped(migrateDatabase(filename, migrations, backups)));
    await writeFile(
      join(migrations, "0002_broken.sql"),
      "CREATE TABLE partial (id INTEGER); THIS IS NOT SQL;",
    );
    expect(
      await Effect.runPromise(
        Effect.scoped(migrateDatabase(filename, migrations, backups)).pipe(Effect.flip),
      ),
    ).toBeInstanceOf(DatabaseFileError);
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").all()).toEqual(
      [],
    );
    database.close();
    const corrupt = join(root, "bad.sqlite");
    await writeFile(corrupt, "invalid database");
    expect(
      await Effect.runPromise(
        Effect.scoped(restoreDatabase(filename, corrupt, migrations, backups)).pipe(Effect.flip),
      ),
    ).toBeInstanceOf(DatabaseFileError);
    const preserved = new DatabaseSync(filename);
    expect(
      preserved.prepare("SELECT count(*) AS count FROM __project_kit_migrations").get(),
    ).toEqual({ count: 1 });
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WAL exports are standalone and restore clears persistent journals before replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-wal-"));
  const filename = join(root, "app.sqlite");
  const exported = join(root, "export.sqlite");
  const backups = join(root, "backups");

  try {
    await Effect.runPromise(Effect.scoped(migrateDatabase(filename, "migrations", backups)));
    const database = new Database(filename);
    database.run("PRAGMA journal_mode = WAL");
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
    database.run("INSERT INTO notes(text) VALUES ('Keep committed WAL data')");
    database.close();

    expect(existsSync(`${filename}-wal`)).toBe(true);
    await Effect.runPromise(Effect.scoped(exportDatabase(filename, exported)));
    const portable = new DatabaseSync(exported, { readOnly: true });

    try {
      expect(portable.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(portable.prepare("SELECT text FROM notes").all()).toEqual([
        { text: "Keep committed WAL data" },
      ]);
    } finally {
      portable.close();
    }

    const changed = new Database(filename);
    changed.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
    changed.run("DELETE FROM notes");
    changed.close();
    await Effect.runPromise(
      Effect.scoped(restoreDatabase(filename, exported, "migrations", backups)),
    );
    expect(existsSync(`${filename}-wal`)).toBe(false);
    expect(existsSync(`${filename}-shm`)).toBe(false);
    const restored = new DatabaseSync(filename, { readOnly: true });

    try {
      expect(restored.prepare("SELECT text FROM notes").all()).toEqual([
        { text: "Keep committed WAL data" },
      ]);
    } finally {
      restored.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
