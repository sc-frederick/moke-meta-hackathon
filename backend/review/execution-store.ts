import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
  ExecutionError,
  ExecutionEvent,
  ExecutionState,
  ExecutionStatus,
  RunId,
} from "../../src/lib/review/execution.ts";
import { FindingId, ProjectId } from "../../src/lib/review/contracts.ts";

/** Parsed private execution record; never returned through renderer RPC. */
export const RunRecord = Schema.Struct({
  run_id: RunId,
  project_id: ProjectId,
  finding_id: FindingId,
  journal_id: Schema.String.check(Schema.isUUID()),
  engine: Schema.String,
  owner_generation: Schema.String.check(Schema.isUUID()),
  source_version: Schema.Int,
  fact_version: Schema.Int,
  state: ExecutionState,
  version: Schema.Int,
  route: Schema.Literals(["offline", "recorded", "live"]),
  provider: Schema.Literals(["meta", "baseten"]),
  model: Schema.String,
  max_calls: Schema.Int,
  max_input_tokens: Schema.Int,
  max_output_tokens: Schema.Int,
  admitted_calls: Schema.Int,
  reserved_input_tokens: Schema.Int,
  reserved_output_tokens: Schema.Int,
  prompt_version: Schema.optionalKey(Schema.String),
  review_context_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** SQLite row after boundary decoding. */
export type RunRecord = typeof RunRecord.Type;

/** An attempt starts conservatively uncertain before any transport dispatch. */
export const AttemptRecord = Schema.Struct({
  journal_id: Schema.String,
  task_id: Schema.Int,
  attempt: Schema.Int,
  run_id: RunId,
  owner_generation: Schema.String,
  fingerprint: Schema.String,
  status: Schema.Literals(["uncertain", "completed"]),
  sent: Schema.Literals([0, 1]),
  response_json: Schema.NullOr(Schema.String),
});

/** Domain SQL connections are operation-scoped and share the parent's recovery semaphore. */
export function executionPersistence(filename: string, queries: Semaphore.Semaphore) {
  const connection = SqliteClient.layer({ filename });

  const query = <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`PRAGMA synchronous=FULL`;

        return yield* sql.withTransaction(operation);
      }).pipe(Effect.provide(connection)),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof ExecutionError
          ? error
          : new ExecutionError({
              reason: "storage",
              message: "Execution state could not be read or saved.",
            }),
      ),
      Semaphore.withPermit(queries),
      Effect.uninterruptible,
    );

  const load = Effect.fn("ExecutionStore.load")(function* (
    runId: typeof RunId.Type,
    projectId: typeof ProjectId.Type,
  ) {
    const sql = yield* SqlClient.SqlClient;

    const rows =
      yield* sql`SELECT * FROM review_execution_runs WHERE run_id=${runId} AND project_id=${projectId}`;

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(rows);
    const row = decoded[0];

    if (row === undefined)
      return yield* new ExecutionError({
        reason: "input",
        message: "Execution was not found in this project.",
      });

    return row;
  });

  const event = Effect.fn("ExecutionStore.event")(function* (run: RunRecord) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO review_execution_events(run_id,project_id,state,version) VALUES (${run.run_id},${run.project_id},${run.state},${run.version})`;
  });

  const transition = Effect.fn("ExecutionStore.transition")(function* (
    run: RunRecord,
    state: typeof ExecutionState.Type,
  ) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE review_execution_runs SET state=${state},version=version+1 WHERE run_id=${run.run_id} AND version=${run.version}`;

    const changed = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ n: Schema.Literal(1) })),
    )(yield* sql`SELECT changes() AS n`).pipe(
      Effect.mapError(
        () =>
          new ExecutionError({
            reason: "conflict",
            message: "Execution changed before its transition could commit.",
          }),
      ),
    );

    if (changed.length !== 1)
      return yield* new ExecutionError({
        reason: "conflict",
        message: "Execution transition did not commit.",
      });
    const updated = yield* load(run.run_id, run.project_id);
    yield* event(updated);

    return updated;
  });

  const status = Effect.fn("ExecutionStore.status")(function* (run: RunRecord) {
    const sql = yield* SqlClient.SqlClient;

    const counts =
      yield* sql`SELECT ((SELECT count(*) FROM review_execution_attempts WHERE run_id=${run.run_id} AND status='uncertain') + (SELECT count(*) FROM review_sam_attempts WHERE run_id=${run.run_id} AND status='uncertain')) AS n, EXISTS(SELECT 1 FROM review_execution_acknowledgements WHERE run_id=${run.run_id}) AS acknowledged`;

    const parsed = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ n: Schema.Int, acknowledged: Schema.Int })),
    )(counts);

    return new ExecutionStatus({
      runId: run.run_id,
      projectId: run.project_id,
      findingId: run.finding_id,
      state: run.state,
      version: run.version,
      route: run.route,
      provider: run.provider,
      model: run.model,
      admittedCalls: run.admitted_calls,
      reservedInputTokens: run.reserved_input_tokens,
      reservedOutputTokens: run.reserved_output_tokens,
      unresolvedAttempts: parsed[0]?.n ?? 0,
      uncertaintyAcknowledged: parsed[0]?.acknowledged === 1,
      costUsd: null,
      imageInputTokens: null,
    });
  });

  const receipt = Effect.fn("ExecutionStore.receipt")(function* (
    commandId: string,
    fingerprint: string,
  ) {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ fingerprint: Schema.String, response_json: Schema.String })),
    )(
      yield* sql`SELECT fingerprint,response_json FROM review_execution_commands WHERE command_id=${commandId}`,
    );

    const previous = rows[0];

    if (previous === undefined) return null;

    if (previous.fingerprint !== fingerprint)
      return yield* new ExecutionError({
        reason: "conflict",
        message: "This execution command was already used with different inputs.",
      });

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionStatus))(
      previous.response_json,
    );
  });

  const saveReceipt = Effect.fn("ExecutionStore.saveReceipt")(function* (
    commandId: string,
    fingerprint: string,
    run: RunRecord,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const response = yield* status(run);
    yield* sql`INSERT INTO review_execution_commands(command_id,project_id,run_id,fingerprint,response_json) VALUES (${commandId},${run.project_id},${run.run_id},${fingerprint},${JSON.stringify(response)})`;

    return response;
  });

  const events = Effect.fn("ExecutionStore.events")(function* (
    projectId: typeof ProjectId.Type,
    afterSequence: number,
  ) {
    const sql = yield* SqlClient.SqlClient;

    return yield* Schema.decodeUnknownEffect(Schema.Array(ExecutionEvent))(
      yield* sql`SELECT sequence,run_id AS runId,state,version FROM review_execution_events WHERE project_id=${projectId} AND sequence>${afterSequence} ORDER BY sequence LIMIT 200`,
    );
  });

  return { query, load, event, transition, status, events, receipt, saveReceipt };
}
