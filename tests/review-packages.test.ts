import { constants, Database } from "bun:sqlite";
import {
  Deferred,
  Effect,
  Fiber,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";

import { migrateDatabase } from "../backend/database-files.ts";
import {
  exportReviewPackage,
  hasReviewBearingRows,
  recoverInterruptedRestore,
  restoreReviewPackage,
  type PackagesConfig,
} from "../backend/review/packages.ts";
import { BackendConfig } from "#lib/backend-rpc.ts";
import { Application } from "../backend/application.ts";
import {
  Artifact,
  CommandId,
  Project,
  ReviewCommand,
  Revision,
} from "../src/lib/review/contracts.ts";
import { PackageError, packageEngineFormat } from "../src/lib/review/packages.ts";

const migrations = resolve("migrations");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const failureOf = (effect: Effect.Effect<unknown, PackageError>) => run(effect.pipe(Effect.flip));

const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const walk = async (directory: string): Promise<Array<string>> => {
  const found: Array<string> = [];
  const names = await readdir(directory, { withFileTypes: true });

  for (const entry of names) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await walk(path)));
      continue;
    }

    found.push(path);
  }

  return found;
};

const migrate = (dataDirectory: string) =>
  run(
    Effect.scoped(
      migrateDatabase(
        join(dataDirectory, "app.sqlite"),
        migrations,
        join(dataDirectory, "backups"),
      ),
    ),
  );

const configFor = (
  dataDirectory: string,
  queries: Semaphore.Semaphore,
  extras?: Omit<Partial<PackagesConfig>, "dataDirectory" | "queries">,
) => {
  const config: PackagesConfig = {
    dataDirectory,
    migrationDirectory: migrations,
    queries,
    quiesce: Effect.void,
    ...extras,
  };

  return config;
};

