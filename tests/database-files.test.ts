import { Effect } from "effect";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";
import { exportDatabase, migrateDatabase, restoreDatabase } from "../backend/database-files.ts";

test("an upgrade backs up real data; export and restore recover it", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-files-"));
  const migrations = join(root, "migrations");
  const backups = join(root, "backups");
  const filename = join(root, "app.sqlite");
  const { mkdir } = await import("node:fs/promises");
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
    expect(migrate()).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed migrations roll back and corrupt restore files leave data intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "database-failure-"));
  const migrations = join(root, "migrations");
  const backups = join(root, "backups");
  const filename = join(root, "app.sqlite");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(migrations);
  await copyFile("migrations/0001_notes.sql", join(migrations, "0001_notes.sql"));

  try {
    await Effect.runPromise(Effect.scoped(migrateDatabase(filename, migrations, backups)));
    await writeFile(
      join(migrations, "0002_broken.sql"),
      "CREATE TABLE partial (id INTEGER); THIS IS NOT SQL;",
    );
    expect(
      Effect.runPromise(Effect.scoped(migrateDatabase(filename, migrations, backups))),
    ).rejects.toThrow();
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").all()).toEqual(
      [],
    );
    database.close();
    const corrupt = join(root, "bad.sqlite");
    await writeFile(corrupt, "invalid database");
    expect(
      Effect.runPromise(Effect.scoped(restoreDatabase(filename, corrupt, migrations, backups))),
    ).rejects.toThrow();
    const preserved = new DatabaseSync(filename);
    expect(
      preserved.prepare("SELECT count(*) AS count FROM __project_kit_migrations").get(),
    ).toEqual({ count: 1 });
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
