import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Duration, Effect, Exit, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Artifact, Revision } from "#lib/review/contracts.ts";
import { ExecutionState } from "#lib/review/execution.ts";
import { PacketReview } from "#lib/review/packet.ts";
import {
  defaultPackageLimits,
  PackageAdmission,
  PackageError,
  PackageExportResult,
  PackageFile,
  PackageInterrupt,
  PackageJournalFile,
  PackageLimits,
  PackageManifest,
  PackageRecovery,
  PackageRestoreResult,
  PackageRunSnapshot,
  RestoredRun,
  packageEngineFormat,
  packageFormatVersion,
} from "#lib/review/packages.ts";
import { exportDatabase } from "../database-files.ts";
import { journalFormat } from "../inference/journal.ts";
import { RunRecord } from "./execution-store.ts";
import { openRegularFile, portablePackagePath } from "./package-files.ts";

/**
 * Parent-supplied dependencies.
 * Quiesce runs before `queries` is acquired. This module does not start a runtime.
 */
export interface PackagesConfig {
  /** Canonical application data directory. The process owner lock stays outside the package. */
  readonly dataDirectory: string;
  /** Directory of immutable SQL migrations installed with this build. */
  readonly migrationDirectory: string;
  /** Shared short SQL semaphore. Held only around backup, validation, and replacement. */
  readonly queries: Semaphore.Semaphore;
  /**
   * Stop admission and close active Pi and PDF jobs.
   * The parent must run this without holding `queries`, because those jobs may need SQL.
   */
  readonly quiesce: Effect.Effect<void, PackageError>;
  /** File-count and byte caps. Omitted caps use the documented defaults. */
  readonly limits?: typeof PackageLimits.Type;
  /**
   * Owner generation of this process.
   * A restored run with a different generation is foreign and must not resume.
   * Omitting it treats every restored run as foreign.
   */
  readonly ownerGeneration?: string;
  /**
   * Stops a restore after a durable journal write so startup recovery can be tested.
   * Production callers omit this.
   */
  readonly interruptAfter?: PackageInterrupt;
}

const runColumns = [
  "run_id",
  "project_id",
  "finding_id",
  "journal_id",
  "engine",
  "owner_generation",
  "source_version",
  "fact_version",
  "state",
  "version",
  "route",
  "provider",
  "model",
  "max_calls",
  "max_input_tokens",
  "max_output_tokens",
  "admitted_calls",
  "reserved_input_tokens",
  "reserved_output_tokens",
] as const;

const promptRunColumns = [...runColumns, "prompt_version", "review_context_json"] as const;
const timedRunColumns = [...promptRunColumns, "started_at", "state_changed_at"] as const;

const attemptColumns = [
  "journal_id",
  "task_id",
  "attempt",
  "run_id",
  "owner_generation",
  "fingerprint",
  "status",
  "sent",
  "response_json",
] as const;

const eventColumns = ["sequence", "run_id", "project_id", "state", "version"] as const;

const packetColumns = [
  "id",
  "project_id",
  "conversation_id",
  "command_id",
  "fingerprint",
  "source_version",
  "owner_generation",
  "journal_id",
  "engine",
  "payload",
] as const;

const packetAttemptColumns = [
  "review_id",
  "task_id",
  "attempt",
  "kind",
  "fingerprint",
  "status",
  "sent",
  "response_json",
] as const;

const packetToolColumns = ["review_id", "task_id", "operation", "result_json"] as const;

const PacketRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  project_id: Schema.String.check(Schema.isUUID()),
  conversation_id: Schema.String.check(Schema.isUUID()),
  owner_generation: Schema.String.check(Schema.isUUID()),
  journal_id: Schema.String.check(Schema.isUUID()),
  engine: Schema.String,
  payload: Schema.fromJsonString(PacketReview),
});

const blockAdmission =
  "Before admitting review work, retire every resumeBlocked run. Do not call ControlExecution resume and do not open a Pi harness for those journals. Migration 0003 has no historical state: running and pausing runs were saved as paused, and runs with uncertain attempts were saved as uncertain. Those rows do not start work by themselves, and paused rows can still be resumed by the current execution service. Block that resume. Uncertain attempts must not be dispatched. A run whose ownerGeneration is not this process is foreign and must not resume. Start later work with a new run id.";

const allowNewWork =
  "Restored runs are terminal or absent. Do not resume their ids. New work needs a new run id. No Pi session was started.";

const SwapStatus = Schema.Literals([
  "pending",
  "moving-aside",
  "moved-aside",
  "moving-in",
  "replaced",
  "reverting",
  "reverted",
]);

const SwapEntry = Schema.Struct({
  relativePath: Schema.String,
  hadOriginal: Schema.Boolean,
  status: SwapStatus,
  originalIdentity: Schema.optionalKey(
    Schema.Struct({
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});

const RestoreJournal = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "swapping", "complete"]),
  preRestoreRelative: Schema.NullOr(Schema.String),
  entries: Schema.Array(SwapEntry),
});

type SwapEntry = typeof SwapEntry.Type;

type RestoreJournal = typeof RestoreJournal.Type;

type ExecutionState = typeof ExecutionState.Type;

type ArtifactRef = {
  readonly sha256: string;
  readonly mediaType: "application/pdf" | "image/png";
  readonly byteLength: number | undefined;
};

type RunRef = {
  readonly kind: "count" | "packet";
  readonly runId: string;
  readonly projectId: string;
  readonly journalId: string;
  readonly state: ExecutionState;
  readonly ownerGeneration: string;
  readonly version: number;
  readonly uncertainAttempts: number;
  readonly engine: string;
};

type DomainSnapshot = {
  readonly reviewBearing: boolean;
  readonly artifacts: ReadonlyArray<ArtifactRef>;
  readonly runs: ReadonlyArray<RunRef>;
};

type MigrationIdentity = {
  readonly name: string;
  readonly sha256: string;
};

type Placement = "external" | "retained";

const fail = (reason: PackageError["reason"], message: string) =>
  new PackageError({ reason, message });

const asPackageError = (cause: unknown, message: string) =>
  Schema.is(PackageError)(cause) ? cause : fail("unavailable", message);

const noFollow = constants.O_NOFOLLOW ?? 0;

const artifactName = (sha256: string, mediaType: ArtifactRef["mediaType"]) => {
  const extension = mediaType === "application/pdf" ? "pdf" : "png";

  return `artifacts/${sha256}.${extension}`;
};

const packageJournalName = (journalId: string) => `journals/${journalId}.sqlite`;

const liveJournalName = (journalId: string) => `execution-journals/${journalId}.sqlite`;

const isSafeRelative = (value: string) => {
  if (value.length === 0 || value.length > 240 || value.includes("\0") || value.includes("\\")) {
    return false;
  }

  if (isAbsolute(value)) return false;

  const parts = value.split("/");

  return parts.every((part) => part !== "" && part !== "." && part !== "..");
};

const withinRoot = (root: string, candidate: string) => {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);

  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const safeJoin = (root: string, relativePath: string) => {
  if (!isSafeRelative(relativePath)) return undefined;

  const target = join(root, relativePath);

  return withinRoot(root, target) ? target : undefined;
};

const liveRelativeAllowed = (relativePath: string) =>
  relativePath === "app.sqlite" ||
  /^artifacts\/[a-f0-9]{64}\.(?:pdf|png)$/.test(relativePath) ||
  /^execution-journals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/.test(
    relativePath,
  );

const retainedRelativeAllowed = (relativePath: string) =>
  /^\.package-restore\/retained\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    relativePath,
  );

const sameColumns = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) => {
  if (actual.length !== expected.length) return false;

  const seen = new Set(actual);

  return seen.size === actual.length && expected.every((name) => seen.has(name));
};

const io = (action: () => Promise<void>, message: string) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => asPackageError(cause, message),
  });

const makeDirectory = (path: string, message: string) =>
  io(async () => {
    await mkdir(path, { recursive: true });
  }, message);