const seedReview = async (dataDirectory: string, label: string, ownerGeneration: string) => {
  const pdf = Buffer.from(`${label}-pdf`);
  const png = Buffer.from(`${label}-png`);
  const pdfSha = hashBytes(pdf);
  const pngSha = hashBytes(png);
  const projectId = randomUUID();
  const revisionId = randomUUID();
  const artifactId = randomUUID();
  const renderId = randomUUID();
  const runningId = randomUUID();
  const uncertainId = randomUUID();
  const findingId = randomUUID();
  const runningJournal = randomUUID();
  const uncertainJournal = randomUUID();

  const project = Schema.decodeUnknownSync(Project)({
    id: projectId,
    name: label,
    version: 0,
    sourceVersion: 0,
    factVersion: 0,
    createdAt: "2026-10-27T00:00:00.000Z",
  });

  const revision = Schema.decodeUnknownSync(Revision)({
    id: revisionId,
    projectId,
    artifactId,
    name: "A1",
    sha256: pdfSha,
    pageCount: 1,
    importedAt: "2026-10-27T00:00:00.000Z",
  });

  const original = Schema.decodeUnknownSync(Artifact)({
    id: artifactId,
    projectId,
    revisionId,
    sheetId: null,
    sha256: pdfSha,
    mediaType: "application/pdf",
    byteLength: pdf.byteLength,
    width: 0,
    height: 0,
    region: null,
    dpi: 0,
    pdfToPixels: [1, 0, 0, 1, 0, 0],
    pixelsToPdf: [1, 0, 0, 1, 0, 0],
    operationId: randomUUID(),
  });

  const render = Schema.decodeUnknownSync(Artifact)({
    id: renderId,
    projectId,
    revisionId,
    sheetId: null,
    sha256: pngSha,
    mediaType: "image/png",
    byteLength: png.byteLength,
    width: 1,
    height: 1,
    region: null,
    dpi: 72,
    pdfToPixels: [1, 0, 0, 1, 0, 0],
    pixelsToPdf: [1, 0, 0, 1, 0, 0],
    operationId: randomUUID(),
  });

  await mkdir(join(dataDirectory, "artifacts"), { recursive: true });
  await mkdir(join(dataDirectory, "execution-journals"), { recursive: true });
  await writeFile(join(dataDirectory, "artifacts", `${pdfSha}.pdf`), pdf);
  await writeFile(join(dataDirectory, "artifacts", `${pngSha}.png`), png);

  const filename = join(dataDirectory, "app.sqlite");
  const database = new DatabaseSync(filename);

  database
    .prepare("INSERT INTO review_projects (id, version, payload) VALUES (?, 0, ?)")
    .run(projectId, JSON.stringify(Schema.encodeSync(Project)(project)));
  database
    .prepare(
      "INSERT INTO review_records (project_id, id, kind, payload) VALUES (?, ?, 'revision', ?)",
    )
    .run(projectId, revisionId, JSON.stringify(Schema.encodeSync(Revision)(revision)));
  database
    .prepare(
      "INSERT INTO review_records (project_id, id, kind, payload) VALUES (?, ?, 'artifact', ?)",
    )
    .run(projectId, artifactId, JSON.stringify(Schema.encodeSync(Artifact)(original)));
  database
    .prepare(
      "INSERT INTO review_records (project_id, id, kind, payload) VALUES (?, ?, 'artifact', ?)",
    )
    .run(projectId, renderId, JSON.stringify(Schema.encodeSync(Artifact)(render)));

  const insertRun = database.prepare(
    `INSERT INTO review_execution_runs (
      run_id, project_id, finding_id, journal_id, engine, owner_generation,
      source_version, fact_version, state, version, route, provider, model,
      max_calls, max_input_tokens, max_output_tokens,
      admitted_calls, reserved_input_tokens, reserved_output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'live', 'meta', 'muse-spark-1.3', 4, 256, 16, 0, 0, 0)`,
  );

  insertRun.run(
    runningId,
    projectId,
    findingId,
    runningJournal,
    packageEngineFormat,
    ownerGeneration,
    "running",
  );
  insertRun.run(
    uncertainId,
    projectId,
    randomUUID(),
    uncertainJournal,
    packageEngineFormat,
    ownerGeneration,
    "paused",
  );
  database
    .prepare(
      `INSERT INTO review_execution_attempts (
      journal_id, task_id, attempt, run_id, owner_generation, fingerprint, status, sent, response_json
    ) VALUES (?, 1, 1, ?, ?, 'fingerprint', 'uncertain', 0, NULL)`,
    )
    .run(uncertainJournal, uncertainId, ownerGeneration);
  database.close();

  for (const journalId of [runningJournal, uncertainJournal]) {
    const journal = new DatabaseSync(
      join(dataDirectory, "execution-journals", `${journalId}.sqlite`),
    );

    journal.exec(
      "CREATE TABLE review_journal_identity (id INTEGER PRIMARY KEY CHECK(id = 1), journal_id TEXT NOT NULL UNIQUE, format TEXT NOT NULL)",
    );
    journal
      .prepare("INSERT INTO review_journal_identity VALUES (1, ?, ?)")
      .run(journalId, packageEngineFormat);
    journal.close();
  }

  const wal = new Database(filename);

  wal.run("PRAGMA journal_mode = WAL");
  wal.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
  wal.run(`INSERT INTO notes(text) VALUES ('${label}-note')`);
  wal.close();

  return { pdfSha, pngSha, runningId, uncertainId, runningJournal, uncertainJournal };
};

const noteTexts = (dataDirectory: string) => {
  const database = new DatabaseSync(join(dataDirectory, "app.sqlite"), { readOnly: true });

  try {
    return database.prepare("SELECT text FROM notes ORDER BY id").all();
  } finally {
    database.close();
  }
};

const runStates = (dataDirectory: string) => {
  const database = new DatabaseSync(join(dataDirectory, "app.sqlite"), { readOnly: true });

  try {
    return database.prepare("SELECT run_id, state FROM review_execution_runs ORDER BY state").all();
  } finally {
    database.close();
  }
};

