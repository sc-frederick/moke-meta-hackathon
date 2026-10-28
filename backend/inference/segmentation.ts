import { SqliteClient } from "@effect/sql-sqlite-bun";
import { buildObjectPrompt, decodeMaskToSVGPath, formats, recordsOfKind } from "@meta-sam/parser";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Artifact, ProjectId } from "../../src/lib/review/contracts.ts";
import { ExecutionError } from "../../src/lib/review/execution.ts";
import { SamInspectionRequest, SamObservation } from "../../src/lib/review/segmentation.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import { ExecutionFence, ExecutionImage } from "../review/execution-port.ts";
import { RunRecord } from "../review/execution-store.ts";

const route = "https://api.meta.ai/v1/responses";
const model = "sam-3.1";
const parserVersion = "@meta-sam/parser@0.1.0";
const maxResponseBytes = 8 * 1024 * 1024;

/** Inject a local HTTP transport for tests while preserving the canonical route and request. */
export type SamTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Parent-owned source loading and bounded image encoding run outside the SQL semaphore. */
interface ReviewSegmentationConfiguration {
  readonly dataDirectory: string;
  readonly queries: Semaphore.Semaphore;
  readonly owner: DataDirectoryOwnership["Service"];
  readonly apiKey: Redacted.Redacted<string>;
  readonly loadArtifact: (
    projectId: typeof ProjectId.Type,
    artifactId: SamInspectionRequest["artifactId"],
  ) => Effect.Effect<Artifact, ExecutionError>;
  readonly readImage: (artifact: Artifact) => Effect.Effect<ExecutionImage, ExecutionError>;
  readonly transport?: SamTransport;
}

const failure = (reason: ExecutionError["reason"], message: string) =>
  new ExecutionError({ reason, message });

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const Attempt = Schema.Struct({
  input_fingerprint: Schema.String,
  fingerprint: Schema.String,
  status: Schema.Literals(["uncertain", "completed"]),
  result_json: Schema.NullOr(Schema.String),
});

const ResponseIdentity = Schema.fromJsonString(Schema.Struct({ id: Schema.NonEmptyString }));

const ResponseBody = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("completed"),
    error: Schema.optional(Schema.Null),
    incomplete_details: Schema.optional(Schema.Null),
    output: Schema.Tuple([
      Schema.Struct({
        type: Schema.Literal("message"),
        status: Schema.optional(Schema.Literal("completed")),
        content: Schema.Tuple([
          Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
        ]),
      }),
    ]),
  }),
);

const promptFor = Effect.fn("ReviewSegmentation.prompt")(function* (
  request: SamInspectionRequest,
  image: ExecutionImage,
) {
  const prompt = request.prompt;

  if (prompt.kind === "concept") return prompt.text;

  const guidance = Match.value(prompt).pipe(
    Match.when({ kind: "box" }, (value) => ({ box: value.box })),
    Match.when({ kind: "points" }, (value) => ({ points: value.points })),
    Match.when({ kind: "guided" }, (value) => ({ box: value.box, points: value.points })),
    Match.exhaustive,
  );

  return yield* Effect.try({
    try: () =>
      buildObjectPrompt({
        size: { width: image.width, height: image.height },
        objects: [{ id: 1, prompts: [guidance] }],
      }),
    catch: () => failure("input", "SAM guidance is outside the delivered image or is empty."),
  });
});