const fsyncDirectory = (directory: string) =>
  // POSIX directory fsync supplements file flushes; Windows uses flushed files and journaled renames.
  process.platform === "win32"
    ? Effect.void
    : io(async () => {
        const handle = await open(directory, "r");

        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }, "A directory could not be saved.");

const removeTree = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: true, force: true }),
    catch: () => fail("unavailable", "A temporary package directory could not be removed."),
  });

const hashFile = (path: string, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await openRegularFile(path, noFollow);
      const hash = createHash("sha256");
      let bytes = 0;

      try {
        if ((await handle.stat()).size > maxBytes)
          throw fail("limit", "A package file exceeds the size limit.");
        const stream = handle.createReadStream();

        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) {
            throw fail("corrupt", "A package file could not be read.");
          }

          bytes += chunk.byteLength;

          if (bytes > maxBytes) throw fail("limit", "A package file exceeds the size limit.");

          hash.update(chunk);
        }
      } finally {
        await handle.close();
      }

      return { sha256: hash.digest("hex"), bytes };
    },
    catch: (cause) => asPackageError(cause, "A package file could not be hashed."),
  });

const copyRegularFile = (source: string, destination: string, maxBytes: number) =>
  Effect.gen(function* () {
    const identity = yield* hashFile(source, maxBytes);

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(destination), { recursive: true });
        const input = await openRegularFile(source, noFollow);

        try {
          const output = await open(
            destination,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          );

          try {
            const stream = input.createReadStream();

            for await (const chunk of stream) {
              if (!Buffer.isBuffer(chunk))
                throw fail("corrupt", "A package file could not be copied.");
              await output.write(chunk);
            }

            await output.sync();
          } finally {
            await output.close();
          }
        } finally {
          await input.close();
        }
      },
      catch: (cause) => asPackageError(cause, "A package file could not be copied."),
    });

    const copied = yield* hashFile(destination, maxBytes);

    if (copied.sha256 !== identity.sha256 || copied.bytes !== identity.bytes) {
      return yield* fail("corrupt", "A copied package file did not match its source.");
    }

    return identity;
  });

const writeBytes = (path: string, bytes: Uint8Array | string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      );

      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporary, path);
    },
    catch: (cause) => asPackageError(cause, "A package file could not be written."),
  });

const openSqlite = (filename: string, readOnly: boolean) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(filename, { readOnly }),
      catch: () => fail("unavailable", "A SQLite file could not be opened."),
    }),
    (database) =>
      Effect.sync(() => {
        if (database.isOpen) database.close();
      }),
  );

const finalizeDelete = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* openSqlite(filename, false);

      yield* Effect.try({
        try: () => {
          Schema.decodeUnknownSync(Schema.Struct({ journal_mode: Schema.Literal("delete") }))(
            database.prepare("PRAGMA journal_mode = DELETE").get(),
          );
        },
        catch: () =>
          fail(
            "unavailable",
            "The database journal could not be finalized. Existing data was preserved.",
          ),
      });
    }),
  ).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        if (existsSync(`${filename}-wal`) || existsSync(`${filename}-shm`)) {
          return yield* fail(
            "unavailable",
            "SQLite left a journal sidecar. It was not removed manually, and existing data was preserved.",
          );
        }
      }),
    ),
  );

const backupSqlite = (source: string, destination: string) =>
  Effect.gen(function* () {
    yield* makeDirectory(dirname(destination), "The package directory could not be created.");
    yield* Effect.scoped(exportDatabase(source, destination)).pipe(
      Effect.mapError(() =>
        fail(
          "unavailable",
          "A SQLite file could not be backed up. An open database was not copied directly.",
        ),
      ),
    );

    if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) {
      return yield* fail("corrupt", "The backup still has a SQLite journal sidecar.");
    }
  });

const migrationIdentities = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(directory);
      const names = entries.filter((name) => name.endsWith(".sql")).toSorted();
      const seen = new Set<string>();
      const migrations: Array<MigrationIdentity> = [];

      for (const name of names) {
        const id = name.slice(0, 4);

        if (!/^\d{4}_[a-z0-9_-]+\.sql$/.test(name) || seen.has(id)) {
          throw fail(
            "incompatible",
            "Migrations require unique ordered names such as 0001_notes.sql.",
          );
        }

        seen.add(id);
        const sql = await readFile(join(directory, name), "utf8");

        migrations.push({ name, sha256: createHash("sha256").update(sql).digest("hex") });
      }

      return migrations;
    },
    catch: (cause) => asPackageError(cause, "The migration directory could not be read."),
  });

const historyMatches = (
  history: ReadonlyArray<MigrationIdentity>,
  installed: ReadonlyArray<MigrationIdentity>,
) =>
  history.length > 0 &&
  history.length <= installed.length &&
  history.every((row, index) => {
    const migration = installed[index];

    return (
      migration !== undefined && row.name === migration.name && row.sha256 === migration.sha256
    );
  });

const sameHistory = (
  left: ReadonlyArray<MigrationIdentity>,
  right: ReadonlyArray<MigrationIdentity>,
) =>
  left.length === right.length &&
  left.every((row, index) => {
    const other = right[index];

    return other !== undefined && row.name === other.name && row.sha256 === other.sha256;
  });

const inspectDatabase = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* openSqlite(filename, true);

      yield* Schema.decodeUnknownEffect(Schema.Struct({ quick_check: Schema.Literal("ok") }))(
        database.prepare("PRAGMA quick_check").get(),
      ).pipe(Effect.mapError(() => fail("corrupt", "The database failed its integrity check.")));

      const migrations = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ name: Schema.String, sha256: Schema.String })),
      )(
        database.prepare("SELECT name, sha256 FROM __project_kit_migrations ORDER BY name").all(),
      ).pipe(Effect.mapError(() => fail("incompatible", "Migration history could not be read.")));

      return { migrations };
    }),
  );

const journalIdentity = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* openSqlite(filename, true);

      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              journal_id: Schema.String,
              format: Schema.Literal(packageEngineFormat),
            }),
          )(
            database
              .prepare("SELECT journal_id, format FROM review_journal_identity WHERE id = 1")
              .get(),
          ),
        catch: () => fail("incomplete", "The Pi journal is missing its checkpoint identity."),
      });
    }),
  );

const Names = Schema.Array(Schema.Struct({ name: Schema.String }));
const CountRows = Schema.Array(Schema.Struct({ n: Schema.Int }));
const PayloadRows = Schema.Array(Schema.Struct({ payload: Schema.String }));
const AttemptCounts = Schema.Array(Schema.Struct({ run_id: Schema.String, n: Schema.Int }));

const withSql = <A, E>(
  filename: string,
  readonly: boolean,
  operation: Effect.Effect<A, E, SqlClient.SqlClient>,
  message: string,
) =>
  Effect.scoped(
    operation.pipe(
      Effect.provide(
        SqliteClient.layer({
          filename,
          readonly,
          create: false,
          disableWAL: true,
          busyTimeout: Duration.millis(0),
        }),
      ),
    ),
  ).pipe(Effect.mapError((cause) => asPackageError(cause, message)));

const tableNames = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Names)(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).pipe(Effect.mapError(() => fail("corrupt", "The database catalog could not be read.")));

    return new Set(rows.map((row) => row.name));
  });

const countTable = <E, R>(present: boolean, read: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    if (!present) return 0;

    const rows = yield* Schema.decodeUnknownEffect(CountRows)(yield* read).pipe(
      Effect.mapError(() => fail("corrupt", "A review table could not be counted.")),
    );

    return rows[0]?.n ?? 0;
  });

const decodePayload = (payload: string) =>
  Effect.try({
    try: () => JSON.parse(payload),
    catch: () => fail("incomplete", "A review record payload is not valid JSON."),
  });

const addArtifact = (
  artifacts: Map<string, ArtifactRef>,
  sha256: string,
  mediaType: ArtifactRef["mediaType"],
  byteLength: number | undefined,
) => {
  const key = artifactName(sha256, mediaType);
  const previous = artifacts.get(key);

  if (
    previous !== undefined &&
    previous.byteLength !== undefined &&
    byteLength !== undefined &&
    previous.byteLength !== byteLength
  ) {
    return fail("incomplete", "Two review records disagree about the size of one artifact.");
  }

  if (previous === undefined || (previous.byteLength === undefined && byteLength !== undefined)) {
    artifacts.set(key, { sha256, mediaType, byteLength });
  }

  return undefined;
};