test("a whole-application package exports closed databases and restores them without resuming runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-roundtrip-"));
  const source = join(root, "source");
  const current = join(root, "current");
  const destination = join(root, "package");
  const foreignOwner = randomUUID();
  const currentOwner = randomUUID();

  try {
    await migrate(source);
    await migrate(current);
    const seeded = await seedReview(source, "packaged", foreignOwner);

    await seedReview(current, "current", randomUUID());
    await writeFile(join(source, ".env"), "API_KEY=super-secret-token");
    await mkdir(join(source, "logs"), { recursive: true });
    await writeFile(join(source, "logs", "app.log"), "super-secret-token");
    await writeFile(join(source, ".execution-owner.sqlite"), "owner-lock-secret");
    await writeFile(join(source, "credentials.json"), "super-secret-token");
    expect(existsSync(`${join(source, "app.sqlite")}-wal`)).toBe(true);

    const exported = await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(source, queries), destination);
      }),
    );

    expect(exported.scope).toBe("application");
    expect(exported.scopeLabel).toBe("whole-application");
    expect(existsSync(join(destination, "app.sqlite-wal"))).toBe(false);
    expect(existsSync(join(destination, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));

    expect(manifest.scopeLabel).toBe("whole-application");
    expect(manifest.engine).toBe(packageEngineFormat);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.journals).toHaveLength(2);
    const packageDatabase = new DatabaseSync(join(destination, "app.sqlite"), { readOnly: true });

    expect(packageDatabase.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    expect(packageDatabase.prepare("SELECT text FROM notes").all()).toEqual([
      { text: "packaged-note" },
    ]);
    packageDatabase.close();

    const packagedJournal = new DatabaseSync(
      join(destination, "journals", `${seeded.runningJournal}.sqlite`),
      { readOnly: true },
    );

    expect(packagedJournal.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    packagedJournal.close();
    const names = await walk(destination);
    const packed = Buffer.concat(await Promise.all(names.map((path) => readFile(path))));

    expect(packed.includes(Buffer.from("super-secret-token"))).toBe(false);
    expect(packed.includes(Buffer.from("owner-lock-secret"))).toBe(false);
    expect(
      names.some(
        (path) =>
          path.includes(".env") ||
          path.includes("execution-owner") ||
          path.includes("credentials") ||
          path.includes(`${join("logs", "app.log")}`),
      ),
    ).toBe(false);

    const restored = await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(
          configFor(current, queries, { ownerGeneration: currentOwner }),
          destination,
        );
      }),
    );

    expect(restored.admission.admitWork).toBe(false);
    expect(restored.admission.parentAction).toContain("Do not call ControlExecution resume");
    expect(restored.admission.runs.map((item) => item.reason).toSorted()).toEqual([
      "foreign-owner",
      "uncertain-attempt",
    ]);
    expect(restored.admission.runs.every((item) => item.resumeBlocked)).toBe(true);
    expect(noteTexts(current)).toEqual([{ text: "packaged-note" }]);
    expect(runStates(current)).toEqual([
      { run_id: seeded.runningId, state: "paused" },
      { run_id: seeded.uncertainId, state: "uncertain" },
    ]);
    expect(existsSync(join(current, "artifacts", `${seeded.pdfSha}.pdf`))).toBe(true);
    expect(existsSync(join(current, "execution-journals", `${seeded.runningJournal}.sqlite`))).toBe(
      true,
    );
    expect(existsSync(join(current, ".execution-owner.sqlite"))).toBe(false);
    expect(restored.preRestorePackagePath).not.toBeNull();

    if (restored.preRestorePackagePath !== null) {
      const preserved = new DatabaseSync(join(restored.preRestorePackagePath, "app.sqlite"), {
        readOnly: true,
      });

      expect(preserved.prepare("SELECT text FROM notes").all()).toEqual([{ text: "current-note" }]);
      preserved.close();
    }

    expect((await run(recoverInterruptedRestore(current))).status).toBe("idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quiesce finishes before the database permit is taken", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-quiesce-"));
  const data = join(root, "data");
  const destination = join(root, "out", "package");
  const order: Array<string> = [];

  try {
    await mkdir(data, { recursive: true });
    await mkdir(join(root, "out"), { recursive: true });
    await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);
        const acquired = yield* Deferred.make<void>();
        const quiesced = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const holder = yield* Effect.forkChild(
          queries.withPermit(
            Effect.gen(function* () {
              order.push("permit-held");
              yield* Deferred.succeed(acquired, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );

        yield* Deferred.await(acquired);

        const exporter = yield* Effect.forkChild(
          exportReviewPackage(
            {
              dataDirectory: data,
              migrationDirectory: migrations,
              queries,
              quiesce: Effect.gen(function* () {
                order.push("quiesce");
                yield* Deferred.succeed(quiesced, undefined);
              }),
            },
            destination,
          ).pipe(Effect.exit),
        );

        yield* Deferred.await(quiesced);
        order.push("quiesce-while-permit-held");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(exporter);
        yield* Fiber.await(holder);
      }),
    );
    expect(order).toEqual(["permit-held", "quiesce", "quiesce-while-permit-held"]);
    expect(existsSync(destination)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export rejects a missing artifact and a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-missing-"));
  const data = join(root, "data");
  const destination = join(root, "package");

  try {
    await migrate(data);
    const seeded = await seedReview(data, "missing", randomUUID());

    await rm(join(data, "artifacts", `${seeded.pdfSha}.pdf`));

    const missing = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(data, queries), destination);
      }),
    );

    expect(missing.reason).toBe("incomplete");
    expect(existsSync(destination)).toBe(false);
    await writeFile(join(data, "artifacts", `${seeded.pdfSha}.pdf`), Buffer.from("missing-pdf"));
    await rm(join(data, "artifacts", `${seeded.pdfSha}.pdf`));
    await symlink(join(root, "outside"), join(data, "artifacts", `${seeded.pdfSha}.pdf`));
    await writeFile(join(root, "outside"), Buffer.from("missing-pdf"));

    const linked = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(data, queries), destination);
      }),
    );

    expect(linked.reason).toBe("corrupt");
    expect(noteTexts(data)).toEqual([{ text: "missing-note" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore rejects corrupt, incompatible, and incomplete packages and keeps the current project", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-reject-"));
  const source = join(root, "source");
  const current = join(root, "current");
  const destination = join(root, "package");

  try {
    await migrate(source);
    await migrate(current);
    const seeded = await seedReview(source, "packaged", randomUUID());

    await seedReview(current, "current", randomUUID());
    await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(source, queries), destination);
      }),
    );
    const artifactPath = join(destination, "artifacts", `${seeded.pdfSha}.pdf`);
    const original = await readFile(artifactPath);

    await writeFile(artifactPath, Buffer.concat([original, Buffer.from("x")]));

    const corrupt = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(configFor(current, queries), destination);
      }),
    );

    expect(corrupt.reason).toBe("corrupt");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    await writeFile(artifactPath, original);
    const database = new DatabaseSync(join(destination, "app.sqlite"));

    database
      .prepare("UPDATE __project_kit_migrations SET sha256 = ? WHERE name = '0001_notes.sql'")
      .run("0".repeat(64));
    database.close();
    const manifestPath = join(destination, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const databaseBytes = await readFile(join(destination, "app.sqlite"));

    manifest.database.sha256 = hashBytes(databaseBytes);
    manifest.database.bytes = databaseBytes.byteLength;
    manifest.migrations = manifest.migrations.map((migration: { name: string; sha256: string }) =>
      migration.name === "0001_notes.sql" ? { ...migration, sha256: "0".repeat(64) } : migration,
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    const incompatible = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(configFor(current, queries), destination);
      }),
    );

    expect(incompatible.reason).toBe("incompatible");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    await rm(join(destination, "journals", `${seeded.runningJournal}.sqlite`));

    const incomplete = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(configFor(current, queries), destination);
      }),
    );

    expect(incomplete.reason).toBe("incomplete");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a database-only package of review data is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-legacy-"));
  const source = join(root, "source");
  const current = join(root, "current");
  const destination = join(root, "package");

  try {
    await migrate(source);
    await migrate(current);
    await seedReview(source, "packaged", randomUUID());
    await seedReview(current, "current", randomUUID());
    await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(source, queries), destination);
      }),
    );
    const manifestPath = join(destination, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    manifest.scope = "database-only";
    manifest.scopeLabel = "database-only";
    manifest.journals = [];
    manifest.artifacts = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(join(destination, "journals"), { recursive: true, force: true });
    await rm(join(destination, "artifacts"), { recursive: true, force: true });
    expect(await run(hasReviewBearingRows(join(source, "app.sqlite")))).toBe(true);
    const notesOnly = join(root, "notes");

    await migrate(notesOnly);
    expect(await run(hasReviewBearingRows(join(notesOnly, "app.sqlite")))).toBe(false);

    const rejected = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(configFor(current, queries), destination);
      }),
    );

    expect(rejected.reason).toBe("incomplete");
    expect(rejected.message).toContain("database-only");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted replacement rolls back on startup and leaves the current project usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-crash-"));
  const source = join(root, "source");
  const current = join(root, "current");
  const destination = join(root, "package");

  try {
    await migrate(source);
    await migrate(current);
    const packaged = await seedReview(source, "packaged", randomUUID());

    await seedReview(current, "current", randomUUID());
    await run(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(source, queries), destination);
      }),
    );

    const prepared = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(
          configFor(current, queries, { interruptAfter: "prepared" }),
          destination,
        );
      }),
    );

    expect(prepared.reason).toBe("interrupted");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    const preparedRecovery = await run(recoverInterruptedRestore(current));

    expect(preparedRecovery.status).toBe("rolled-back");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect((await run(recoverInterruptedRestore(current))).status).toBe("idle");

    const interrupted = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* restoreReviewPackage(
          configFor(current, queries, { interruptAfter: "first-replaced" }),
          destination,
        );
      }),
    );

    expect(interrupted.reason).toBe("interrupted");
    const recovered = await run(recoverInterruptedRestore(current));

    expect(recovered.status).toBe("rolled-back");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect(existsSync(join(current, "artifacts", `${packaged.pdfSha}.pdf`))).toBe(false);
    expect((await run(recoverInterruptedRestore(current))).status).toBe("idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export does not replace an existing destination or exceed a file limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-package-limit-"));
  const data = join(root, "data");
  const destination = join(root, "package");

  try {
    await migrate(data);
    await seedReview(data, "limited", randomUUID());
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "unrelated.txt"), "leave-me");

    const conflict = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(configFor(data, queries), destination);
      }),
    );

    expect(conflict.reason).toBe("conflict");
    expect(await readFile(join(destination, "unrelated.txt"), "utf8")).toBe("leave-me");
    await rm(destination, { recursive: true, force: true });

    const limited = await failureOf(
      Effect.gen(function* () {
        const queries = yield* Semaphore.make(1);

        return yield* exportReviewPackage(
          configFor(data, queries, { limits: { maxFiles: 2, maxBytes: defaultBytes() } }),
          destination,
        );
      }),
    );

    expect(limited.reason).toBe("limit");
    expect(existsSync(destination)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const defaultBytes = () => 2_147_483_648;

const seedNote = (directory: string, text: string) => {
  const database = new DatabaseSync(join(directory, "app.sqlite"));
  database.prepare("INSERT INTO notes(text) VALUES (?)").run(text);
  database.close();
};

const RollbackJournal = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    phase: Schema.Literal("swapping"),
    preRestoreRelative: Schema.NullOr(Schema.String),
    entries: Schema.Array(
      Schema.Struct({
        relativePath: Schema.String,
        hadOriginal: Schema.Boolean,
        status: Schema.String,
        originalIdentity: Schema.optionalKey(
          Schema.Struct({ sha256: Schema.String, bytes: Schema.Int }),
        ),
      }),
    ),
  }),
);