const parseInstances = Effect.fn("ReviewSegmentation.parse")(function* (
  text: string,
  image: ExecutionImage,
) {
  const parsed = yield* Effect.try({
    try: () => {
      const parser = formats.segmentation.image().createParser();
      parser.push(text);

      return parser.finish({ status: "completed" }).result;
    },
    catch: () => failure("uncertain", "SAM output could not be parsed."),
  });

  if (
    parsed.diagnostics.some((item) => item.severity === "error") ||
    parsed.records.some((item) => item.kind === "text")
  )
    return yield* failure("uncertain", "SAM returned malformed or incomplete geometry.");

  const boxes = recordsOfKind(parsed.records, "box");
  const masks = recordsOfKind(parsed.records, "mask");

  if (
    boxes.length !== masks.length ||
    boxes.length > 256 ||
    (text.trim() !== "" && boxes.length === 0) ||
    new Set(boxes.map((box) => box.objectId)).size !== boxes.length
  )
    return yield* failure("uncertain", "SAM returned missing, excessive, or repeated instances.");

  const instances = [];
  const [a, b, c, d, e, f] = image.pixelsToPdf;
  const point = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });

  for (const box of boxes) {
    const mask = masks.find((item) => item.objectId === box.objectId);

    if (
      mask === undefined ||
      (box.frame !== undefined && box.frame.frameIndex !== 0) ||
      (mask.frame !== undefined && mask.frame.frameIndex !== 0) ||
      box.left < 0 ||
      box.top < 0 ||
      box.right > image.width ||
      box.bottom > image.height ||
      mask.mask.width * mask.mask.height > 2048 * 2048
    )
      return yield* failure("uncertain", "SAM geometry is outside the delivered image bounds.");

    const path = yield* Effect.try({
      try: () => decodeMaskToSVGPath(mask.mask),
      catch: () => failure("uncertain", "SAM returned an undecodable mask."),
    });

    const pdfCorners = [
      point(box.left, box.top),
      point(box.right, box.top),
      point(box.right, box.bottom),
      point(box.left, box.bottom),
    ] as const;

    const xs = pdfCorners.map((corner) => corner.x);
    const ys = pdfCorners.map((corner) => corner.y);
    const pixels = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    instances.push({
      id: box.objectId,
      confidence: box.confidence ?? null,
      sourcePixelsInclusive: { ...pixels, right: box.right - 1, bottom: box.bottom - 1 },
      pixels,
      pdfCorners,
      pdfBounds: {
        left: Math.min(...xs),
        top: Math.min(...ys),
        right: Math.max(...xs),
        bottom: Math.max(...ys),
      },
      mask: {
        ...mask.mask,
        bounds: mask.bounds,
        confidence: mask.confidence ?? null,
        path,
      },
    });
  }

  return instances;
});

async function responseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      length += part.value.byteLength;

      if (length > maxResponseBytes) {
        await reader.cancel();
        throw failure("uncertain", "SAM response exceeded its bounded receipt size.");
      }

      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Separately admitted SAM calls propose geometry and never mutate accepted facts or findings. */
export class ReviewSegmentation extends Context.Service<
  ReviewSegmentation,
  {
    readonly segment: (
      fence: ExecutionFence,
      request: SamInspectionRequest,
    ) => Effect.Effect<SamObservation, ExecutionError>;
    readonly list: (
      projectId: typeof ProjectId.Type,
    ) => Effect.Effect<ReadonlyArray<SamObservation>, ExecutionError>;
  }