const readDomain = (filename: string) =>
  withSql(
    filename,
    true,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`PRAGMA foreign_keys = ON`;
      const tables = yield* tableNames(sql);

      const projects = yield* countTable(
        tables.has("review_projects"),
        sql`SELECT count(*) AS n FROM review_projects`,
      );

      const records = yield* countTable(
        tables.has("review_records"),
        sql`SELECT count(*) AS n FROM review_records`,
      );

      const commands = yield* countTable(
        tables.has("review_commands"),
        sql`SELECT count(*) AS n FROM review_commands`,
      );

      const events = yield* countTable(
        tables.has("review_events"),
        sql`SELECT count(*) AS n FROM review_events`,
      );

      const artifacts = new Map<string, ArtifactRef>();
      const artifactRecords = new Map<string, Artifact>();

      if (tables.has("review_records")) {
        const artifactRows = yield* Schema.decodeUnknownEffect(PayloadRows)(
          yield* sql`SELECT payload FROM review_records WHERE kind = 'artifact'`,
        ).pipe(Effect.mapError(() => fail("incomplete", "Artifact records could not be read.")));

        for (const row of artifactRows) {
          const parsed = yield* decodePayload(row.payload);

          const artifact = yield* Schema.decodeUnknownEffect(Artifact)(parsed).pipe(
            Effect.mapError(() =>
              fail("incomplete", "An artifact record does not match the current schema."),
            ),
          );

          artifactRecords.set(artifact.id, artifact);

          const disagreement = addArtifact(
            artifacts,
            artifact.sha256,
            artifact.mediaType,
            artifact.byteLength,
          );

          if (disagreement !== undefined) return yield* disagreement;
        }

        const revisionRows = yield* Schema.decodeUnknownEffect(PayloadRows)(
          yield* sql`SELECT payload FROM review_records WHERE kind = 'revision'`,
        ).pipe(Effect.mapError(() => fail("incomplete", "Revision records could not be read.")));

        for (const row of revisionRows) {
          const parsed = yield* decodePayload(row.payload);

          const revision = yield* Schema.decodeUnknownEffect(Revision)(parsed).pipe(
            Effect.mapError(() =>
              fail("incomplete", "A revision record does not match the current schema."),
            ),
          );

          const pdf = artifacts.get(artifactName(revision.sha256, "application/pdf"));

          const disagreement = addArtifact(
            artifacts,
            revision.sha256,
            "application/pdf",
            pdf?.byteLength,
          );

          if (disagreement !== undefined) return yield* disagreement;
        }
      }

      const runs: Array<RunRef> = [];
      let runRows = 0;

      if (tables.has("review_execution_runs")) {
        const columns = yield* Schema.decodeUnknownEffect(Names)(
          yield* sql`PRAGMA table_info(review_execution_runs)`,
        ).pipe(Effect.mapError(() => fail("incompatible", "Execution columns could not be read.")));

        if (
          ![runColumns, promptRunColumns, timedRunColumns].some((known) =>
            sameColumns(
              columns.map((column) => column.name),
              known,
            ),
          )
        ) {
          return yield* fail(
            "incompatible",
            "Execution columns do not match a supported migration, so run state was not changed.",
          );
        }

        const attemptInfo = tables.has("review_execution_attempts")
          ? yield* Schema.decodeUnknownEffect(Names)(
              yield* sql`PRAGMA table_info(review_execution_attempts)`,
            )
          : [];

        const eventInfo = tables.has("review_execution_events")
          ? yield* Schema.decodeUnknownEffect(Names)(
              yield* sql`PRAGMA table_info(review_execution_events)`,
            )
          : [];

        if (
          !sameColumns(
            attemptInfo.map((column) => column.name),
            attemptColumns,
          ) ||
          !sameColumns(
            eventInfo.map((column) => column.name),
            eventColumns,
          )
        ) {
          return yield* fail(
            "incompatible",
            "Execution tables are not the known migration 0003 shape, so run state was not changed.",
          );
        }

        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(
          yield* sql`SELECT * FROM review_execution_runs`,
        ).pipe(
          Effect.mapError(() =>
            fail(
              "incompatible",
              "Execution rows do not match the known run schema, so they were not changed.",
            ),
          ),
        );

        const counts = yield* Schema.decodeUnknownEffect(AttemptCounts)(
          yield* sql`SELECT run_id, count(*) AS n FROM review_execution_attempts WHERE status = 'uncertain' GROUP BY run_id`,
        ).pipe(Effect.mapError(() => fail("corrupt", "Uncertain attempts could not be counted.")));

        const samCounts = tables.has("review_sam_attempts")
          ? yield* Schema.decodeUnknownEffect(AttemptCounts)(
              yield* sql`SELECT run_id,count(*) AS n FROM review_sam_attempts WHERE status='uncertain' GROUP BY run_id`,
            )
          : [];

        const uncertain = new Map(counts.map((row) => [row.run_id, row.n]));

        for (const row of samCounts)
          uncertain.set(row.run_id, (uncertain.get(row.run_id) ?? 0) + row.n);

        runRows = decoded.length;

        for (const run of decoded) {
          runs.push({
            kind: "count",
            runId: run.run_id,
            projectId: run.project_id,
            journalId: run.journal_id.toLowerCase(),
            state: run.state,
            ownerGeneration: run.owner_generation.toLowerCase(),
            version: run.version,
            uncertainAttempts: uncertain.get(run.run_id) ?? 0,
            engine: run.engine,
          });
        }
      }

      if (
        !tables.has("packet_reviews") &&
        (tables.has("packet_review_attempts") || tables.has("packet_review_tools"))
      )
        return yield* fail("incompatible", "Packet review tables are incomplete.");

      if (tables.has("packet_reviews")) {
        const columns = yield* Schema.decodeUnknownEffect(Names)(
          yield* sql`PRAGMA table_info(packet_reviews)`,
        );

        const attempts = tables.has("packet_review_attempts")
          ? yield* Schema.decodeUnknownEffect(Names)(
              yield* sql`PRAGMA table_info(packet_review_attempts)`,
            )
          : [];

        const tools = tables.has("packet_review_tools")
          ? yield* Schema.decodeUnknownEffect(Names)(
              yield* sql`PRAGMA table_info(packet_review_tools)`,
            )
          : [];

        if (
          !sameColumns(
            columns.map((column) => column.name),
            packetColumns,
          ) ||
          !sameColumns(
            attempts.map((column) => column.name),
            packetAttemptColumns,
          ) ||
          !sameColumns(
            tools.map((column) => column.name),
            packetToolColumns,
          )
        )
          return yield* fail(
            "incompatible",
            "Packet review tables do not match a supported migration.",
          );

        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(PacketRow))(
          yield* sql`SELECT * FROM packet_reviews`,
        ).pipe(
          Effect.mapError(() =>
            fail(
              "incompatible",
              "Packet review rows could not be read without losing their saved report data.",
            ),
          ),
        );

        const counts = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ review_id: Schema.String, n: Schema.Int })),
        )(
          yield* sql`SELECT review_id,count(*) AS n FROM packet_review_attempts WHERE status='uncertain' GROUP BY review_id`,
        );

        const uncertain = new Map(counts.map((row) => [row.review_id, row.n]));
        runRows += decoded.length;

        for (const row of decoded) {
          const review = row.payload;

          if (
            review.id !== row.id ||
            review.projectId !== row.project_id ||
            review.conversationId !== row.conversation_id
          )
            return yield* fail(
              "corrupt",
              "A packet review payload does not match its stored identity.",
            );

          for (const sheet of review.sheets) {
            if (!artifacts.has(artifactName(sheet.sha256, "application/pdf")))
              return yield* fail(
                "incomplete",
                "A packet review references a missing original drawing.",
              );
          }

          const evidenceIds = new Set([
            ...review.evidenceIds,
            ...review.findings.flatMap((finding) => finding.evidenceIds),
            ...review.priorComments.flatMap((comment) => comment.evidenceIds),
          ]);

          for (const evidenceId of evidenceIds) {
            const artifact = artifactRecords.get(evidenceId);

            if (artifact === undefined || artifact.projectId !== row.project_id)
              return yield* fail(
                "incomplete",
                "A packet review references missing or foreign source evidence.",
              );
          }

          runs.push({
            kind: "packet",
            runId: row.id,
            projectId: row.project_id,
            journalId: row.journal_id.toLowerCase(),
            state: review.state,
            ownerGeneration: row.owner_generation.toLowerCase(),
            version: review.version,
            uncertainAttempts: uncertain.get(row.id) ?? 0,
            engine: row.engine,
          });
        }
      }

      if (
        new Set(runs.map((run) => run.runId.toLowerCase())).size !== runs.length ||
        new Set(runs.map((run) => run.journalId)).size !== runs.length
      )
        return yield* fail(
          "incomplete",
          "Review runs do not have distinct run and journal identities.",
        );

      const snapshot: DomainSnapshot = {
        reviewBearing: projects + records + commands + events + runRows > 0,
        artifacts: [...artifacts.values()],
        runs,
      };

      return snapshot;
    }),
    "The application database could not be read.",
  );

