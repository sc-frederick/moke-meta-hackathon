import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

test("facade multi-statement/bindings, rollback, queue, handle expiry, close/reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-facade-"));
  const path = join(dir, "journal.sqlite");
  const db = await openNodeSqliteDatabase(path);
  await db.exec(
    "CREATE TABLE sample (id INTEGER PRIMARY KEY, value BLOB); CREATE TABLE other (id INTEGER);",
  );
  await db.run("INSERT INTO sample VALUES (?, ?)", 1, new Uint8Array([1, 2, 3]));
  expect(await db.get("SELECT value FROM sample WHERE id = ?", 1)).toEqual({
    value: new Uint8Array([1, 2, 3]),
  });
  let expired: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;

  const rollback = await db
    .transaction(async (tx) => {
      expired = tx;
      await tx.run("INSERT INTO sample VALUES (?, ?)", 2, null);
      throw new Error("rollback-fixture");
    })
    .catch((cause: unknown) => cause);

  expect(rollback).toMatchObject({ message: "rollback-fixture" });
  expect(await db.all("SELECT id FROM sample")).toEqual([{ id: 1 }]);

  if (expired === undefined) throw new Error("No transaction handle captured");
  const expiredRead = await expired.get("SELECT 1").catch((cause: unknown) => cause);
  expect(expiredRead).toMatchObject({ message: expect.stringContaining("no longer active") });

  const hold = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];

  const transaction = db.transaction(async (tx) => {
    await tx.run("INSERT INTO sample VALUES (?, ?)", 3, null);
    order.push("inside");
    started.resolve();
    await hold.promise;
    order.push("released");
  });

  await started.promise;

  const queued = db.get("SELECT count(*) AS n FROM sample").then((row) => {
    order.push("queued");

    return row;
  });

  const closed = db.close().then(() => {
    order.push("closed");
  });

  await Promise.resolve();
  const beforeRelease = [...order];
  hold.resolve();
  await transaction;
  expect(await queued).toEqual({ n: 2 });
  await closed;
  await db.close();
  expect(beforeRelease).toEqual(["inside"]);
  expect(order).toEqual(["inside", "released", "queued", "closed"]);
  const reopened = await openNodeSqliteDatabase(path);
  expect(await reopened.all("SELECT id FROM sample ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }]);
  await reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test("rollback failure yields AggregateError and connection remains usable", async () => {
  const db = await openNodeSqliteDatabase(":memory:");

  const rollback = await db
    .transaction(async (tx) => {
      await tx.exec("ROLLBACK");
      throw new Error("callback-failed");
    })
    .catch((cause: unknown) => cause);

  expect(rollback).toBeInstanceOf(AggregateError);
  expect(await db.get("SELECT 1 AS n")).toEqual({ n: 1 });
  await db.close();
});