for (const boundary of [
  "before-discard",
  "after-discard",
  "after-original-return",
  "after-original-return-invalid-identity",
] as const) {
  test(`rollback can restart at ${boundary} with the original database intact`, async () => {
    const root = await mkdtemp(join(tmpdir(), "moke-rollback-cut-"));
    const source = join(root, "source");
    const current = join(root, "current");
    const destination = join(root, "package");

    try {
      await migrate(source);
      await migrate(current);
      seedNote(source, "incoming-note");
      seedNote(current, "original-note");
      await run(exportReviewPackage(configFor(source, Semaphore.makeUnsafe(1)), destination));

      const stopped = await failureOf(
        restoreReviewPackage(
          configFor(current, Semaphore.makeUnsafe(1), { interruptAfter: "database-replaced" }),
          destination,
        ),
      );

      expect(stopped.reason).toBe("interrupted");
      expect(noteTexts(current)).toEqual([{ text: "incoming-note" }]);
      const journalFile = join(current, ".package-restore", "journal.json");

      const journal = Schema.decodeUnknownSync(RollbackJournal)(
        await readFile(journalFile, "utf8"),
      );

      const saved = join(current, ".package-restore", "saved", "app.sqlite");
      const original = await readFile(saved);
      await writeFile(
        journalFile,
        JSON.stringify({
          ...journal,
          entries: journal.entries.map((entry) => ({
            ...entry,
            status: "reverting",
            originalIdentity: { sha256: hashBytes(original), bytes: original.byteLength },
          })),
        }),
      );

      if (boundary !== "before-discard")
        await rename(
          join(current, "app.sqlite"),
          join(current, ".package-restore", "discarded-test.sqlite"),
        );

      if (boundary.startsWith("after-original-return"))
        await rename(saved, join(current, "app.sqlite"));

      if (boundary === "after-original-return-invalid-identity") {
        const validJournal = await readFile(journalFile, "utf8");
        const invalid = Schema.decodeUnknownSync(RollbackJournal)(validJournal);
        await writeFile(
          journalFile,
          JSON.stringify({
            ...invalid,
            entries: invalid.entries.map((entry) => ({
              ...entry,
              originalIdentity: { sha256: "0".repeat(64), bytes: original.byteLength },
            })),
          }),
        );
        expect((await failureOf(recoverInterruptedRestore(current))).reason).toBe("corrupt");
        expect(noteTexts(current)).toEqual([{ text: "original-note" }]);
        await writeFile(journalFile, validJournal);
      }

      const recovered = await run(recoverInterruptedRestore(current));
      expect(recovered.status).toBe("rolled-back");
      expect(noteTexts(current)).toEqual([{ text: "original-note" }]);
      expect((await run(recoverInterruptedRestore(current))).status).toBe("idle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("pending replacement blocks application writes until restart recovery completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-admission-after-restore-"));
  const source = join(root, "source");
  const current = join(root, "current");
  const destination = join(root, "package");

  const openApplication = () => {
    const runtime: ManagedRuntime.ManagedRuntime<Application, unknown> = ManagedRuntime.make(
      Application.layer(
        new BackendConfig({
          dataDirectory: current,
          migrationDirectory: migrations,
          token: Redacted.make("t".repeat(32)),
        }),
        { runPromise: (effect, options) => runtime.runPromise(effect, options) },
      ),
    );

    return runtime;
  };

  let runtime = openApplication();

  try {
    await migrate(source);
    seedNote(source, "incoming-note");
    await run(exportReviewPackage(configFor(source, Semaphore.makeUnsafe(1)), destination));
    const application = await runtime.runPromise(Application);
    await runtime.runPromise(application.add("original-note"));
    await failureOf(
      restoreReviewPackage(
        configFor(current, Semaphore.makeUnsafe(1), { interruptAfter: "database-replaced" }),
        destination,
      ),
    );

    const blockedProject = await runtime.runPromise(
      application.review
        .command(
          ReviewCommand.cases.CreateProject.make({
            commandId: Schema.decodeUnknownSync(CommandId)(randomUUID()),
            name: "Must not commit",
          }),
        )
        .pipe(Effect.result),
    );

    expect(Result.isFailure(blockedProject)).toBe(true);

    const blockedNote = await runtime.runPromise(
      application.add("must-not-commit").pipe(Effect.result),
    );

    expect(Result.isFailure(blockedNote)).toBe(true);

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const restoreDirectory = join(current, ".package-restore");
      await chmod(restoreDirectory, 0);

      try {
        const denied = await runtime.runPromise(
          application.add("must-not-commit-with-unreadable-journal").pipe(Effect.result),
        );

        expect(Result.isFailure(denied)).toBe(true);
        expect((await failureOf(recoverInterruptedRestore(current))).reason).toBe("corrupt");
      } finally {
        await chmod(restoreDirectory, 0o700);
      }
    }

    expect(noteTexts(current)).toEqual([{ text: "incoming-note" }]);
    await runtime.dispose();
    runtime = openApplication();
    const recovered = await runtime.runPromise(Application);
    expect((await runtime.runPromise(recovered.list)).map((note) => note.text)).toEqual([
      "original-note",
    ]);
    const snapshot = await runtime.runPromise(recovered.review.snapshot(null, 0));
    expect(snapshot.projects).toHaveLength(0);
    await runtime.runPromise(recovered.add("after-recovery"));
    await runtime.dispose();
    runtime = openApplication();
    const reopened = await runtime.runPromise(Application);
    expect((await runtime.runPromise(reopened.list)).map((note) => note.text).toSorted()).toEqual([
      "after-recovery",
      "original-note",
    ]);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