const nextState = (state: ExecutionState, uncertainAttempts: number): ExecutionState => {
  if (uncertainAttempts > 0 && state !== "cancelled" && state !== "uncertain") return "uncertain";

  if (state === "running" || state === "pausing") return "paused";

  return state;
};

const blocksResume = (state: ExecutionState, uncertainAttempts: number) =>
  uncertainAttempts > 0 ||
  state === "running" ||
  state === "pausing" ||
  state === "paused" ||
  state === "uncertain";

const reasonFor = (
  state: ExecutionState,
  uncertainAttempts: number,
  foreign: boolean,
): RestoredRun["reason"] => {
  if (uncertainAttempts > 0) return "uncertain-attempt";

  if (blocksResume(state, uncertainAttempts) && foreign) return "foreign-owner";

  if (blocksResume(state, uncertainAttempts)) return "restored-historical";

  return "terminal";
};

const admissionFrom = (runs: ReadonlyArray<RunRef>, ownerGeneration: string | undefined) => {
  const restored = runs.map((run) => {
    const state = nextState(run.state, run.uncertainAttempts);
    const foreign = ownerGeneration === undefined || ownerGeneration !== run.ownerGeneration;
    const resumeBlocked = blocksResume(state, run.uncertainAttempts);

    return new RestoredRun({
      runId: run.runId,
      journalId: run.journalId,
      previousState: run.state,
      state,
      ownerGeneration: run.ownerGeneration,
      uncertainAttempts: run.uncertainAttempts,
      resumeBlocked,
      reason: reasonFor(state, run.uncertainAttempts, foreign),
    });
  });

  const admitWork = restored.every((run) => !run.resumeBlocked);

  return new PackageAdmission({
    admitWork,
    parentAction: admitWork ? allowNewWork : blockAdmission,
    runs: restored,
  });
};

const markHistorical = (filename: string) =>
  Effect.gen(function* () {
    const before = yield* readDomain(filename);

    const changes = before.runs.some(
      (run) =>
        nextState(run.state, run.uncertainAttempts) !== run.state ||
        run.engine !== `restored-history:${packageEngineFormat}`,
    );

    if (!changes) return before;

    yield* withSql(
      filename,
      false,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`PRAGMA synchronous = FULL`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const transaction = yield* SqlClient.SqlClient;

            for (const run of before.runs) {
              const state = nextState(run.state, run.uncertainAttempts);

              if (state === run.state && run.engine === `restored-history:${packageEngineFormat}`)
                continue;

              if (run.kind === "packet") {
                const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PacketRow))(
                  yield* transaction`SELECT * FROM packet_reviews WHERE id=${run.runId}`,
                );

                const previous = rows[0];

                if (previous === undefined || previous.payload.version !== run.version)
                  return yield* fail(
                    "conflict",
                    "A restored packet review changed before it could be marked historical.",
                  );

                const payload = yield* Schema.decodeUnknownEffect(PacketReview)({
                  ...Schema.encodeSync(PacketReview)(previous.payload),
                  state,
                  version: previous.payload.version + 1,
                }).pipe(
                  Effect.mapError(() =>
                    fail("conflict", "A packet review has an unsupported restored state."),
                  ),
                );

                yield* transaction`UPDATE packet_reviews SET payload=${JSON.stringify(payload)}, engine=${`restored-history:${packageEngineFormat}`} WHERE id=${run.runId} AND json_extract(payload,'$.version')=${run.version}`;

                const updated = yield* Schema.decodeUnknownEffect(Schema.Array(PacketRow))(
                  yield* transaction`SELECT * FROM packet_reviews WHERE id=${run.runId}`,
                );

                const current = updated[0];

                if (
                  current === undefined ||
                  current.payload.state !== state ||
                  current.payload.version !== payload.version ||
                  current.engine !== `restored-history:${packageEngineFormat}`
                )
                  return yield* fail(
                    "conflict",
                    "A restored packet review could not be marked non-executing.",
                  );
                continue;
              }

              yield* transaction`UPDATE review_execution_runs SET state = ${state}, engine = ${`restored-history:${packageEngineFormat}`}, version = version + 1 WHERE run_id = ${run.runId} AND version = ${run.version}`;

              const updated = yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(
                yield* transaction`SELECT * FROM review_execution_runs WHERE run_id = ${run.runId}`,
              ).pipe(
                Effect.mapError(() => fail("conflict", "A restored run could not be reread.")),
              );

              const row = updated[0];

              if (row === undefined || row.state !== state) {
                return yield* fail(
                  "conflict",
                  "A restored run changed before it could be marked non-executing.",
                );
              }

              yield* transaction`INSERT INTO review_execution_events (run_id, project_id, state, version) VALUES (${row.run_id}, ${row.project_id}, ${row.state}, ${row.version})`;
            }
          }),
        );
      }),
      "Restored runs could not be marked non-executing. Current data was left in place.",
    );

    return before;
  });

const parseLimits = (limits: PackagesConfig["limits"]) =>
  Schema.decodeUnknownEffect(PackageLimits)(limits ?? defaultPackageLimits).pipe(
    Effect.mapError(() => fail("input", "Package file limits are not valid.")),
  );

const parseOwner = (ownerGeneration: string | undefined) =>
  Effect.gen(function* () {
    if (ownerGeneration === undefined) return undefined;

    return yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
      ownerGeneration,
    ).pipe(
      Effect.map((value) => value.toLowerCase()),
      Effect.mapError(() => fail("input", "The owner generation is not a UUID.")),
    );
  });

const assertEngine = Effect.gen(function* () {
  if (journalFormat !== packageEngineFormat) {
    return yield* fail(
      "incompatible",
      "The journal engine format does not match this package writer.",
    );
  }
});

const journalFile = (dataDirectory: string) =>
  join(dataDirectory, ".package-restore", "journal.json");

const readJournal = (dataDirectory: string) =>
  Effect.gen(function* () {
    const path = journalFile(dataDirectory);

    const text = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, "utf8");
        } catch (cause) {
          if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)) return null;
          throw cause;
        }
      },
      catch: () =>
        fail("corrupt", "The restore journal could not be read. Live files were not changed."),
    });

    if (text === null) return null;

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () =>
        fail("corrupt", "The restore journal is not valid JSON. Live files were not changed."),
    });

    return yield* Schema.decodeUnknownEffect(RestoreJournal)(parsed).pipe(
      Effect.mapError(() =>
        fail("corrupt", "The restore journal is not valid. Live files were not changed."),
      ),
    );
  });

