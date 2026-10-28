import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Schema } from "effect";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";

/** Exact supported engine and host-journal format; upgrades require explicit migration. */
export const journalFormat = "review-pi-1.4.0-v1";

const Identity = Schema.Struct({
  journal_id: Schema.String.check(Schema.isUUID()),
  format: Schema.Literal(journalFormat),
});

/** Open the published SQLite facade and storage after explicit durability readback. */
export async function openReviewJournal(directory: string, journalId: string, existing: boolean) {
  Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(journalId);
  const journals = join(directory, "execution-journals");
  await mkdir(journals, { recursive: true });
  const filename = join(journals, `${journalId}.sqlite`);

  if (existing) await access(filename);
  const database = await openNodeSqliteDatabase(filename, { busyTimeoutMs: 0 });

  try {
    await database.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");

    Schema.decodeUnknownSync(Schema.Struct({ foreign_keys: Schema.Literal(1) }))(
      await database.get("PRAGMA foreign_keys"),
    );

    Schema.decodeUnknownSync(Schema.Struct({ synchronous: Schema.Literal(2) }))(
      await database.get("PRAGMA synchronous"),
    );
    Schema.decodeUnknownSync(Schema.Struct({ journal_mode: Schema.Literal("wal") }))(
      await database.get("PRAGMA journal_mode"),
    );

    if (!existing) {
      await database.exec(
        "CREATE TABLE review_journal_identity (id INTEGER PRIMARY KEY CHECK(id=1), journal_id TEXT NOT NULL UNIQUE, format TEXT NOT NULL)",
      );
      await database.run(
        "INSERT INTO review_journal_identity VALUES (1, ?, ?)",
        journalId,
        journalFormat,
      );
    }

    const identity = Schema.decodeUnknownSync(Identity)(
      await database.get("SELECT journal_id, format FROM review_journal_identity WHERE id=1"),
    );

    if (identity.journal_id !== journalId) throw new Error("Journal identity mismatch");

    return await SqliteStorage.open(database);
  } catch (cause) {
    await database.close();
    throw cause;
  }
}
