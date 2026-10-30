import { CommandId, ProjectId, ReviewCommand } from "#lib/review/contracts.ts";
import { Database } from "bun:sqlite";
import { Schema, Stream } from "effect";
import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendApi } from "../../desktop/backend.ts";

test("Bun owns typed APIs, authenticated access, recovery, persistence, and process cleanup", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "bun-backend-"));

  const launch = BackendApi.layer({
    command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
    dataDirectory,
    migrationDirectory: resolve("migrations"),
  });

  const backup = join(dataDirectory, "export.sqlite");
  const corrupt = join(dataDirectory, "corrupt.sqlite");
  await writeFile(corrupt, "This is not a database.");
  let pid = 0;

  const legacyNotes = () => {
    using database = new Database(join(dataDirectory, "app.sqlite"));

    return database.query("SELECT text FROM notes ORDER BY id").all();
  };

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* BackendApi;
          pid = backend.ready.pid;
          expect(backend.ready.runtime).toBe("bun");
          const url = `http://127.0.0.1:${backend.ready.port}/rpc`;
          const unauthorized = yield* Effect.promise(() => fetch(url, { method: "POST" }));
          expect(unauthorized.status).toBe(401);

          const browser = yield* Effect.promise(() =>
            fetch(url, { headers: { origin: "https://example.com" } }),
          );

          expect(browser.status).toBe(403);

          expect(
            (yield* backend.api.ReviewSnapshot({ projectId: null, afterSequence: 0 })).projects,
          ).toEqual([]);
          {
            using database = new Database(join(dataDirectory, "app.sqlite"));
            database.run("INSERT INTO notes(text) VALUES ('Legacy data')");
          }

          yield* backend.api.ExportDatabase({ destination: backup });
          {
            using database = new Database(join(dataDirectory, "app.sqlite"));
            database.run("INSERT INTO notes(text) VALUES ('After backup')");
          }

          yield* backend.api.RestoreDatabase({ source: backup });
          expect(legacyNotes()).toEqual([{ text: "Legacy data" }]);

          const failure = yield* Effect.exit(backend.api.RestoreDatabase({ source: corrupt }));
          expect(Exit.isFailure(failure)).toBe(true);
          expect(legacyNotes()).toEqual([{ text: "Legacy data" }]);

          const command = ReviewCommand.cases.CreateProject.make({
            commandId: Schema.decodeUnknownSync(CommandId)(crypto.randomUUID()),
            name: "Kept in Bun",
          });

          const saved = yield* backend.api.ReviewCommand({ command });

          const invalid = yield* Effect.exit(
            backend.api.ReviewCommand({ command: { ...command, name: "" } }),
          );

          expect(Exit.isFailure(invalid)).toBe(true);

          const snapshot = yield* backend.api.ReviewSnapshot({
            projectId: saved.projectId,
            afterSequence: 0,
          });

          expect(snapshot.projects.map((project) => project.name)).toEqual(["Kept in Bun"]);
        }).pipe(Effect.provide(launch)),
      ),
    );

    expect(() => process.kill(pid, 0)).toThrow();

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;

          return yield* api.ReviewSnapshot({ projectId: null, afterSequence: 0 });
        }).pipe(Effect.provide(launch)),
      ),
    );

    expect(snapshot.projects.map((project) => project.name)).toEqual(["Kept in Bun"]);
    expect(legacyNotes()).toEqual([{ text: "Legacy data" }]);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 120000);

test("missing migrations fail backend startup and preserve existing files", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "bun-startup-failure-"));
  const filename = join(dataDirectory, "app.sqlite");
  await writeFile(filename, "Existing data must remain untouched.");

  try {
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* BackendApi;
      }).pipe(
        Effect.provide(
          BackendApi.layer({
            command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
            dataDirectory,
            migrationDirectory: join(dataDirectory, "missing"),
          }),
        ),
      ),
    );

    expect(Exit.isFailure(await Effect.runPromiseExit(program))).toBe(true);
    expect(await readFile(filename, "utf8")).toBe("Existing data must remain untouched.");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 120000);

test("a backend crash reports a failed typed call and notifies its owner", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "bun-crash-"));
  const crashed = Promise.withResolvers<void>();

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { api, ready } = yield* BackendApi;
          yield* Effect.sync(() => process.kill(ready.pid, "SIGKILL"));

          const result = yield* Effect.exit(
            api.ReviewSnapshot({ projectId: null, afterSequence: 0 }),
          );

          expect(Exit.isFailure(result)).toBe(true);
          yield* Effect.promise(() => crashed.promise);
        }).pipe(
          Effect.provide(
            BackendApi.layer({
              command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
              dataDirectory,
              migrationDirectory: resolve("migrations"),
              onUnexpectedExit: () => crashed.resolve(),
            }),
          ),
          Effect.timeout("10 seconds"),
        ),
      ),
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 60000);

test("an unavailable backend executable returns a typed startup failure", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "bun-missing-executable-"));

  try {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* BackendApi;
        }).pipe(
          Effect.provide(
            BackendApi.layer({
              command: [join(dataDirectory, "missing-executable")],
              dataDirectory,
              migrationDirectory: resolve("migrations"),
            }),
          ),
        ),
      ).pipe(Effect.flip),
    );

    expect(failure._tag).toBe("BackendUnavailable");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("HTTP progress delivers a persisted event before an open subscription completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-http-progress-"));

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;
          const db = new Database(join(directory, "app.sqlite"));
          const runId = crypto.randomUUID();
          const projectId = crypto.randomUUID();
          db.query(
            "INSERT INTO review_execution_runs(run_id,project_id,finding_id,journal_id,engine,owner_generation,source_version,fact_version,state,version,route,provider,model,max_calls,max_input_tokens,max_output_tokens) VALUES (?,?,?,?,?,?,0,0,'completed',1,'recorded','meta','muse-spark-1.3',3,64000,256)",
          ).run(
            runId,
            projectId,
            crypto.randomUUID(),
            crypto.randomUUID(),
            "review-pi-1.4.0-v1",
            crypto.randomUUID(),
          );
          db.query(
            "INSERT INTO review_execution_events(run_id,project_id,state,version) VALUES (?,?,'completed',1)",
          ).run(runId, projectId);
          db.close();

          const event = yield* api
            .ObserveExecution({
              projectId: Schema.decodeUnknownSync(ProjectId)(projectId),
              afterSequence: 0,
            })
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("3 seconds"));

          expect(event.map((item) => String(item.runId))).toEqual([runId]);
        }).pipe(
          Effect.provide(
            BackendApi.layer({
              command: [process.execPath, "--no-orphans", resolve("backend/main.ts")],
              dataDirectory: directory,
              migrationDirectory: resolve("migrations"),
            }),
          ),
        ),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