const writeJournal = (dataDirectory: string, journal: RestoreJournal) =>
  Effect.gen(function* () {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(Schema.encodeSync(RestoreJournal)(journal)),
      catch: () => fail("unavailable", "The restore journal could not be encoded."),
    });

    yield* writeBytes(journalFile(dataDirectory), encoded);
    yield* fsyncDirectory(join(dataDirectory, ".package-restore"));
  });

const assertNoJournal = (dataDirectory: string) =>
  Effect.gen(function* () {
    const journal = yield* readJournal(dataDirectory);

    if (journal !== null) {
      return yield* fail(
        "interrupted",
        "A previous restore did not finish. Recover it before opening databases or starting another restore.",
      );
    }
  });

const dataRealPath = (dataDirectory: string) =>
  Effect.tryPromise({
    try: () => realpath(dataDirectory),
    catch: () => fail("unavailable", "The data directory could not be opened."),
  });

const prepareExternalDestination = (destination: string, dataDirectory: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!existsSync(dirname(destination))) {
        throw fail("input", "The destination parent directory does not exist.");
      }

      const parent = await realpath(dirname(destination));
      const data = await realpath(dataDirectory);
      const target = join(parent, basename(destination));

      if (existsSync(target)) {
        throw fail("conflict", "The destination already exists and was not changed.");
      }

      if (target === data || withinRoot(data, target) || withinRoot(target, data)) {
        throw fail("input", "Choose a package directory outside the application data directory.");
      }

      return target;
    },
    catch: (cause) => asPackageError(cause, "The package destination could not be prepared."),
  });

const referencedFile = (
  dataDirectory: string,
  relativePath: string,
  expectedBytes: number | undefined,
  maxBytes: number,
) =>
  Effect.gen(function* () {
    const path = safeJoin(dataDirectory, relativePath);

    if (path === undefined)
      return yield* fail("corrupt", "A referenced path escapes the data directory.");

    const info = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: () => fail("incomplete", "A referenced artifact or journal is missing."),
    });

    if (info.isSymbolicLink() || !info.isFile()) {
      return yield* fail("corrupt", "A referenced file is a symbolic link or not a regular file.");
    }

    const identity = yield* hashFile(path, maxBytes);

    if (expectedBytes !== undefined && identity.bytes !== expectedBytes) {
      return yield* fail("incomplete", "A referenced artifact does not match its recorded size.");
    }

    return { path, ...identity };
  });

const writeApplicationPackage = (
  config: PackagesConfig,
  destination: string,
  limits: typeof PackageLimits.Type,
  placement: Placement,
) =>
  Effect.gen(function* () {
    const dataDirectory = yield* dataRealPath(config.dataDirectory);

    const target =
      placement === "external"
        ? yield* prepareExternalDestination(destination, dataDirectory)
        : destination;

    const staging = join(dirname(target), `.${basename(target)}.partial-${randomUUID()}`);
    const snapshot = yield* readDomain(join(dataDirectory, "app.sqlite"));
    const installed = yield* migrationIdentities(config.migrationDirectory);
    const inspected = yield* inspectDatabase(join(dataDirectory, "app.sqlite"));

    if (!historyMatches(inspected.migrations, installed)) {
      return yield* fail("incompatible", "Applied migrations do not match this build.");
    }

    let fileCount = 0;
    let totalBytes = 0;

    const reserve = (bytes: number) =>
      Effect.gen(function* () {
        totalBytes += bytes;

        if (fileCount + 1 > limits.maxFiles || totalBytes > limits.maxBytes) {
          return yield* fail("limit", "The package exceeds the file or byte limit.");
        }
      });

    return yield* Effect.acquireUseRelease(
      makeDirectory(staging, "The package staging directory could not be created."),
      () =>
        Effect.gen(function* () {
          const databaseDestination = join(staging, "app.sqlite");

          yield* backupSqlite(join(dataDirectory, "app.sqlite"), databaseDestination);
          const databaseIdentity = yield* hashFile(databaseDestination, limits.maxBytes);

          yield* reserve(databaseIdentity.bytes);
          fileCount += 1;

          const artifacts: Array<PackageFile> = [];

          for (const artifact of snapshot.artifacts) {
            const relativePath = artifactName(artifact.sha256, artifact.mediaType);

            const stored = yield* referencedFile(
              dataDirectory,
              relativePath,
              artifact.byteLength,
              limits.maxBytes,
            );

            if (stored.sha256 !== artifact.sha256) {
              return yield* fail(
                "incomplete",
                "A referenced artifact hash does not match its file.",
              );
            }

            yield* reserve(stored.bytes);
            yield* copyRegularFile(stored.path, join(staging, relativePath), limits.maxBytes);
            artifacts.push(
              new PackageFile({ path: relativePath, sha256: stored.sha256, bytes: stored.bytes }),
            );
            fileCount += 1;
          }

          const journals: Array<PackageJournalFile> = [];
          const runs: Array<PackageRunSnapshot> = [];

          for (const run of snapshot.runs) {
            if (
              run.engine !== packageEngineFormat &&
              run.engine !== `restored-history:${packageEngineFormat}`
            ) {
              return yield* fail(
                "incompatible",
                "A run journal uses an engine this package writer cannot close.",
              );
            }

            const livePath = liveJournalName(run.journalId);

            const stored = yield* referencedFile(
              dataDirectory,
              livePath,
              undefined,
              limits.maxBytes,
            );

            const identity = yield* journalIdentity(stored.path);

            if (identity.journal_id.toLowerCase() !== run.journalId) {
              return yield* fail(
                "incomplete",
                "A Pi journal does not match the run that references it.",
              );
            }

            const packagePath = packageJournalName(run.journalId);

            yield* reserve(stored.bytes);
            yield* backupSqlite(stored.path, join(staging, packagePath));
            const copied = yield* hashFile(join(staging, packagePath), limits.maxBytes);

            journals.push(
              new PackageJournalFile({
                path: packagePath,
                sha256: copied.sha256,
                bytes: copied.bytes,
                journalId: run.journalId,
                format: packageEngineFormat,
              }),
            );
            fileCount += 1;
            runs.push(
              new PackageRunSnapshot({
                runId: run.runId,
                journalId: run.journalId,
                state: run.state,
                ownerGeneration: run.ownerGeneration,
                uncertainAttempts: run.uncertainAttempts,
              }),
            );
          }

          yield* reserve(0);
          const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();

          const manifest = new PackageManifest({
            format: "moke-review-package",
            formatVersion: packageFormatVersion,
            scope: "application",
            scopeLabel: "whole-application",
            createdAt,
            hash: "sha256",
            engine: packageEngineFormat,
            migrations: inspected.migrations.map((migration) => ({
              name: migration.name,
              sha256: migration.sha256,
            })),
            database: new PackageFile({
              path: "app.sqlite",
              sha256: databaseIdentity.sha256,
              bytes: databaseIdentity.bytes,
            }),
            artifacts,
            journals,
            runs,
          });

          const encoded = yield* Effect.try({
            try: () => JSON.stringify(Schema.encodeSync(PackageManifest)(manifest)),
            catch: () => fail("unavailable", "The package manifest could not be encoded."),
          });

          yield* fsyncDirectory(staging);
          yield* writeBytes(join(staging, "manifest.json"), encoded);
          const manifestIdentity = yield* hashFile(join(staging, "manifest.json"), limits.maxBytes);

          totalBytes += manifestIdentity.bytes;

          if (fileCount + 1 > limits.maxFiles || totalBytes > limits.maxBytes) {
            return yield* fail("limit", "The package exceeds the file or byte limit.");
          }

          yield* fsyncDirectory(staging);
          yield* io(() => rename(staging, target), "The package directory could not be published.");
          yield* fsyncDirectory(dirname(target));

          return new PackageExportResult({
            destination: target,
            scope: "application",
            scopeLabel: "whole-application",
            files: fileCount + 1,
            bytes: totalBytes,
          });
        }),
      () => removeTree(staging).pipe(Effect.ignore),
    );
  });