>()("moke/ReviewSegmentation") {
  /** One parent-owned runtime supplies cancellation and callbacks; this layer starts no runtime. */
  static layer(config: ReviewSegmentationConfiguration) {
    return Layer.sync(ReviewSegmentation, () => {
      const connection = SqliteClient.layer({ filename: join(config.dataDirectory, "app.sqlite") });

      const query = <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA foreign_keys=ON`;
            yield* sql`PRAGMA synchronous=FULL`;
            yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ foreign_keys: Schema.Literal(1) })]),
            )(yield* sql`PRAGMA foreign_keys`);
            yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ synchronous: Schema.Literal(2) })]),
            )(yield* sql`PRAGMA synchronous`);

            return yield* sql.withTransaction(operation);
          }).pipe(Effect.provide(connection)),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof ExecutionError
              ? error
              : failure("storage", "SAM evidence could not be read or saved."),
          ),
          Semaphore.withPermit(config.queries),
          Effect.uninterruptible,
        );

      const attempt = Effect.fn("ReviewSegmentation.attempt")(function* (operationId: string) {
        const sql = yield* SqlClient.SqlClient;

        return (yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
          yield* sql`SELECT input_fingerprint,fingerprint,status,result_json FROM review_sam_attempts WHERE operation_id=${operationId}`,
        ))[0];
      });

      const checkFence = Effect.fn("ReviewSegmentation.checkFence")(function* (
        fence: ExecutionFence,
        artifactId: string,
      ) {
        yield* config.owner.assertHeld.pipe(
          Effect.mapError(() =>
            failure("conflict", "SAM data directory ownership is no longer held."),
          ),
        );
        const sql = yield* SqlClient.SqlClient;

        const run = (yield* Schema.decodeUnknownEffect(Schema.Array(RunRecord))(
          yield* sql`SELECT * FROM review_execution_runs WHERE run_id=${fence.runId} AND project_id=${fence.projectId}`,
        ))[0];

        const scope = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              sourceVersion: Schema.Int,
              factVersion: Schema.Int,
              artifact: Schema.String,
            }),
          ),
        )(
          yield* sql`SELECT json_extract(p.payload,'$.sourceVersion') AS sourceVersion,json_extract(p.payload,'$.factVersion') AS factVersion,a.payload AS artifact FROM review_projects p JOIN review_records f ON f.project_id=p.id AND f.id=${fence.findingId} AND f.kind='finding' JOIN review_records a ON a.project_id=p.id AND a.id=${artifactId} AND a.kind='artifact' WHERE p.id=${fence.projectId} AND json_extract(a.payload,'$.mediaType')='image/png' AND json_extract(a.payload,'$.sheetId') IN (json_extract(f.payload,'$.drawnSheetId'),json_extract(f.payload,'$.scheduledSheetId'))`,
        );

        const selected = scope[0];

        if (
          run === undefined ||
          selected === undefined ||
          config.owner.generation !== fence.ownerGeneration ||
          run.finding_id !== fence.findingId ||
          run.journal_id !== fence.journalId ||
          run.owner_generation !== fence.ownerGeneration ||
          (run.state !== "running" && run.state !== "pausing") ||
          run.source_version !== fence.sourceVersion ||
          run.fact_version !== fence.factVersion ||
          selected.sourceVersion !== fence.sourceVersion ||
          selected.factVersion !== fence.factVersion
        )
          return yield* failure(
            "conflict",
            "SAM execution, source, accepted facts, or owner is no longer current.",
          );

        if (run.route === "offline" || (run.route === "recorded" && config.transport === undefined))
          return yield* failure(
            "unavailable",
            "SAM requires live execution or an injected recorded transport.",
          );

        return {
          run,
          artifact: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Artifact))(
            selected.artifact,
          ),
        };
      });

      const uncertain = Effect.fn("ReviewSegmentation.uncertain")(function* (
        fence: ExecutionFence,
      ) {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE review_execution_runs SET state='uncertain',version=version+1 WHERE run_id=${fence.runId} AND project_id=${fence.projectId} AND state NOT IN ('cancelled','uncertain')`;
        yield* sql`INSERT INTO review_execution_events(run_id,project_id,state,version) SELECT run_id,project_id,state,version FROM review_execution_runs WHERE run_id=${fence.runId} AND project_id=${fence.projectId}`;
      });

      const replay = Effect.fn("ReviewSegmentation.replay")(function* (
        saved: typeof Attempt.Type,
        inputFingerprint: string,
        fence: ExecutionFence,
      ) {
        if (saved.input_fingerprint !== inputFingerprint)
          return yield* failure(
            "conflict",
            "This SAM operation identity was already used with different inputs.",
          );

        if (saved.status !== "completed" || saved.result_json === null) {
          yield* query(uncertain(fence));

          return yield* failure(
            "uncertain",
            "A SAM intent already exists with an unresolved outcome. No repeat request was sent.",
          );
        }

        const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SamObservation))(
          saved.result_json,
        ).pipe(Effect.mapError(() => failure("storage", "The SAM receipt could not be decoded.")));

        if (result.recordedAs === "historical")
          return yield* failure(
            "conflict",
            "The SAM response was retained historically after its execution fence changed.",
          );

        return result;
      });

      const segment = Effect.fn("ReviewSegmentation.segment")(function* (
        rawFence: ExecutionFence,
        rawRequest: SamInspectionRequest,
      ) {
        const fence = yield* Schema.decodeUnknownEffect(ExecutionFence)(rawFence).pipe(
          Effect.mapError(() => failure("input", "Invalid SAM execution fence.")),
        );

        const request = yield* Schema.decodeUnknownEffect(SamInspectionRequest)(rawRequest).pipe(
          Effect.mapError(() => failure("input", "Invalid SAM guidance.")),
        );

        // Owner generation is a dispatch fence, not part of the semantic receipt identity.
        const inputFingerprint = sha256(
          JSON.stringify({
            runId: fence.runId,
            projectId: fence.projectId,
            findingId: fence.findingId,
            journalId: fence.journalId,
            sourceVersion: fence.sourceVersion,
            factVersion: fence.factVersion,
            request,
            route,
            model,
            parserVersion,
          }),
        );

        const previous = yield* query(attempt(fence.commandId));

        if (previous !== undefined) return yield* replay(previous, inputFingerprint, fence);
        const selected = yield* query(checkFence(fence, request.artifactId));

        const artifact = yield* config.loadArtifact(fence.projectId, request.artifactId).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Artifact)),
          Effect.mapError((error) =>
            error instanceof ExecutionError
              ? error
              : failure("input", "Invalid SAM source artifact."),
          ),
        );

        if (JSON.stringify(artifact) !== JSON.stringify(selected.artifact))
          return yield* failure(
            "conflict",
            "SAM source artifact differs from its project manifest.",
          );

        const image = yield* config.readImage(artifact).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ExecutionImage)),
          Effect.mapError((error) =>
            error instanceof ExecutionError
              ? error
              : failure("input", "SAM source image could not be loaded."),
          ),
        );

        if (
          image.artifactId !== artifact.id ||
          image.projectId !== fence.projectId ||
          image.sheetId !== artifact.sheetId ||
          Buffer.byteLength(image.data, "base64") > 1024 * 1024
        )
          return yield* failure(
            "input",
            "SAM source image is outside the selected artifact or byte limit.",
          );
        const prompt = yield* promptFor(request, image);
        const submittedSha256 = sha256(Buffer.from(image.data, "base64"));

        const body = JSON.stringify({
          model,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
              ],
            },
          ],
          stream: false,
          metadata: { include_confidence: "true", mask_encoding: "one_bit" },
        });

        const fingerprint = sha256(
          JSON.stringify({
            inputFingerprint,
            sourceSha256: artifact.sha256,
            submittedSha256,
            width: image.width,
            height: image.height,
            pdfToPixels: image.pdfToPixels,
            pixelsToPdf: image.pixelsToPdf,
            body,
          }),
        );

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const raced = yield* query(
              Effect.gen(function* () {
                const existing = yield* attempt(fence.commandId);

                if (existing !== undefined) return existing;

                const { run, artifact: currentArtifact } = yield* checkFence(
                  fence,
                  request.artifactId,
                );

                if (currentArtifact.sha256 !== artifact.sha256)
                  return yield* failure(
                    "conflict",
                    "SAM source artifact changed before admission.",
                  );
                const sql = yield* SqlClient.SqlClient;

                const counts = yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ n: Schema.Int })),
                )(
                  yield* sql`SELECT count(*) AS n FROM review_sam_attempts WHERE run_id=${fence.runId}`,
                );

                if (run.admitted_calls >= run.max_calls || (counts[0]?.n ?? 0) >= 2)
                  return yield* failure(
                    "budget",
                    "SAM requires a remaining shared call and permits at most two calls per run.",
                  );
                yield* sql`INSERT INTO review_sam_attempts(operation_id,run_id,project_id,finding_id,source_artifact_id,journal_id,owner_generation,source_version,fact_version,input_fingerprint,fingerprint,request_json,status,sent) VALUES (${fence.commandId},${fence.runId},${fence.projectId},${fence.findingId},${request.artifactId},${fence.journalId},${fence.ownerGeneration},${fence.sourceVersion},${fence.factVersion},${inputFingerprint},${fingerprint},${body},'uncertain',0)`;
                yield* sql`UPDATE review_execution_runs SET admitted_calls=admitted_calls+1 WHERE run_id=${fence.runId}`;

                return undefined;
              }),
            );

            if (raced !== undefined) return yield* replay(raced, inputFingerprint, fence);

            return yield* restore(
              Effect.gen(function* () {
                yield* query(
                  Effect.gen(function* () {
                    yield* checkFence(fence, request.artifactId);
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`UPDATE review_sam_attempts SET sent=1 WHERE operation_id=${fence.commandId} AND sent=0 AND status='uncertain'`;
                  }),
                );
                const transport = config.transport ?? fetch;

                const response = yield* Effect.tryPromise({
                  try: async (signal) => {
                    const received = await transport(route, {
                      method: "POST",
                      redirect: "error",
                      headers: {
                        Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
                        "Content-Type": "application/json",
                      },
                      body,
                      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
                    });

                    // Keep the Effect abort signal attached until the body finishes too.
                    return {
                      status: received.status,
                      ok: received.ok,
                      body: await responseText(received),
                    };
                  },
                  catch: () =>
                    failure(
                      "uncertain",
                      "SAM request failed or timed out. No automatic retry was sent.",
                    ),
                });

                const raw = response.body;

                const responseId = Schema.decodeUnknownOption(ResponseIdentity)(raw).pipe(
                  Option.map((identity) => identity.id),
                  Option.getOrNull,
                );

                yield* query(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`UPDATE review_sam_attempts SET response_id=${responseId},response_status=${response.status},response_body=${raw} WHERE operation_id=${fence.commandId}`;
                  }),
                );

                if (!response.ok)
                  return yield* failure("uncertain", "SAM returned an unsuccessful HTTP response.");

                const parsed = yield* Schema.decodeUnknownEffect(ResponseBody)(raw).pipe(
                  Effect.mapError(() =>
                    failure("uncertain", "SAM did not return a complete image response."),
                  ),
                );

                const instances = yield* parseInstances(parsed.output[0].content[0].text, image);

                const result = yield* query(
                  Effect.gen(function* () {
                    const current = yield* Effect.result(checkFence(fence, request.artifactId));

                    const observation = new SamObservation({
                      operationId: fence.commandId,
                      runId: fence.runId,
                      projectId: fence.projectId,
                      findingId: fence.findingId,
                      sourceArtifactId: artifact.id,
                      sourceVersion: fence.sourceVersion,
                      factVersion: fence.factVersion,
                      sourceSha256: artifact.sha256,
                      submittedSha256,
                      width: image.width,
                      height: image.height,
                      pdfToPixels: image.pdfToPixels,
                      pixelsToPdf: image.pixelsToPdf,
                      responseId: parsed.id,
                      route,
                      model,
                      parserVersion,
                      prompt: request.prompt,
                      promptSha256: sha256(prompt),
                      fingerprint,
                      recordedAs: Result.isSuccess(current) ? "proposal" : "historical",
                      instances,
                      costUsd: null,
                      imageInputTokens: null,
                      inputTokens: null,
                      outputTokens: null,
                    });

                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`UPDATE review_sam_attempts SET status='completed',response_id=${parsed.id},result_json=${JSON.stringify(observation)} WHERE operation_id=${fence.commandId}`;

                    return observation;
                  }),
                );

                if (result.recordedAs === "historical")
                  return yield* failure(
                    "conflict",
                    "SAM response was retained historically because its execution fence changed.",
                  );

                return result;
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? query(uncertain(fence)) : Effect.void,
              ),
            );
          }),
        );
      });

      const list = Effect.fn("ReviewSegmentation.list")(function* (
        projectId: typeof ProjectId.Type,
      ) {
        const id = yield* Schema.decodeUnknownEffect(ProjectId)(projectId).pipe(
          Effect.mapError(() => failure("input", "Invalid SAM project identity.")),
        );

        return yield* query(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ result_json: Schema.String })),
            )(
              yield* sql`SELECT result_json FROM review_sam_attempts WHERE project_id=${id} AND status='completed' ORDER BY rowid`,
            );

            return yield* Effect.forEach(rows, (row) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(SamObservation))(row.result_json),
            );
          }),
        );
      });

      return ReviewSegmentation.of({ segment, list });
    });
  }
}
