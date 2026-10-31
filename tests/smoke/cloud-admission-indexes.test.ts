import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countRunsBlockingCloud, packetProjectsBlockingCloud } from "../../backend/application.ts";
import { migrateDatabase } from "../../backend/database-files.ts";

const PlanRow = Schema.Array(Schema.Struct({ detail: Schema.String }));

/** Results and query plans of the two cloud admission queries, read through Effect SQL. */
const inspect = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const plan = (statement: ReturnType<typeof countRunsBlockingCloud>) =>
      Effect.gen(function* () {
        const [text, params] = statement.compile();

        const rows = yield* Schema.decodeUnknownEffect(PlanRow)(
          yield* sql.unsafe(`EXPLAIN QUERY PLAN ${text}`, params),
        );

        return rows.map((row) => row.detail);
      });

    return {
      runs: (yield* countRunsBlockingCloud(sql))
        .map((row) => String(row.run_id))
        .toSorted((a, b) => a.localeCompare(b)),
      packets: (yield* packetProjectsBlockingCloud(sql)).map((row) => row.name),
      runPlan: yield* plan(countRunsBlockingCloud(sql)),
      packetPlan: yield* plan(packetProjectsBlockingCloud(sql)),
    };
  }).pipe(Effect.provide(SqliteClient.layer({ filename })));

/** Seed active, terminal, uncertain and acknowledged history with plain SQLite rows. */
const seed = (filename: string) => {
  using database = new Database(filename);

  const run = database.prepare(
    "INSERT INTO review_execution_runs(run_id,project_id,finding_id,journal_id,engine,owner_generation,source_version,fact_version,state,version,route,provider,model,max_calls,max_input_tokens,max_output_tokens) VALUES (?,?,?,?,'engine','owner',0,0,?,0,'live','meta','model',1,256,16)",
  );

  const attempt = database.prepare(
    "INSERT INTO review_execution_attempts(journal_id,task_id,attempt,run_id,owner_generation,fingerprint,status,sent,response_json) VALUES (?,?,0,?,'owner','fingerprint',?,1,?)",
  );

  const addRun = (
    id: string,
    state: string,
    attempts: ReadonlyArray<"completed" | "uncertain">,
  ) => {
    run.run(id, "project", `finding-${id}`, `journal-${id}`, state);

    attempts.forEach((status, task) =>
      attempt.run(`journal-${id}`, task, id, status, status === "completed" ? "{}" : null),
    );
  };

  database.transaction(() => {
    for (let index = 0; index < 3000; index += 1)
      addRun(`history-${index}`, "completed", ["completed", "completed", "completed"]);

    addRun("active", "paused", ["completed"]);
    addRun("uncertain", "completed", ["completed", "uncertain"]);
    addRun("acknowledged", "failed", ["uncertain"]);
    addRun("sam-uncertain", "completed", []);

    database.run(
      "INSERT INTO review_sam_attempts(operation_id,run_id,project_id,finding_id,source_artifact_id,journal_id,owner_generation,source_version,fact_version,input_fingerprint,fingerprint,request_json,status,sent) VALUES ('sam','sam-uncertain','project','finding-sam-uncertain','artifact','journal-sam-uncertain','owner',0,0,'input','fingerprint','{}','uncertain',1)",
    );
    database.run(
      "INSERT INTO review_execution_commands(command_id,project_id,run_id,fingerprint,response_json) VALUES ('ack','project','acknowledged','fingerprint','{}')",
    );
    database.run(
      "INSERT INTO review_execution_acknowledgements(run_id,command_id,possible_charge_acknowledged) VALUES ('acknowledged','ack',1)",
    );

    const packet = database.prepare(
      "INSERT INTO packet_reviews(id,project_id,conversation_id,command_id,fingerprint,source_version,owner_generation,journal_id,engine,payload) VALUES (?,'project','conversation',?,'fingerprint',0,'owner',?,'engine',?)",
    );

    const states = ["running", "paused", "uncertain", "completed", "cancelled", "failed"];

    for (let index = 0; index < 600; index += 1) {
      const state = states[index % states.length];

      const payload = JSON.stringify({
        state,
        projectName: `${state}-project`,
        notes: "x".repeat(4000),
      });

      packet.run(`packet-${index}`, `command-${index}`, `packet-journal-${index}`, payload);
    }
  })();
};

test("cloud admission queries use indexes after migration 0012 with unchanged results", async () => {
  const root = await mkdtemp(join(tmpdir(), "moke-admission-indexes-"));
  const filename = join(root, "app.sqlite");
  const earlier = join(root, "migrations-0011");
  const backups = join(root, "backups");

  try {
    await mkdir(earlier);

    for (const name of await readdir(resolve("migrations")))
      if (name < "0012") await copyFile(join(resolve("migrations"), name), join(earlier, name));

    await Effect.runPromise(Effect.scoped(migrateDatabase(filename, earlier, backups)));
    seed(filename);
    const before = await Effect.runPromise(inspect(filename));

    expect(before.runs).toEqual(["active", "sam-uncertain", "uncertain"]);
    expect(before.packets).toEqual(["paused-project", "running-project", "uncertain-project"]);
    expect(before.runPlan.join("\n")).not.toContain("review_execution_attempts_by_run");
    expect(before.packetPlan.join("\n")).toContain("SCAN packet_reviews");

    await Effect.runPromise(
      Effect.scoped(migrateDatabase(filename, resolve("migrations"), backups)),
    );
    const after = await Effect.runPromise(inspect(filename));

    expect(after.runs).toEqual(before.runs);
    expect(after.packets).toEqual(before.packets);
    expect(after.runPlan.join("\n")).toContain("review_execution_attempts_by_run");
    expect(after.packetPlan.join("\n")).toContain("packet_reviews_by_state");
    expect(after.packetPlan.join("\n")).not.toContain("SCAN packet_reviews");

    // The upgrade keeps every seeded row and records the new migration after a backup.
    using database = new Database(filename, { readonly: true });

    expect(database.query("SELECT count(*) AS n FROM review_execution_runs").get()).toEqual({
      n: 3004,
    });
    expect(database.query("SELECT count(*) AS n FROM packet_reviews").get()).toEqual({ n: 600 });
    expect(
      database
        .query("SELECT name FROM __project_kit_migrations WHERE name=?")
        .get("0012_cloud_admission_indexes.sql"),
    ).toEqual({ name: "0012_cloud_admission_indexes.sql" });
    expect((await readdir(backups)).some((name) => name.includes("before-migration"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