const listPackage = (root: string, limits: typeof PackageLimits.Type) =>
  Effect.tryPromise({
    try: async () => {
      const found: Array<{ relativePath: string; bytes: number }> = [];

      const visit = async (directory: string) => {
        const names = await readdir(directory);

        for (const name of names) {
          const path = join(directory, name);
          const info = await lstat(path);

          if (info.isSymbolicLink()) {
            throw fail("corrupt", "The package contains a symbolic link.");
          }

          if (info.isDirectory()) {
            const rel = portablePackagePath(relative(root, path));

            if (rel !== "artifacts" && rel !== "journals") {
              throw fail("corrupt", "The package contains an unexpected directory.");
            }

            await visit(path);
            continue;
          }

          if (!info.isFile()) throw fail("corrupt", "The package contains a non-regular file.");

          found.push({ relativePath: portablePackagePath(relative(root, path)), bytes: info.size });

          if (found.length > limits.maxFiles)
            throw fail("limit", "The package exceeds the file limit.");
        }
      };

      await visit(root);
      let total = 0;

      for (const file of found) {
        total += file.bytes;

        if (total > limits.maxBytes) throw fail("limit", "The package exceeds the byte limit.");
      }

      return found;
    },
    catch: (cause) => asPackageError(cause, "The package directory could not be listed."),
  });

const labelsMatch = (manifest: PackageManifest) =>
  (manifest.scope === "application" && manifest.scopeLabel === "whole-application") ||
  (manifest.scope === "database-only" && manifest.scopeLabel === "database-only");

const readManifest = (packageDirectory: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(packageDirectory, "manifest.json"), "utf8"),
      catch: () => fail("incomplete", "The package manifest is missing."),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => fail("corrupt", "The package manifest is not valid JSON."),
    });

    return yield* Schema.decodeUnknownEffect(PackageManifest)(parsed).pipe(
      Effect.mapError(() =>
        fail("corrupt", "The package manifest does not match the supported format."),
      ),
    );
  });

const validatePackage = (
  packageDirectory: string,
  limits: typeof PackageLimits.Type,
  migrationDirectory: string,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(packageDirectory),
      catch: () => fail("input", "The package directory could not be opened."),
    });

    const info = yield* Effect.tryPromise({
      try: () => lstat(root),
      catch: () => fail("input", "The package directory could not be opened."),
    });

    if (info.isSymbolicLink() || !info.isDirectory()) {
      return yield* fail("input", "The package path is not a directory.");
    }

    const listed = yield* listPackage(root, limits);
    const manifest = yield* readManifest(root);

    if (!labelsMatch(manifest) || manifest.database.path !== "app.sqlite") {
      return yield* fail("corrupt", "The package scope or database path is not valid.");
    }

    if (manifest.scope === "database-only") {
      return yield* fail(
        "incomplete",
        "This database-only package omits journals and artifacts. Review-bearing data cannot be restored from it.",
      );
    }

    const expected = new Map<string, { sha256: string; bytes: number }>();

    expected.set(manifest.database.path, {
      sha256: manifest.database.sha256,
      bytes: manifest.database.bytes,
    });

    for (const artifact of manifest.artifacts) {
      const extension = artifact.path.endsWith(".pdf")
        ? "pdf"
        : artifact.path.endsWith(".png")
          ? "png"
          : undefined;

      if (
        extension === undefined ||
        artifact.path !== `artifacts/${artifact.sha256}.${extension}`
      ) {
        return yield* fail("corrupt", "An artifact path is outside the package layout.");
      }

      expected.set(artifact.path, { sha256: artifact.sha256, bytes: artifact.bytes });
    }

    for (const journal of manifest.journals) {
      const journalId = journal.journalId.toLowerCase();

      if (
        journal.path !== packageJournalName(journalId) ||
        journal.format !== packageEngineFormat
      ) {
        return yield* fail("corrupt", "A journal path is outside the package layout.");
      }

      expected.set(journal.path, { sha256: journal.sha256, bytes: journal.bytes });
    }

    const present = new Set(listed.map((file) => file.relativePath));

    if (!present.has("manifest.json")) {
      return yield* fail("incomplete", "The package manifest is missing.");
    }

    for (const file of listed) {
      if (file.relativePath === "manifest.json") continue;

      if (!expected.has(file.relativePath)) {
        return yield* fail(
          "corrupt",
          "The package contains a file that is not listed in the manifest.",
        );
      }
    }

    for (const [relativePath, file] of expected) {
      if (!present.has(relativePath)) {
        return yield* fail("incomplete", "The package manifest lists a file that is missing.");
      }

      const path = safeJoin(root, relativePath);

      if (path === undefined)
        return yield* fail("corrupt", "A manifest path escapes the package directory.");

      const identity = yield* hashFile(path, limits.maxBytes);

      if (identity.sha256 !== file.sha256 || identity.bytes !== file.bytes) {
        return yield* fail("corrupt", "A package file hash or size does not match the manifest.");
      }
    }

    const databasePath = join(root, "app.sqlite");
    const inspected = yield* inspectDatabase(databasePath);
    const installed = yield* migrationIdentities(migrationDirectory);

    if (
      !sameHistory(manifest.migrations, inspected.migrations) ||
      !historyMatches(inspected.migrations, installed)
    ) {
      return yield* fail(
        "incompatible",
        "The package migrations are not compatible with this build.",
      );
    }

    const snapshot = yield* readDomain(databasePath);
    const manifestRuns = new Map(manifest.runs.map((run) => [run.runId.toLowerCase(), run]));

    if (manifestRuns.size !== manifest.runs.length || manifestRuns.size !== snapshot.runs.length) {
      return yield* fail(
        "incomplete",
        "The manifest run list does not match the package database.",
      );
    }

    for (const run of snapshot.runs) {
      const recorded = manifestRuns.get(run.runId.toLowerCase());

      if (
        recorded === undefined ||
        recorded.journalId.toLowerCase() !== run.journalId ||
        recorded.state !== run.state ||
        recorded.ownerGeneration.toLowerCase() !== run.ownerGeneration ||
        recorded.uncertainAttempts !== run.uncertainAttempts
      ) {
        return yield* fail("incomplete", "The manifest runs do not match the package database.");
      }

      const journal = manifest.journals.find(
        (item) => item.journalId.toLowerCase() === run.journalId,
      );

      if (journal === undefined) {
        return yield* fail(
          "incomplete",
          "The package omits a Pi journal required by a review run.",
        );
      }

      const identity = yield* journalIdentity(join(root, journal.path));

      if (identity.journal_id.toLowerCase() !== run.journalId) {
        return yield* fail("incomplete", "A packaged Pi journal does not match its run.");
      }
    }

    const packagedArtifacts = new Set(manifest.artifacts.map((artifact) => artifact.path));

    for (const artifact of snapshot.artifacts) {
      const relativePath = artifactName(artifact.sha256, artifact.mediaType);

      if (!packagedArtifacts.has(relativePath)) {
        return yield* fail("incomplete", "The package omits a referenced original or render.");
      }
    }

    return { root, manifest, snapshot };
  });

const fileExists = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const info = await lstat(path);

        if (info.isSymbolicLink()) throw fail("corrupt", "A live path is a symbolic link.");

        return info.isFile();
      } catch (cause) {
        if (Schema.is(PackageError)(cause)) throw cause;

        if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)) return false;

        throw cause;
      }
    },
    catch: (cause) => asPackageError(cause, "A live path could not be inspected."),
  });

const placeOf = (
  entry: SwapEntry,
  dataDirectory: string,
): "untouched" | "aside" | "replaced" | "corrupt" => {
  const live = safeJoin(dataDirectory, entry.relativePath);

  const saved = safeJoin(
    dataDirectory,
    posix.join(".package-restore", "saved", entry.relativePath),
  );

  const incoming = safeJoin(
    dataDirectory,
    posix.join(".package-restore", "incoming", entry.relativePath),
  );

  if (live === undefined || saved === undefined || incoming === undefined) return "corrupt";

  const liveExists = existsSync(live);
  const savedExists = existsSync(saved);
  const incomingExists = existsSync(incoming);

  if (entry.status === "pending" || entry.status === "reverted") return "untouched";

  if (entry.status === "moving-aside" && entry.hadOriginal && liveExists && !savedExists)
    return "untouched";

  if (!liveExists && !incomingExists && entry.hadOriginal && savedExists) return "aside";

  if (!liveExists && !incomingExists && !entry.hadOriginal && !savedExists) return "untouched";

  if (!entry.hadOriginal) {
    if (!liveExists && incomingExists) return "aside";

    if (liveExists && !incomingExists) return "replaced";

    return "corrupt";
  }

  if (!liveExists && savedExists && incomingExists) return "aside";

  if (liveExists && savedExists && !incomingExists) return "replaced";

  return "corrupt";
};

