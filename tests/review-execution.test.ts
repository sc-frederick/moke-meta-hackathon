import { executionPersistence } from "../backend/review/execution-store.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCanvas } from "@napi-rs/canvas";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
  Semaphore,
  Stream,
  Struct,
} from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDataDirectoryOwnership, OwnershipError } from "../backend/ownership.ts";
import { ReviewExecution, executionCommandId } from "../backend/review/execution.ts";
import {
  CountProposal,
  ExecutionEvidence,
  ExecutionImage,
  type ExecutionPort,
  type ExecutionFence,
} from "../backend/review/execution-port.ts";
import { Artifact, CommandId, CommandReceipt } from "../src/lib/review/contracts.ts";
import {
  ExecutionBudget,
  ExecutionError,
  type ExecutionStatus,
} from "../src/lib/review/execution.ts";
import { createAdmittedModels, type ProviderTransport } from "../backend/inference/provider.ts";

const projectId = randomUUID();
const findingId = randomUUID();
const sheetId = randomUUID();
const otherSheetId = randomUUID();

const evidence = Schema.decodeUnknownSync(ExecutionEvidence)({
  sourceVersion: 0,
  factVersion: 0,
  finding: {
    id: findingId,
    projectId,
    title: "Fixture",
    objectClass: "door",
    drawnSheetId: sheetId,
    scheduledSheetId: otherSheetId,
    applicabilityConfirmed: true,
    latestCheckId: null,
    outcome: "needs_evidence",
    closed: false,
    taskCompleted: false,
  },
  sheets: [],
  facts: [],
  checks: [],
  artifacts: [],
});

const budget = new ExecutionBudget({ maxCalls: 3, maxInputTokens: 64000, maxOutputTokens: 256 });

const unavailable = () =>
  Effect.fail(
    new ExecutionError({ reason: "unavailable", message: "Fixture capability is unavailable." }),
  );