const rollbackEntry = (dataDirectory: string, entry: SwapEntry) =>
  Effect.gen(function* () {
    const live = safeJoin(dataDirectory, entry.relativePath);

    const saved = safeJoin(
      dataDirectory,
      posix.join(".package-restore", "saved", entry.relativePath),
    );

    if (
      live !== undefined &&
      saved !== undefined &&
      entry.status === "reverting" &&
      entry.hadOriginal &&
      !existsSync(saved) &&
      existsSync(live)
    ) {
      const identity = yield* hashFile(live, 8_589_934_592);

      if (
        entry.originalIdentity === undefined ||
        identity.sha256 !== entry.originalIdentity.sha256 ||
        identity.bytes !== entry.originalIdentity.bytes
      )
        return yield* fail(
          "corrupt",
          "The recovered original does not match the rollback journal identity.",
        );

      yield* fsyncDirectory(dirname(saved));
      yield* fsyncDirectory(dirname(live));

      return { ...entry, status: "reverted" as const };
    }

    const place = placeOf(entry, dataDirectory);

    if (live === undefined || saved === undefined || place === "corrupt") {
      return yield* fail("corrupt", "The restore journal no longer matches the files on disk.");
    }

    if (place === "untouched") return { ...entry, status: "reverted" as const };

    if (place === "replaced") {
      const discarded = safeJoin(
        dataDirectory,
        posix.join(
          ".package-restore",
          "discarded",
          `${randomUUID()}-${basename(entry.relativePath)}`,
        ),
      );

      if (discarded === undefined)
        return yield* fail("corrupt", "A discarded restore path escaped the data directory.");

      yield* makeDirectory(
        dirname(discarded),
        "The restore discard directory could not be created.",
      );
      yield* io(
        () => rename(live, discarded),
        "A replaced file could not be moved aside during rollback.",
      );
    }

    if (entry.hadOriginal) {
      yield* makeDirectory(dirname(live), "A restored directory could not be created.");
      yield* io(() => rename(saved, live), "An original file could not be restored.");
      yield* fsyncDirectory(dirname(saved));
      yield* fsyncDirectory(dirname(live));
    }

    return { ...entry, status: "reverted" as const };
  });

const absoluteRetained = (dataDirectory: string, relativePath: string | null) => {
  if (relativePath === null) return null;

  if (!retainedRelativeAllowed(relativePath)) return undefined;

  return safeJoin(dataDirectory, relativePath);
};

const recoverJournal = (dataDirectory: string, journal: RestoreJournal) =>
  Effect.gen(function* () {
    const retained = absoluteRetained(dataDirectory, journal.preRestoreRelative);

    if (retained === undefined) {
      return yield* fail("corrupt", "The pre-restore package path escapes the data directory.");
    }

    if (journal.phase === "prepared") {
      yield* removeTree(join(dataDirectory, ".package-restore", "incoming"));
      yield* removeTree(journalFile(dataDirectory));

      return new PackageRecovery({ status: "rolled-back", preRestorePackagePath: retained });
    }

    if (journal.phase === "complete") {
      if (retained !== null && !existsSync(join(retained, "manifest.json"))) {
        return yield* fail(
          "unavailable",
          "The pre-restore package is missing. Saved files were left in place.",
        );
      }

      if (journal.entries.some((entry) => entry.hadOriginal) && retained === null) {
        return yield* fail(
          "unavailable",
          "Original files were saved without a pre-restore package.",
        );
      }

      yield* removeTree(join(dataDirectory, ".package-restore", "incoming"));
      yield* removeTree(join(dataDirectory, ".package-restore", "saved"));
      yield* removeTree(journalFile(dataDirectory));

      return new PackageRecovery({ status: "completed", preRestorePackagePath: retained });
    }

    const entries = [...journal.entries];

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry === undefined || !liveRelativeAllowed(entry.relativePath)) {
        return yield* fail(
          "corrupt",
          "The restore journal names a path outside the replacement set.",
        );
      }

      let reverting = entry;

      if (entry.status !== "reverting" && placeOf(entry, dataDirectory) !== "untouched") {
        if (entry.hadOriginal) {
          const saved = safeJoin(
            dataDirectory,
            posix.join(".package-restore", "saved", entry.relativePath),
          );

          if (saved === undefined)
            return yield* fail("corrupt", "An original rollback path escapes the data directory.");
          const originalIdentity = yield* hashFile(saved, 8_589_934_592);
          reverting = { ...entry, status: "reverting", originalIdentity };
        } else reverting = { ...entry, status: "reverting" };
        entries[index] = reverting;
        yield* writeJournal(dataDirectory, { ...journal, entries });
      }

      const reverted = yield* rollbackEntry(dataDirectory, reverting);

      entries[index] = reverted;
      yield* writeJournal(dataDirectory, { ...journal, entries });
    }

    yield* removeTree(join(dataDirectory, ".package-restore", "incoming"));
    yield* removeTree(journalFile(dataDirectory));

    return new PackageRecovery({ status: "rolled-back", preRestorePackagePath: retained });
  });

const swapEntry = (dataDirectory: string, journal: RestoreJournal, index: number) =>
  Effect.gen(function* () {
    const current = journal.entries[index];

    if (current === undefined || !liveRelativeAllowed(current.relativePath)) {
      return yield* fail("corrupt", "A replacement path is outside the allowed set.");
    }

    const live = safeJoin(dataDirectory, current.relativePath);

    const saved = safeJoin(
      dataDirectory,
      posix.join(".package-restore", "saved", current.relativePath),
    );

    const incoming = safeJoin(
      dataDirectory,
      posix.join(".package-restore", "incoming", current.relativePath),
    );

    if (live === undefined || saved === undefined || incoming === undefined) {
      return yield* fail("corrupt", "A replacement path escapes the data directory.");
    }

    const existed = yield* fileExists(live);

    let next: RestoreJournal = {
      ...journal,
      entries: journal.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, hadOriginal: existed, status: "moving-aside" } : entry,
      ),
    };

    yield* writeJournal(dataDirectory, next);

    if (existed) {
      yield* makeDirectory(dirname(saved), "The restore save directory could not be created.");
      yield* io(() => rename(live, saved), "A live file could not be moved aside.");
    }

    next = {
      ...next,
      entries: next.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, status: "moved-aside" } : entry,
      ),
    };
    yield* writeJournal(dataDirectory, next);
    next = {
      ...next,
      entries: next.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, status: "moving-in" } : entry,
      ),
    };
    yield* writeJournal(dataDirectory, next);
    yield* makeDirectory(dirname(live), "A restored directory could not be created.");
    yield* io(() => rename(incoming, live), "A package file could not be moved into place.");
    next = {
      ...next,
      entries: next.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, status: "replaced" } : entry,
      ),
    };
    yield* writeJournal(dataDirectory, next);

    return next;
  });

const conflictingArtifact = (dataDirectory: string, snapshot: DomainSnapshot, maxBytes: number) =>
  Effect.gen(function* () {
    for (const artifact of snapshot.artifacts) {
      const relativePath = artifactName(artifact.sha256, artifact.mediaType);
      const path = safeJoin(dataDirectory, relativePath);

      if (path === undefined)
        return yield* fail("corrupt", "An artifact path escapes the data directory.");

      if (!existsSync(path)) continue;

      const identity = yield* hashFile(path, maxBytes);

      if (identity.sha256 !== artifact.sha256) {
        return yield* fail(
          "corrupt",
          "A live artifact name does not match its bytes. Current data was left in place.",
        );
      }
    }
  });

const buildIncoming = (
  dataDirectory: string,
  packageRoot: string,
  manifest: PackageManifest,
  limits: typeof PackageLimits.Type,
) =>
  Effect.gen(function* () {
    const incoming = join(dataDirectory, ".package-restore", "incoming");

    yield* removeTree(incoming);
    yield* backupSqlite(join(packageRoot, "app.sqlite"), join(incoming, "app.sqlite"));

    for (const artifact of manifest.artifacts) {
      yield* copyRegularFile(
        join(packageRoot, artifact.path),
        join(incoming, artifact.path),
        limits.maxBytes,
      );
    }

    for (const journal of manifest.journals) {
      yield* backupSqlite(
        join(packageRoot, journal.path),
        join(incoming, liveJournalName(journal.journalId.toLowerCase())),
      );
    }

    return incoming;
  });

const replacementEntries = (dataDirectory: string, manifest: PackageManifest) =>
  Effect.gen(function* () {
    const entries: Array<SwapEntry> = [];

    for (const artifact of manifest.artifacts) {
      const path = safeJoin(dataDirectory, artifact.path);

      if (path === undefined)
        return yield* fail("corrupt", "An artifact path escapes the data directory.");

      if (existsSync(path)) continue;

      entries.push({ relativePath: artifact.path, hadOriginal: false, status: "pending" });
    }

    for (const journal of manifest.journals) {
      entries.push({
        relativePath: liveJournalName(journal.journalId.toLowerCase()),
        hadOriginal: false,
        status: "pending",
      });
    }

    entries.push({ relativePath: "app.sqlite", hadOriginal: false, status: "pending" });

    return entries;
  });

const restorePrepared = (
  config: PackagesConfig,
  source: string,
  limits: typeof PackageLimits.Type,
  ownerGeneration: string | undefined,
) =>
  Effect.gen(function* () {
    const dataDirectory = yield* dataRealPath(config.dataDirectory);

    const sourcePath = yield* Effect.tryPromise({
      try: () => realpath(source),
      catch: () => fail("input", "The package directory could not be opened."),
    });

    if (withinRoot(dataDirectory, sourcePath) || withinRoot(sourcePath, dataDirectory)) {
      return yield* fail(
        "input",
        "Choose a package directory outside the application data directory.",
      );
    }

    yield* assertNoJournal(dataDirectory);
    const validated = yield* validatePackage(sourcePath, limits, config.migrationDirectory);

    yield* conflictingArtifact(dataDirectory, validated.snapshot, limits.maxBytes);
    const entries = yield* replacementEntries(dataDirectory, validated.manifest);

    yield* buildIncoming(dataDirectory, validated.root, validated.manifest, limits);

    const before = yield* markHistorical(
      join(dataDirectory, ".package-restore", "incoming", "app.sqlite"),
    );

    yield* finalizeDelete(join(dataDirectory, ".package-restore", "incoming", "app.sqlite"));
    const admission = admissionFrom(before.runs, ownerGeneration);

    let preRestoreRelative: string | null = null;

    if (existsSync(join(dataDirectory, "app.sqlite"))) {
      const retainedId = randomUUID();

      preRestoreRelative = `.package-restore/retained/${retainedId}`;
      const retained = safeJoin(dataDirectory, preRestoreRelative);

      if (retained === undefined || !retainedRelativeAllowed(preRestoreRelative)) {
        return yield* fail("unavailable", "The pre-restore package path could not be created.");
      }

      yield* makeDirectory(
        join(dataDirectory, ".package-restore", "retained"),
        "The pre-restore directory could not be created.",
      );
      yield* writeApplicationPackage(config, retained, limits, "retained");
    }

    let journal: RestoreJournal = {
      version: 1,
      phase: "prepared",
      preRestoreRelative,
      entries,
    };

    yield* writeJournal(dataDirectory, journal);

    if (config.interruptAfter === "prepared") {
      return yield* fail(
        "interrupted",
        "Restore stopped after staging. Run recovery before opening the data directory.",
      );
    }

    const checkpoint = yield* Effect.exit(
      Effect.gen(function* () {
        if (existsSync(join(dataDirectory, "app.sqlite"))) {
          yield* finalizeDelete(join(dataDirectory, "app.sqlite"));
        }

        for (const journalFileEntry of validated.manifest.journals) {
          const live = join(
            dataDirectory,
            liveJournalName(journalFileEntry.journalId.toLowerCase()),
          );

          if (existsSync(live)) yield* finalizeDelete(live);
        }
      }),
    );

    if (Exit.isFailure(checkpoint)) {
      yield* removeTree(journalFile(dataDirectory)).pipe(Effect.ignore);
      yield* removeTree(join(dataDirectory, ".package-restore", "incoming")).pipe(Effect.ignore);

      return yield* Effect.failCause(checkpoint.cause);
    }

    journal = { ...journal, phase: "swapping" };
    yield* writeJournal(dataDirectory, journal);
    let replaced = 0;

    for (let index = 0; index < journal.entries.length; index += 1) {
      journal = yield* swapEntry(dataDirectory, journal, index);
      replaced += 1;

      if (
        (config.interruptAfter === "first-replaced" && replaced === 1) ||
        (config.interruptAfter === "database-replaced" &&
          journal.entries[index]?.relativePath === "app.sqlite")
      ) {
        return yield* fail(
          "interrupted",
          "Restore stopped after replacement. Run recovery before opening the data directory.",
        );
      }
    }

    journal = { ...journal, phase: "complete" };
    yield* writeJournal(dataDirectory, journal);
    yield* recoverJournal(dataDirectory, journal).pipe(Effect.ignore);
    const retained = absoluteRetained(dataDirectory, preRestoreRelative);

    return new PackageRestoreResult({
      admission,
      preRestorePackagePath: retained ?? null,
    });
  });

/** Export the whole application directory: database, referenced artifacts, and closed Pi journals. */
export const exportReviewPackage = Effect.fn("exportReviewPackage")(function* (
  config: PackagesConfig,
  destination: string,
) {
  const limits = yield* parseLimits(config.limits);

  yield* assertEngine;
  yield* prepareExternalDestination(destination, yield* dataRealPath(config.dataDirectory));
  yield* config.quiesce;

  return yield* writeApplicationPackage(config, destination, limits, "external").pipe(
    Semaphore.withPermit(config.queries),
    Effect.uninterruptible,
  );
});

/**
 * Validate a package, keep a pre-restore package, then replace database, artifacts, and journals.
 * Failure before the replacement journal leaves the current files in place.
 * Failure after that journal requires `recoverInterruptedRestore` before the databases are opened.
 */
export const restoreReviewPackage = Effect.fn("restoreReviewPackage")(function* (
  config: PackagesConfig,
  source: string,
) {
  const limits = yield* parseLimits(config.limits);
  const ownerGeneration = yield* parseOwner(config.ownerGeneration);

  yield* assertEngine;
  yield* config.quiesce;

  return yield* restorePrepared(config, source, limits, ownerGeneration).pipe(
    Semaphore.withPermit(config.queries),
    Effect.uninterruptible,
  );
});

/**
 * Reconcile an interrupted replacement.
 * Call after the process owns the data directory and before opening domain or journal databases.
 * Does not take the SQL semaphore and does not start Pi.
 */
export const recoverInterruptedRestore = Effect.fn("recoverInterruptedRestore")(function* (
  dataDirectory: string,
) {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const canonical = yield* dataRealPath(dataDirectory);
      const journal = yield* readJournal(canonical);

      if (journal === null)
        return new PackageRecovery({ status: "idle", preRestorePackagePath: null });

      return yield* recoverJournal(canonical, journal);
    }),
  );
});

/**
 * Report whether review tables contain rows.
 * Opens a short read-only connection and does not take the SQL semaphore.
 * The parent should call it while already holding that semaphore.
 */
export const hasReviewBearingRows = Effect.fn("hasReviewBearingRows")(function* (filename: string) {
  const snapshot = yield* readDomain(filename);

  return snapshot.reviewBearing;
});