function response(toolName?: string, args = {}) {
  const item =
    toolName === undefined
      ? {
          type: "message",
          id: "message_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        }
      : {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: toolName,
          arguments: JSON.stringify(args),
          status: "completed",
        };

  const events = [
    { type: "response.created", response: { id: "resp_fixture" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "review-execution-"));
  const db = new Database(join(path, "app.sqlite"));
  db.exec(
    await readFile(new URL("../migrations/0003_review_execution.sql", import.meta.url), "utf8"),
  );
  db.exec(
    await readFile(new URL("../migrations/0004_sam_observations.sql", import.meta.url), "utf8"),
  );
  db.exec(
    await readFile(new URL("../migrations/0005_execution_commands.sql", import.meta.url), "utf8"),
  );
  db.exec(
    "CREATE TABLE fixture_receipts (command_id TEXT PRIMARY KEY, receipt TEXT NOT NULL); CREATE TABLE fixture_proposals (command_id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  db.close();

  return path;
}

function open(
  path: string,
  transport: ProviderTransport,
  options: {
    timeoutMs?: number;
    closeTimeoutMs?: number;
    beforePropose?: () => Promise<void>;
    selected?: ExecutionEvidence;
    imagePort?: Pick<ExecutionPort, "render" | "readImage">;
  } = {},
) {
  let factVersion = 0;
  let lastFence: ExecutionFence | undefined;
  const queries = Semaphore.makeUnsafe(1);

  const port: ExecutionPort = {
    inspect: () =>
      Effect.succeed(
        new ExecutionEvidence({
          sourceVersion: (options.selected ?? evidence).sourceVersion,
          factVersion,
          finding: (options.selected ?? evidence).finding,
          sheets: (options.selected ?? evidence).sheets,
          facts: (options.selected ?? evidence).facts,
          checks: (options.selected ?? evidence).checks,
          artifacts: (options.selected ?? evidence).artifacts,
        }),
      ),
    render: options.imagePort?.render ?? unavailable,
    readImage: options.imagePort?.readImage ?? unavailable,
    evaluate: unavailable,
    message: unavailable,
    propose: (fence, proposal) =>
      Effect.gen(function* () {
        lastFence = fence;

        if (options.beforePropose !== undefined) yield* Effect.promise(options.beforePropose);

        return yield* Effect.try({
          try: () => {
            const db = new Database(join(path, "app.sqlite"));

            try {
              return db.transaction(() => {
                const saved = db
                  .query("SELECT receipt FROM fixture_receipts WHERE command_id=?")
                  .get(fence.commandId);

                if (saved !== null) {
                  const parsed = Schema.decodeUnknownSync(
                    Schema.Struct({ receipt: Schema.String }),
                  )(saved);

                  return Schema.decodeUnknownSync(CommandReceipt)(JSON.parse(parsed.receipt));
                }

                const run = Schema.decodeUnknownSync(
                  Schema.Struct({ state: Schema.String, owner_generation: Schema.String }),
                )(
                  db
                    .query(
                      "SELECT state, owner_generation FROM review_execution_runs WHERE run_id=?",
                    )
                    .get(fence.runId),
                );

                if (
                  (run.state !== "running" && run.state !== "pausing") ||
                  run.owner_generation !== fence.ownerGeneration ||
                  fence.factVersion !== factVersion
                )
                  throw new ExecutionError({
                    reason: "conflict",
                    message: "Stale fixture promotion.",
                  });

                const receipt = new CommandReceipt({
                  commandId: fence.commandId,
                  projectId: fence.projectId,
                  entityId: randomUUID(),
                  version: factVersion,
                });

                db.query("INSERT INTO fixture_proposals VALUES (?,?)").run(
                  fence.commandId,
                  proposal.value,
                );
                db.query("INSERT INTO fixture_receipts VALUES (?,?)").run(
                  fence.commandId,
                  JSON.stringify(receipt),
                );

                return receipt;
              })();
            } finally {
              db.close();
            }
          },
          catch: (error) =>
            error instanceof ExecutionError
              ? error
              : new ExecutionError({ reason: "storage", message: "Fixture commit failed." }),
        });
      }).pipe(Semaphore.withPermit(queries)),
  };

  const runtime: ManagedRuntime.ManagedRuntime<ReviewExecution, OwnershipError | ExecutionError> =
    ManagedRuntime.make(
      Layer.unwrap(
        Effect.gen(function* () {
          const owner = yield* acquireDataDirectoryOwnership(path);

          return ReviewExecution.layer({
            owner,
            queries,
            port,
            runPromise: (effect) => runtime.runPromise(effect),
            provider: {
              apiKey: Redacted.make("local-fixture-only"),
              route: "recorded",
              transport,
              timeoutMs: options.timeoutMs ?? 2000,
            },
            closeTimeoutMs: options.closeTimeoutMs ?? 200,
          });
        }),
      ),
    );

  return {
    runtime,
    port,
    get lastFence() {
      return lastFence;
    },
    start: (limits = budget) =>
      runtime.runPromise(
        Effect.flatMap(ReviewExecution, (execution) =>
          execution.start({
            commandId: Schema.decodeUnknownSync(CommandId)(crypto.randomUUID()),
            projectId: evidence.finding.projectId,
            findingId: evidence.finding.id,
            budget: limits,
          }),
        ),
      ),
    status: (run: ExecutionStatus) =>
      runtime.runPromise(
        Effect.flatMap(ReviewExecution, (execution) => execution.status(run.projectId, run.runId)),
      ),
    control: (run: ExecutionStatus, action: "pause" | "resume" | "cancel") =>
      runtime.runPromise(
        Effect.flatMap(ReviewExecution, (execution) =>
          execution.control(run.projectId, run.runId, run.version, action),
        ),
      ),
    correct: () => {
      factVersion++;
    },
    close: () =>
      runtime.runPromise(Effect.flatMap(ReviewExecution, (execution) => execution.close)),
  };
}

async function until(read: () => Promise<ExecutionStatus>, state: ExecutionStatus["state"]) {
  for (let i = 0; i < 200; i++) {
    const status = await read();

    if (status.state === state) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Execution did not reach ${state}`);
}

test("actual Pi and Meta SDK persist a response receipt before completing", async () => {
  const path = await directory();
  let sends = 0;

  const fixture = open(path, async () => {
    sends++;

    return response();
  });

  try {
    const run = await fixture.start();
    const completed = await until(() => fixture.status(run), "completed");
    expect(sends).toBe(1);
    expect(completed.route).toBe("recorded");
    expect(completed.costUsd).toBeNull();
    expect(completed.unresolvedAttempts).toBe(0);
    const db = new Database(join(path, "app.sqlite"));
    expect(
      db
        .query(
          "SELECT status,sent,response_json IS NOT NULL AS receipt FROM review_execution_attempts",
        )
        .all(),
    ).toEqual([{ status: "completed", sent: 1, receipt: 1 }]);
    db.close();
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("pause drains the admitted model response and admits no next tool until resume", async () => {
  const path = await directory();
  const sent = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  let sends = 0;

  const proposal = {
    side: "drawn",
    value: 4,
    evidence: { sheetId, region: { x: 0, y: 0, width: 10, height: 10 }, statement: "Four doors" },
    rationale: "Fixture evidence",
  };

  const transport: ProviderTransport = async () => {
    sends++;

    if (sends === 1) {
      sent.resolve();

      return answer.promise;
    }

    return response();
  };

  let fixture = open(path, transport);

  try {
    const run = await fixture.start();
    await sent.promise;
    const pausing = await fixture.control(run, "pause");
    expect(pausing.state).toBe("pausing");
    answer.resolve(response("propose_count", proposal));
    const paused = await until(() => fixture.status(run), "paused");
    const db = new Database(join(path, "app.sqlite"));
    expect(db.query("SELECT * FROM fixture_proposals").all()).toHaveLength(0);
    expect(sends).toBe(1);
    await fixture.runtime.dispose();
    fixture = open(path, transport);
    const recovered = await fixture.status(paused);
    expect(recovered.state).toBe("paused");
    expect(sends).toBe(1);
    await fixture.control(recovered, "resume");
    await until(() => fixture.status(run), "completed");
    expect(db.query("SELECT value FROM fixture_proposals").all()).toEqual([{ value: 4 }]);
    expect(sends).toBe(2);
    const lastFence = fixture.lastFence;

    if (lastFence === undefined) throw new Error("No tool fence was captured");
    const parsedProposal = Schema.decodeUnknownSync(CountProposal)(proposal);

    const firstReceipt = await fixture.runtime.runPromise(
      fixture.port.propose(lastFence, parsedProposal),
    );

    const replayReceipt = await fixture.runtime.runPromise(
      fixture.port.propose(lastFence, parsedProposal),
    );

    expect(replayReceipt).toEqual(firstReceipt);
    expect(db.query("SELECT value FROM fixture_proposals").all()).toEqual([{ value: 4 }]);
    db.close();
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("timeout remains uncertain across reopen, resume, and a fresh generation", async () => {
  const path = await directory();
  let sends = 0;

  const transport: ProviderTransport = async (_input, init) => {
    sends++;

    return new Promise((_resolve, reject) => {
      const signal = init?.signal;

      if (signal?.aborted) return reject(new Error("fixture abort"));
      signal?.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
    });
  };

  const first = open(path, transport, { timeoutMs: 20 });
  const run = await first.start();
  const uncertain = await until(() => first.status(run), "uncertain");
  expect(uncertain.unresolvedAttempts).toBe(1);
  await first.runtime.dispose();
  const second = open(path, transport);

  try {
    const recovered = await second.status(run);
    expect(recovered.state).toBe("uncertain");

    const resumeError = await second.runtime.runPromise(
      Effect.flatMap(ReviewExecution, (execution) =>
        execution.control(recovered.projectId, recovered.runId, recovered.version, "resume"),
      ).pipe(Effect.flip),
    );

    expect(resumeError.reason).toBe("uncertain");

    const startError = await second.runtime.runPromise(
      Effect.flatMap(ReviewExecution, (execution) =>
        execution.start({
          commandId: Schema.decodeUnknownSync(CommandId)(crypto.randomUUID()),
          projectId: recovered.projectId,
          findingId: recovered.findingId,
          budget,
        }),
      ).pipe(Effect.flip),
    );

    expect(startError.reason).toBe("conflict");
    expect(sends).toBe(1);
  } finally {
    await second.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("stale late proposals fail promotion and malformed tool args never reach the port", async () => {
  const path = await directory();
  const promotion = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let sends = 0;

  const fixture = open(
    path,
    async () => {
      sends++;

      return sends === 1
        ? response("propose_count", {
            side: "drawn",
            value: 2,
            evidence: {
              sheetId,
              region: { x: 0, y: 0, width: 10, height: 10 },
              statement: "Two doors",
            },
            rationale: "fixture",
          })
        : response();
    },
    {
      beforePropose: async () => {
        promotion.resolve();
        await release.promise;
      },
    },
  );

  try {
    const run = await fixture.start();
    await promotion.promise;
    fixture.correct();
    release.resolve();
    await until(() => fixture.status(run), "failed");
    const db = new Database(join(path, "app.sqlite"));
    expect(db.query("SELECT * FROM fixture_proposals").all()).toHaveLength(0);
    db.close();
    expect(sends).toBe(1);
  } finally {
    release.resolve();
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }

  const malformedPath = await directory();
  let malformedSends = 0;

  const malformed = open(malformedPath, async () => {
    malformedSends++;

    return malformedSends === 1 ? response("propose_count", { value: "two" }) : response();
  });

  try {
    const run = await malformed.start();
    await until(() => malformed.status(run), "completed");
    const db = new Database(join(malformedPath, "app.sqlite"));
    expect(db.query("SELECT * FROM fixture_proposals").all()).toHaveLength(0);
    db.close();
  } finally {
    await malformed.runtime.dispose();
    await rm(malformedPath, { recursive: true, force: true });
  }
});

test("compiled processes exclude a second owner and reacquire after SIGKILL", async () => {
  const path = await mkdtemp(join(tmpdir(), "review-owner-"));
  const entry = join(path, "owner.ts");
  const executable = join(path, "owner");
  await writeFile(
    entry,
    `import { Effect } from ${JSON.stringify(resolve("node_modules/effect/dist/index.js"))};
import { acquireDataDirectoryOwnership } from ${JSON.stringify(resolve("backend/ownership.ts"))};
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){ yield* acquireDataDirectoryOwnership(process.argv[2]); console.log("OWNED"); yield* Effect.never; }))).catch(()=>{console.log("DENIED");process.exit(2)});`,
  );

  const build = Bun.spawn(
    [process.execPath, "build", entry, "--compile", "--outfile", executable],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(await build.exited).toBe(0);
  const first = Bun.spawn([executable, join(path, "data")], { stdout: "pipe", stderr: "pipe" });

  try {
    expect(new TextDecoder().decode((await first.stdout.getReader().read()).value).trim()).toBe(
      "OWNED",
    );
    const second = Bun.spawn([executable, join(path, "data")], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(second.stdout).text()).toContain("DENIED");
    expect(await second.exited).toBe(2);
    first.kill("SIGKILL");
    await first.exited;
    const third = Bun.spawn([executable, join(path, "data")], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode((await third.stdout.getReader().read()).value).trim()).toBe(
      "OWNED",
    );
    third.kill("SIGKILL");
    await third.exited;
  } finally {
    first.kill("SIGKILL");
    await first.exited;
    await rm(path, { recursive: true, force: true });
  }
}, 15000);

test("journal task IDs map to stable command UUIDs without model call identity", () => {
  const journal = randomUUID();
  expect(executionCommandId(journal, 42)).toBe(executionCommandId(journal, 42));
  expect(executionCommandId(journal, 42)).not.toBe(executionCommandId(journal, 43));
});

test("compiled Pi process killed at dispatch reopens uncertain with zero extra sends", async () => {
  const path = await directory();
  const entry = join(path, "crash.ts");
  const executable = join(path, "crash");

  const source = `import { Effect,Layer,ManagedRuntime,Redacted,Schema,Semaphore } from ${JSON.stringify(resolve("node_modules/effect/dist/index.js"))};
import { appendFileSync } from "node:fs";
import { acquireDataDirectoryOwnership } from ${JSON.stringify(resolve("backend/ownership.ts"))};
import { ReviewExecution } from ${JSON.stringify(resolve("backend/review/execution.ts"))};
import { ExecutionEvidence } from ${JSON.stringify(resolve("backend/review/execution-port.ts"))};
import { ExecutionBudget,ExecutionError,RunId } from ${JSON.stringify(resolve("src/lib/review/execution.ts"))};
import { CommandId } from ${JSON.stringify(resolve("src/lib/review/contracts.ts"))};
const evidence=Schema.decodeUnknownSync(ExecutionEvidence)(${JSON.stringify(evidence)});
const dataDirectory=process.argv[4]??${JSON.stringify(path)};
const sent=Promise.withResolvers();
const unavailable=()=>Effect.fail(new ExecutionError({reason:"unavailable",message:"fixture"}));
const port={inspect:()=>Effect.succeed(evidence),render:unavailable,readImage:unavailable,propose:unavailable,evaluate:unavailable,message:unavailable};
const runtime=ManagedRuntime.make(Layer.unwrap(Effect.gen(function*(){
 const owner=yield* acquireDataDirectoryOwnership(dataDirectory);
 return ReviewExecution.layer({owner,queries:Semaphore.makeUnsafe(1),port,runPromise:effect=>runtime.runPromise(effect),closeTimeoutMs:25,provider:{apiKey:Redacted.make("fixture"),route:"recorded",transport:async()=>{appendFileSync(dataDirectory+"/sends","send\\n");console.log("DISPATCHED");sent.resolve();await new Promise(()=>{});},timeoutMs:60000}});
})));
const execution=await runtime.runPromise(ReviewExecution);
if(process.argv[2]==="start"||process.argv[2]==="bounded"){
 const run=await runtime.runPromise(execution.start({ commandId: Schema.decodeUnknownSync(CommandId)(crypto.randomUUID()),projectId:evidence.finding.projectId,findingId:evidence.finding.id,budget:new ExecutionBudget(${JSON.stringify(budget)})}));
 if(process.argv[2]==="bounded"){
  await sent.promise;
  const started=performance.now();
  const drained=await runtime.runPromise(execution.close);
  const status=await runtime.runPromise(execution.status(run.projectId,run.runId));
  console.log(JSON.stringify({drained,elapsed:performance.now()-started,status}));
  await runtime.dispose();
  process.exit(0);
 }
 await new Promise(()=>{});
}else{
 const runId=Schema.decodeUnknownSync(RunId)(process.argv[3]);
 const status=await runtime.runPromise(execution.status(evidence.finding.projectId,runId));
 const resume=await runtime.runPromise(Effect.result(execution.control(status.projectId,status.runId,status.version,"resume")));
 const fresh=await runtime.runPromise(Effect.result(execution.start({ commandId: Schema.decodeUnknownSync(CommandId)(crypto.randomUUID()),projectId:status.projectId,findingId:status.findingId,budget:new ExecutionBudget(${JSON.stringify(budget)})})));
 console.log(JSON.stringify({status,resume,fresh}));
 await runtime.dispose();
}`;

  await writeFile(entry, source);

  const build = Bun.spawn(
    [process.execPath, "build", entry, "--compile", "--outfile", executable],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(await build.exited).toBe(0);
  const first = Bun.spawn([executable, "start"], { cwd: "/", stdout: "pipe", stderr: "pipe" });

  try {
    expect(new TextDecoder().decode((await first.stdout.getReader().read()).value)).toContain(
      "DISPATCHED",
    );
    first.kill("SIGKILL");
    await first.exited;
    const db = new Database(join(path, "app.sqlite"));

    const row = Schema.decodeUnknownSync(Schema.Struct({ run_id: Schema.String }))(
      db.query("SELECT run_id FROM review_execution_runs").get(),
    );

    db.close();

    const recovered = Bun.spawn([executable, "reopen", row.run_id], {
      cwd: "/",
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(recovered.stdout).text();
    expect(await recovered.exited).toBe(0);
    expect(output).toContain('"state":"uncertain"');
    expect(output).toContain('"reason":"uncertain"');
    expect(output).toContain('"reason":"conflict"');
    expect(await readFile(join(path, "sends"), "utf8")).toBe("send\n");
    const boundedPath = await directory();

    try {
      const bounded = Bun.spawn([executable, "bounded", "", boundedPath], {
        cwd: "/",
        stdout: "pipe",
        stderr: "pipe",
      });

      const closeOutput = await new Response(bounded.stdout).text();
      expect(await bounded.exited).toBe(0);
      expect(closeOutput).toContain('"drained":false');
      expect(closeOutput).toContain('"state":"uncertain"');
      expect(await readFile(join(boundedPath, "sends"), "utf8")).toBe("send\n");
    } finally {
      await rm(boundedPath, { recursive: true, force: true });
    }
  } finally {
    first.kill("SIGKILL");
    await first.exited;
    await rm(path, { recursive: true, force: true });
  }
}, 15000);

test("SDK error retry headers cannot bypass the one-send reservation", async () => {
  const path = await directory();
  let sends = 0;

  const fixture = open(path, async (_input, init) => {
    sends++;
    const body = Schema.decodeUnknownSync(Schema.String)(init?.body);
    expect(body).toContain('"stream":true');

    return new Response(JSON.stringify({ error: { message: "fixture only" } }), {
      status: 503,
      headers: { "retry-after-ms": "1", "content-type": "application/json" },
    });
  });

  try {
    const run = await fixture.start();
    await until(() => fixture.status(run), "uncertain");
    expect(sends).toBe(1);
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("both provider entrypoints replay completed receipts and reject manual compaction", async () => {
  let sends = 0;
  let receipt: string | null = null;

  const admitted = createAdmittedModels(
    {
      apiKey: Redacted.make("fixture"),
      route: "recorded",
      transport: async (_input, init) => {
        sends++;

        const body = Schema.decodeUnknownSync(
          Schema.Struct({ max_output_tokens: Schema.Int, stream: Schema.Boolean }),
        )(JSON.parse(Schema.decodeUnknownSync(Schema.String)(init?.body)));

        expect(body.max_output_tokens).toBe(256);
        expect(body.stream).toBe(true);

        return response();
      },
    },
    {
      maxInputTokens: 64000,
      maxOutputTokens: 256,
      begin: async () => receipt,
      send: async () => undefined,
      complete: async (_phase, saved) => {
        receipt = saved;
      },
      end: async () => undefined,
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (model === undefined) throw new Error("Pinned model missing");
  const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };

  const request = {
    name: "pi.durable.phase",
    attributes: { "task.id": 42, "task.name": "pi.generation", phase: "request", attempt: 1 },
  };

  const first = await admitted.telemetry.startSpan(request, (telemetry) =>
    admitted.models.complete(model, context, {
      telemetry,
      transport: "websocket",
      maxRetries: 9,
      maxTokens: 99999,
      samplingParams: { max_output_tokens: 99999 },
    }),
  );

  const second = await admitted.telemetry.startSpan(request, (telemetry) =>
    admitted.models.completeSimple(model, context, {
      telemetry,
      transport: "websocket",
      maxRetries: 9,
      maxTokens: 99999,
    }),
  );

  expect(first.stopReason).toBe("stop");
  expect(second.content).toEqual(first.content);
  expect(sends).toBe(1);

  const denied = await admitted.telemetry.startSpan(
    {
      name: "pi.durable.phase",
      attributes: { "task.id": 43, "task.name": "pi.compaction", phase: "request", attempt: 1 },
    },
    (telemetry) => admitted.models.completeSimple(model, context, { telemetry }),
  );

  expect(denied.stopReason).toBe("error");
  expect(sends).toBe(1);
});

test("call and conservative input-token reservations stop further dispatch", async () => {
  const path = await directory();
  let sends = 0;

  const fixture = open(path, async () => {
    sends++;

    return response("inspect_selected_evidence");
  });

  try {
    const run = await fixture.start(
      new ExecutionBudget({ maxCalls: 1, maxInputTokens: 64000, maxOutputTokens: 256 }),
    );

    const stopped = await until(() => fixture.status(run), "failed");
    expect(sends).toBe(1);
    expect(stopped.admittedCalls).toBe(1);
    expect(stopped.reservedOutputTokens).toBe(256);
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }

  const boundedPath = await directory();
  let boundedSends = 0;

  const bounded = open(boundedPath, async () => {
    boundedSends++;

    return response();
  });

  try {
    const run = await bounded.start(
      new ExecutionBudget({ maxCalls: 1, maxInputTokens: 256, maxOutputTokens: 256 }),
    );

    await until(() => bounded.status(run), "uncertain");
    expect(boundedSends).toBe(0);
  } finally {
    await bounded.runtime.dispose();
    await rm(boundedPath, { recursive: true, force: true });
  }
});

test("actual Pi and SDK carry overview and targeted pixels with their delivered dimensions", async () => {
  const path = await directory();
  const canvas = createCanvas(200, 200);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(200, 200);
  let seed = 12345;

  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels.data.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], i);
  }

  context.putImageData(pixels, 0, 0);
  const data = canvas.toBuffer("image/png").toString("base64");
  expect(data.length).toBeGreaterThan(64000);
  const revisionId = randomUUID();

  const makeArtifact = (selectedSheetId: string) =>
    Schema.decodeUnknownSync(Artifact)({
      id: randomUUID(),
      projectId,
      revisionId,
      sheetId: selectedSheetId,
      sha256: "a".repeat(64),
      mediaType: "image/png",
      byteLength: Buffer.byteLength(data, "base64"),
      width: 200,
      height: 200,
      region: { x: 0, y: 0, width: 200, height: 200 },
      dpi: 72,
      pdfToPixels: [1, 0, 0, 1, 0, 0],
      pixelsToPdf: [1, 0, 0, 1, 0, 0],
      operationId: randomUUID(),
    });

  const artifacts = [makeArtifact(sheetId), makeArtifact(otherSheetId)];

  const selected = Schema.decodeUnknownSync(ExecutionEvidence)({
    sourceVersion: 0,
    factVersion: 0,
    finding: evidence.finding,
    facts: [],
    checks: [],
    artifacts,
    sheets: [sheetId, otherSheetId].map((id) => ({
      id,
      projectId,
      revisionId,
      pageIndex: 0,
      label: "Fixture",
      confirmed: true,
      box: { x: 0, y: 0, width: 200, height: 200 },
      rotation: 0,
      userUnit: 1,
      coverage: "unreviewed",
    })),
  });

  let sends = 0;
  let rendered = 0;
  let imageReads = 0;

  const fixture = open(
    path,
    async (_input, init) => {
      sends++;
      const body = Schema.decodeUnknownSync(Schema.String)(init?.body);

      if (sends === 1) return response("inspect_selected_evidence");
      expect(body).toContain(`data:image/png;base64,${data}`);
      expect(body).toContain('\\"width\\":200');
      expect(body).toContain('\\"height\\":200');

      if (sends === 2)
        return response("render_missing_detail", {
          sheetId,
          region: { x: 20, y: 20, width: 30, height: 30 },
          missingFact: "Read the unclear schedule count",
        });

      return response();
    },
    {
      selected,
      imagePort: {
        render: (_fence, request) => {
          rendered++;
          expect(request.missingFact).toContain("unclear");

          return Effect.succeed(makeArtifact(request.sheetId));
        },
        readImage: (artifact) => {
          imageReads++;

          return Effect.succeed(
            Schema.decodeUnknownSync(ExecutionImage)({
              artifactId: artifact.id,
              projectId: artifact.projectId,
              sheetId: artifact.sheetId,
              mimeType: "image/png",
              data,
              width: 200,
              height: 200,
              pdfToPixels: artifact.pdfToPixels,
              pixelsToPdf: artifact.pixelsToPdf,
            }),
          );
        },
      },
    },
  );

  try {
    const run = await fixture.start();
    await until(() => fixture.status(run), "completed");
    expect(sends).toBe(3);
    expect(imageReads).toBe(3);
    expect(rendered).toBe(1);
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("cancel persists before abort and a late tool response cannot promote", async () => {
  const path = await directory();
  const sent = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  let sends = 0;

  const transport: ProviderTransport = async () => {
    sends++;
    sent.resolve();

    return answer.promise;
  };

  const fixture = open(path, transport);

  try {
    const run = await fixture.start();
    await sent.promise;
    const cancelled = await fixture.control(run, "cancel");
    expect(cancelled.state).toBe("cancelled");
    answer.resolve(
      response("propose_count", {
        side: "drawn",
        value: 4,
        evidence: { sheetId, region: { x: 0, y: 0, width: 10, height: 10 }, statement: "late" },
        rationale: "late",
      }),
    );
    await fixture.close();
    const db = new Database(join(path, "app.sqlite"));
    expect(db.query("SELECT * FROM fixture_proposals").all()).toHaveLength(0);
    expect(db.query("SELECT state FROM review_execution_runs").all()).toEqual([
      { state: "cancelled" },
    ]);
    db.close();
    expect(sends).toBe(1);
  } finally {
    answer.resolve(response());
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("existing journal identity mismatch is explicit and cannot dispatch", async () => {
  const path = await directory();
  const sent = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  let sends = 0;

  const transport: ProviderTransport = async () => {
    sends++;
    sent.resolve();

    return answer.promise;
  };

  let fixture = open(path, transport);

  try {
    const run = await fixture.start();
    await sent.promise;
    await fixture.control(run, "pause");
    answer.resolve(response("inspect_selected_evidence"));
    await until(() => fixture.status(run), "paused");
    await fixture.runtime.dispose();
    const db = new Database(join(path, "app.sqlite"));

    const row = Schema.decodeUnknownSync(Schema.Struct({ journal_id: Schema.String }))(
      db.query("SELECT journal_id FROM review_execution_runs").get(),
    );

    db.close();
    const journal = new Database(join(path, "execution-journals", `${row.journal_id}.sqlite`));
    journal.exec("UPDATE review_journal_identity SET format='unsupported-format'");
    journal.close();
    fixture = open(path, transport);
    const paused = await fixture.status(run);

    const error = await fixture.runtime.runPromise(
      Effect.flatMap(ReviewExecution, (execution) =>
        execution.control(paused.projectId, paused.runId, paused.version, "resume"),
      ).pipe(Effect.flip),
    );

    expect(error.reason).toBe("incompatible");
    expect((await fixture.status(run)).state).toBe("incompatible");
    expect(sends).toBe(1);
  } finally {
    answer.resolve(response());
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("lifecycle commands replay before freshness checks and reject changed input", async () => {
  const path = await directory();
  const sent = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  let sends = 0;

  const fixture = open(path, async () => {
    sends++;
    sent.resolve();

    return answer.promise;
  });

  const commandId = Schema.decodeUnknownSync(CommandId)(randomUUID());

  const request = {
    commandId,
    projectId: evidence.finding.projectId,
    findingId: evidence.finding.id,
    budget,
  };

  try {
    const execution = await fixture.runtime.runPromise(ReviewExecution);
    const first = await fixture.runtime.runPromise(execution.start(request));
    await sent.promise;
    const pauseId = Schema.decodeUnknownSync(CommandId)(randomUUID());

    const paused = await fixture.runtime.runPromise(
      execution.control(first.projectId, first.runId, first.version, "pause", pauseId),
    );

    expect(await fixture.runtime.runPromise(execution.start(request))).toEqual(first);
    expect(
      await fixture.runtime.runPromise(
        execution.control(first.projectId, first.runId, first.version, "pause", pauseId),
      ),
    ).toEqual(paused);

    const changed = await fixture.runtime.runPromise(
      execution
        .start({
          ...request,
          budget: new ExecutionBudget(Struct.assign(budget, { maxCalls: 1 } as const)),
        })
        .pipe(Effect.flip),
    );

    expect(changed.reason).toBe("conflict");
    expect(sends).toBe(1);
  } finally {
    answer.resolve(response());
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("explicit uncertainty acknowledgement preserves the old ledger and permits only a new run", async () => {
  const path = await directory();
  let sends = 0;

  const fixture = open(
    path,
    async (_input, init) => {
      sends++;

      if (sends > 1) return response();

      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("fixture abort")), {
          once: true,
        }),
      );
    },
    { timeoutMs: 20 },
  );

  try {
    const original = await fixture.start();
    const uncertain = await until(() => fixture.status(original), "uncertain");
    const execution = await fixture.runtime.runPromise(ReviewExecution);
    const commandId = Schema.decodeUnknownSync(CommandId)(randomUUID());

    const acknowledged = await fixture.runtime.runPromise(
      execution.acknowledge(uncertain.projectId, uncertain.runId, uncertain.version, commandId),
    );

    expect(acknowledged.state).toBe("cancelled");
    expect(acknowledged.unresolvedAttempts).toBe(1);
    expect(
      await fixture.runtime.runPromise(
        execution.acknowledge(uncertain.projectId, uncertain.runId, uncertain.version, commandId),
      ),
    ).toEqual(acknowledged);
    expect(sends).toBe(1);
    const fresh = await fixture.start();
    expect(fresh.runId).not.toBe(original.runId);
    await until(() => fixture.status(fresh), "completed");
    expect(sends).toBe(2);
    expect((await fixture.status(original)).unresolvedAttempts).toBe(1);
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("progress reconnect drains persisted pages without needing a new operation", async () => {
  const path = await directory();
  const fixture = open(path, async () => response());

  try {
    const run = await fixture.start();
    await until(() => fixture.status(run), "completed");
    const db = new Database(join(path, "app.sqlite"));
    db.transaction(() => {
      for (let index = 0; index < 205; index++)
        db.query(
          "INSERT INTO review_execution_events(run_id,project_id,state,version) VALUES (?,?,?,?)",
        ).run(run.runId, run.projectId, "completed", index);
    })();

    const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ sequence: Schema.Int })))(
      db.query("SELECT sequence FROM review_execution_events ORDER BY sequence").all(),
    );

    db.close();

    const events = await fixture.runtime.runPromise(
      Effect.flatMap(ReviewExecution, (execution) =>
        execution
          .observe(run.projectId, 0)
          .pipe(Stream.take(rows.length), Stream.runCollect, Effect.timeout("3 seconds")),
      ),
    );

    expect(events.map((event) => event.sequence)).toEqual(rows.map((row) => row.sequence));
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

test("recent image window keeps six actual images and metadata without growing a request", async () => {
  const images = Array.from({ length: 8 }, (_, index) => {
    const canvas = createCanvas(32, 32);
    const context = canvas.getContext("2d");
    context.fillText(String(index), 5, 20);

    return {
      type: "image" as const,
      mimeType: "image/png",
      data: canvas.toBuffer("image/png").toString("base64"),
    };
  });

  let sends = 0;
  let receipt: string | null = null;
  const fingerprints: string[] = [];

  const admitted = createAdmittedModels(
    {
      apiKey: Redacted.make("fixture"),
      route: "recorded",
      transport: async (_input, init) => {
        sends++;
        const body = Schema.decodeUnknownSync(Schema.String)(init?.body);
        expect(body.split("data:image/png;base64,").length - 1).toBe(6);
        expect(body).toContain("Earlier image omitted");
        expect(body).not.toContain(images[0]?.data ?? "invalid");
        expect(body).toContain(images[7]?.data ?? "invalid");

        return response();
      },
    },
    {
      maxInputTokens: 64000,
      maxOutputTokens: 256,
      begin: async (_phase, fingerprint) => {
        fingerprints.push(fingerprint);

        return receipt;
      },
      send: async () => undefined,
      complete: async (_phase, saved) => {
        receipt = saved;
      },
      end: async () => undefined,
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (model === undefined) throw new Error("Pinned model missing");
  const context = { messages: [{ role: "user" as const, content: images, timestamp: 0 }] };

  const phase = {
    name: "pi.durable.phase",
    attributes: { "task.id": 42, "task.name": "pi.generation", phase: "request", attempt: 1 },
  };

  const first = await admitted.telemetry.startSpan(phase, (telemetry) =>
    admitted.models.completeSimple(model, context, { telemetry }),
  );

  const replay = await admitted.telemetry.startSpan(phase, (telemetry) =>
    admitted.models.completeSimple(model, context, { telemetry }),
  );

  expect(first.stopReason).toBe("stop");
  expect(replay.content).toEqual(first.content);
  expect(fingerprints[1]).toBe(fingerprints[0]);
  expect(sends).toBe(1);
});

test("a missed execution transition rolls its transaction back without a phantom event", async () => {
  const path = await directory();
  const fixture = open(path, async () => response());

  try {
    const started = await fixture.start();
    await until(() => fixture.status(started), "completed");
    const store = executionPersistence(join(path, "app.sqlite"), Semaphore.makeUnsafe(1));

    const original = await fixture.runtime.runPromise(
      store.query(store.load(started.runId, started.projectId)),
    );

    const before = await fixture.runtime.runPromise(
      store.query(store.events(started.projectId, 0)),
    );

    const failed = await fixture.runtime.runPromise(
      store
        .query(
          Effect.gen(function* () {
            yield* store.transition(original, "paused");
            yield* store.transition(original, "cancelled");
          }),
        )
        .pipe(Effect.result),
    );

    expect(failed).toSatisfy(Result.isFailure);
    expect((await fixture.status(started)).version).toBe(original.version);
    expect((await fixture.status(started)).state).toBe("completed");
    expect(
      await fixture.runtime.runPromise(store.query(store.events(started.projectId, 0))),
    ).toEqual(before);
  } finally {
    await fixture.runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
