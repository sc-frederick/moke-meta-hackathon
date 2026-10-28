import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCanvas } from "@napi-rs/canvas";
import { Effect, ManagedRuntime, Redacted, Result, Schema, Semaphore } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewSegmentation, type SamTransport } from "../backend/inference/segmentation.ts";
import { DataDirectoryOwnership } from "../backend/ownership.ts";
import { ExecutionFence, ExecutionImage } from "../backend/review/execution-port.ts";
import { Artifact } from "../src/lib/review/contracts.ts";
import { SamInspectionRequest } from "../src/lib/review/segmentation.ts";

// Public parser conformance fixture retained in tests/reconciliation.test.ts.
const oneBitMask = "<|mask;x=0;y=0;c=0.8;data=1,1,!!!!!&O.lVP|>";

function instance(id = 1, box = "x1=211;y1=228;x2=270;y2=254") {
  return `<0f>${id}<|box;${box};w=320;h=334;c=0.9|>${oneBitMask}`;
}

function response(text = instance(), status = "completed") {
  return Response.json({
    id: "sam-fixture-response",
    status,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });
}

interface Options {
  readonly transport?: SamTransport;
  readonly readImage?: (image: ExecutionImage) => Effect.Effect<ExecutionImage>;
  readonly pixelsToPdf?: ExecutionImage["pixelsToPdf"];
  readonly pdfToPixels?: ExecutionImage["pdfToPixels"];
}

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "review-sam-"));
  const filename = join(directory, "app.sqlite");
  const database = new Database(filename);
  database.exec("PRAGMA foreign_keys=ON");

  for (const migration of [
    "0001_notes.sql",
    "0002_reviews.sql",
    "0003_review_execution.sql",
    "0004_sam_observations.sql",
  ]) {
    database.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }

  const ownerRuntime = ManagedRuntime.make(DataDirectoryOwnership.layer(directory));
  const owner = await ownerRuntime.runPromise(DataDirectoryOwnership);
  const queries = Semaphore.makeUnsafe(1);

  const fence = Schema.decodeUnknownSync(ExecutionFence)({
    runId: randomUUID(),
    projectId: randomUUID(),
    findingId: randomUUID(),
    journalId: randomUUID(),
    ownerGeneration: owner.generation,
    sourceVersion: 0,
    factVersion: 0,
    commandId: randomUUID(),
  });

  const artifact = Schema.decodeUnknownSync(Artifact)({
    id: randomUUID(),
    projectId: fence.projectId,
    revisionId: randomUUID(),
    sheetId: randomUUID(),
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 500,
    width: 640,
    height: 668,
    region: { x: 20, y: 30, width: 160, height: 167 },
    dpi: 300,
    pdfToPixels: [4, 0, 0, -4, -80, 788],
    pixelsToPdf: [0.25, 0, 0, -0.25, 20, 197],
    operationId: randomUUID(),
  });

  const data = createCanvas(320, 334).toBuffer("image/png").toString("base64");

  const image = new ExecutionImage({
    artifactId: artifact.id,
    projectId: fence.projectId,
    sheetId: Schema.decodeUnknownSync(ExecutionImage.fields.sheetId)(artifact.sheetId),
    mimeType: "image/png",
    data,
    width: 320,
    height: 334,
    pdfToPixels: options.pdfToPixels ?? [2, 0, 0, -2, -40, 394],
    pixelsToPdf: options.pixelsToPdf ?? [0.5, 0, 0, -0.5, 20, 197],
  });

  const request = Schema.decodeUnknownSync(SamInspectionRequest)({
    artifactId: artifact.id,
    prompt: { kind: "concept", text: "door" },
  });

  const project = { id: fence.projectId, sourceVersion: 0, factVersion: 0 };
  database
    .query("INSERT INTO review_projects VALUES (?,0,?)")
    .run(fence.projectId, JSON.stringify(project));
  database.query("INSERT INTO review_records VALUES (?,?,'finding',?)").run(
    fence.projectId,
    fence.findingId,
    JSON.stringify({
      id: fence.findingId,
      projectId: fence.projectId,
      drawnSheetId: image.sheetId,
      scheduledSheetId: randomUUID(),
    }),
  );
  database
    .query("INSERT INTO review_records VALUES (?,?,'artifact',?)")
    .run(fence.projectId, artifact.id, JSON.stringify(artifact));
  database
    .query(
      "INSERT INTO review_execution_runs VALUES (?,?,?,?,?,?,?,?,'running',0,'live','meta','muse-spark-1.3',10,64000,8192,0,0,0)",
    )
    .run(
      fence.runId,
      fence.projectId,
      fence.findingId,
      fence.journalId,
      "review-pi-1.4.0-v1",
      owner.generation,
      0,
      0,
    );
  const sends: Array<{ url: string; body: string; authorization: string | null }> = [];
  let reads = 0;

  const config = {
    dataDirectory: directory,
    queries,
    owner,
    apiKey: Redacted.make("sam-secret-never-in-receipt"),
    loadArtifact: () => Effect.succeed(artifact),
    readImage: () =>
      Effect.gen(function* () {
        // Acquiring the same permit would hang if image processing retained a SQL permit.
        yield* Effect.void.pipe(Semaphore.withPermit(queries));
        reads++;

        return yield* options.readImage?.(image) ?? Effect.succeed(image);
      }),
    transport: async (url: string, init: RequestInit) => {
      await Effect.runPromise(Effect.void.pipe(Semaphore.withPermit(queries)));
      sends.push({
        url,
        body: Schema.decodeUnknownSync(Schema.String)(init.body),
        authorization: new Headers(init.headers).get("Authorization"),
      });

      return options.transport === undefined ? response() : options.transport(url, init);
    },
  };

  let runtime = ManagedRuntime.make(ReviewSegmentation.layer(config));

  const segment = (selected = fence, guidance = request) =>
    runtime.runPromise(
      Effect.flatMap(ReviewSegmentation, (service) => service.segment(selected, guidance)),
    );

  const result = (selected = fence, guidance = request) =>
    runtime.runPromise(
      Effect.flatMap(ReviewSegmentation, (service) =>
        Effect.result(service.segment(selected, guidance)),
      ),
    );

  const list = () =>
    runtime.runPromise(
      Effect.flatMap(ReviewSegmentation, (service) => service.list(fence.projectId)),
    );

  const cancellable = (signal: AbortSignal) =>
    runtime.runPromiseExit(
      Effect.flatMap(ReviewSegmentation, (service) => service.segment(fence, request)),
      { signal },
    );

  return {
    database,
    fence,
    artifact,
    image,
    request,
    sends,
    segment,
    result,
    list,
    cancellable,
    get reads() {
      return reads;
    },
    async reopen() {
      await runtime.dispose();
      runtime = ManagedRuntime.make(ReviewSegmentation.layer(config));
    },
    async close() {
      await runtime.dispose();
      await ownerRuntime.dispose();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each([0, 1, 2])(
  "persists %i official-parser proposals, exact request, and unknown accounting",
  async (count) => {
    const f = await fixture({
      transport: async () =>
        response(Array.from({ length: count }, (_, i) => instance(i + 1)).join("\n")),
    });

    try {
      const observation = await f.segment();
      expect(observation.instances).toHaveLength(count);
      expect(observation.recordedAs).toBe("proposal");
      expect(observation.sourceSha256).toBe(f.artifact.sha256);
      expect(observation.submittedSha256).toBe(
        createHash("sha256").update(Buffer.from(f.image.data, "base64")).digest("hex"),
      );
      expect(observation.width).toBe(320);
      expect(observation.height).toBe(334);
      expect(observation.inputTokens).toBeNull();
      expect(observation.outputTokens).toBeNull();
      expect(observation.imageInputTokens).toBeNull();
      expect(observation.costUsd).toBeNull();
      const [send] = f.sends;
      expect(send?.url).toBe("https://api.meta.ai/v1/responses");
      expect(send?.authorization).toBe("Bearer sam-secret-never-in-receipt");
      const row = f.database.query("SELECT * FROM review_sam_attempts").get();
      expect(row).toMatchObject({
        status: "completed",
        sent: 1,
        response_id: "sam-fixture-response",
        request_json: send?.body,
      });
      expect(JSON.stringify(row)).not.toContain("sam-secret-never-in-receipt");
      expect(JSON.parse(send?.body ?? "{}")).toMatchObject({
        model: "sam-3.1",
        stream: false,
        metadata: { include_confidence: "true", mask_encoding: "one_bit" },
        input: [
          {
            content: [
              { type: "input_text", text: "door" },
              { image_url: `data:image/png;base64,${f.image.data}` },
            ],
          },
        ],
      });
      expect(await f.list()).toEqual([observation]);
      expect(
        f.database
          .query(
            "SELECT admitted_calls,reserved_input_tokens,reserved_output_tokens FROM review_execution_runs",
          )
          .get(),
      ).toEqual({ admitted_calls: 1, reserved_input_tokens: 0, reserved_output_tokens: 0 });
    } finally {
      await f.close();
    }
  },
);

test("preserves inclusive edge pixels, independent mask dimensions, and rotated inverse maps", async () => {
  const f = await fixture({
    transport: async () => response(instance(1, "x1=319;y1=333;x2=319;y2=333")),
    // Rotation, nonzero crop origin, resize and UserUnit are already composed by readImage.
    pixelsToPdf: [0, 2, -3, 0, 1100, -40],
    pdfToPixels: [0, -1 / 3, 1 / 2, 0, 20, 1100 / 3],
  });

  try {
    const result = await f.segment();
    const [proposal] = result.instances;
    expect(proposal?.sourcePixelsInclusive).toEqual({
      left: 319,
      top: 333,
      right: 319,
      bottom: 333,
    });
    expect(proposal?.pixels).toEqual({ left: 319, top: 333, right: 320, bottom: 334 });
    expect(proposal?.pdfCorners).toEqual([
      { x: 101, y: 598 },
      { x: 101, y: 600 },
      { x: 98, y: 600 },
      { x: 98, y: 598 },
    ]);
    expect(proposal?.pdfBounds).toEqual({ left: 98, top: 598, right: 101, bottom: 600 });
    expect(proposal?.confidence).toBe(0.9);
    expect(proposal?.mask).toMatchObject({
      width: 1,
      height: 1,
      encoding: "one_bit",
      confidence: 0.8,
      bounds: { left: 319, top: 333, right: 320, bottom: 334 },
    });
    expect(proposal?.mask.path.length).toBeGreaterThan(0);
    expect(result.pdfToPixels).toEqual(f.image.pdfToPixels);
    expect(result.pixelsToPdf).toEqual(f.image.pixelsToPdf);
  } finally {
    await f.close();
  }
});

test.each(["paused", "cancelled", "oldgeneration"])(
  "replays completed receipt before %s freshness checks and image loading",
  async (state) => {
    const f = await fixture();

    try {
      const original = await f.segment();

      if (state === "oldgeneration")
        f.database.query("UPDATE review_execution_runs SET owner_generation=?").run(randomUUID());
      else f.database.query("UPDATE review_execution_runs SET state=?").run(state);
      f.database
        .query("UPDATE review_projects SET payload=json_set(payload,'$.factVersion',5)")
        .run();
      await f.reopen();
      expect(await f.segment()).toEqual(original);
      expect(f.reads).toBe(1);
      expect(f.sends).toHaveLength(1);

      const different = await f.result(f.fence, {
        ...f.request,
        prompt: { kind: "concept", text: "window" },
      });

      expect(Result.isFailure(different) && different.failure.reason).toBe("conflict");
    } finally {
      await f.close();
    }
  },
);

test.each([0, 1])(
  "unresolved sent=%i intent survives reopen without another send",
  async (sent) => {
    const f = await fixture({
      transport: async () => {
        throw new Error("private connection failure");
      },
    });

    try {
      const first = await f.result();
      expect(Result.isFailure(first) && first.failure.reason).toBe("uncertain");
      f.database.query("UPDATE review_sam_attempts SET sent=?").run(sent);
      f.database.query("UPDATE review_execution_runs SET state='running'").run();
      await f.reopen();
      const retry = await f.result();
      expect(Result.isFailure(retry) && retry.failure.reason).toBe("uncertain");
      expect(f.sends).toHaveLength(1);
      expect(f.database.query("SELECT state FROM review_execution_runs").get()).toEqual({
        state: "uncertain",
      });
      expect(
        f.database.query("SELECT count(*) AS n FROM review_execution_events").get(),
      ).toMatchObject({ n: 2 });
    } finally {
      await f.close();
    }
  },
);

test.each(["correction", "cancel", "generation", "revision"])(
  "late %s response is historical and cannot promote or replay as current",
  async (change) => {
    let alter = () => {};

    const f = await fixture({
      transport: async () => {
        alter();

        return response();
      },
    });

    alter = () => {
      if (change === "cancel")
        f.database.query("UPDATE review_execution_runs SET state='cancelled'").run();
      else if (change === "generation")
        f.database.query("UPDATE review_execution_runs SET owner_generation=?").run(randomUUID());
      else
        f.database
          .query(
            `UPDATE review_projects SET payload=json_set(payload,'$.${change === "revision" ? "sourceVersion" : "factVersion"}',1)`,
          )
          .run();
    };

    try {
      const result = await f.result();
      expect(Result.isFailure(result) && result.failure.reason).toBe("conflict");
      expect((await f.list())[0]?.recordedAs).toBe("historical");
      expect(
        f.database
          .query(
            "SELECT status,response_id,response_body IS NOT NULL AS has_body FROM review_sam_attempts",
          )
          .get(),
      ).toMatchObject({ status: "completed", response_id: "sam-fixture-response", has_body: 1 });
      expect(f.database.query("SELECT state FROM review_execution_runs").get()).toEqual({
        state: change === "cancel" ? "cancelled" : "uncertain",
      });
      const replay = await f.result();
      expect(Result.isFailure(replay) && replay.failure.reason).toBe("conflict");
      expect(f.sends).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["incomplete", () => response(instance(), "incomplete")],
  ["malformed text", () => response("no issues")],
  ["malformed token", () => response("<0f>1<|box;x1=2|>")],
  ["truncated mask", () => response(instance().replace("!!!!!&O.lVP", "!"))],
  [
    "outside image",
    () => response(instance(1, "x1=319;y1=1;x2=321;y2=2").replace("w=320", "w=640")),
  ],
  ["duplicate instance", () => response(`${instance()}\n${instance()}`)],
  ["provider failure", () => new Response("private error", { status: 403 })],
  ["missing lane", () => Response.json({ id: "x", status: "completed", output: [] })],
])(
  "%s remains uncertain with raw response and never becomes zero-match evidence",
  async (_name, providerResponse) => {
    const f = await fixture({ transport: async () => providerResponse() });

    try {
      const result = await f.result();
      expect(Result.isFailure(result) && result.failure.reason).toBe("uncertain");
      expect(await f.list()).toEqual([]);
      expect(
        f.database
          .query(
            "SELECT status,sent,response_body IS NOT NULL AS has_body FROM review_sam_attempts",
          )
          .get(),
      ).toMatchObject({ status: "uncertain", sent: 1, has_body: 1 });
      expect(f.database.query("SELECT state FROM review_execution_runs").get()).toEqual({
        state: "uncertain",
      });
    } finally {
      await f.close();
    }
  },
);

test.each([
  "project",
  "finding",
  "run",
  "journal",
  "owner",
  "sourceVersion",
  "factVersion",
  "paused",
  "sourceArtifact",
])("rejects invalid %s before admission", async (change) => {
  const f = await fixture();

  try {
    const updates = {
      project: { projectId: randomUUID() },
      finding: { findingId: randomUUID() },
      run: { runId: randomUUID() },
      journal: { journalId: randomUUID() },
      owner: { ownerGeneration: randomUUID() },
      sourceVersion: { sourceVersion: 1 },
      factVersion: { factVersion: 1 },
      paused: {},
      sourceArtifact: {},
    };

    if (change === "paused")
      f.database.query("UPDATE review_execution_runs SET state='paused'").run();

    if (change === "sourceArtifact")
      f.database
        .query(
          "UPDATE review_records SET payload=json_set(payload,'$.sheetId',?) WHERE kind='artifact'",
        )
        .run(randomUUID());

    const selected = Schema.decodeUnknownSync(ExecutionFence)({
      ...Schema.encodeSync(ExecutionFence)(f.fence),
      ...updates[change],
    });

    const result = await f.result(selected);
    expect(Result.isFailure(result) && result.failure.reason).toBe("conflict");
    expect(f.sends).toHaveLength(0);
    expect(f.database.query("SELECT count(*) AS n FROM review_sam_attempts").get()).toEqual({
      n: 0,
    });
  } finally {
    await f.close();
  }
});

test("checks versions again after image preparation, before reserving", async () => {
  let correct = () => {};

  const f = await fixture({
    readImage: (image) =>
      Effect.sync(() => {
        correct();

        return image;
      }),
  });

  correct = () => {
    f.database
      .query("UPDATE review_projects SET payload=json_set(payload,'$.factVersion',1)")
      .run();
  };

  try {
    const result = await f.result();
    expect(Result.isFailure(result) && result.failure.reason).toBe("conflict");
    expect(f.sends).toHaveLength(0);
    expect(f.database.query("SELECT admitted_calls FROM review_execution_runs").get()).toEqual({
      admitted_calls: 0,
    });
  } finally {
    await f.close();
  }
});

test.each(["shared", "sam"])(
  "enforces %s call budget without dispatching a third request",
  async (limit) => {
    const f = await fixture();

    try {
      if (limit === "shared")
        f.database.query("UPDATE review_execution_runs SET max_calls=1").run();
      await f.segment();

      if (limit === "sam")
        await f.segment(
          Schema.decodeUnknownSync(ExecutionFence)({
            ...Schema.encodeSync(ExecutionFence)(f.fence),
            commandId: randomUUID(),
          }),
        );

      const result = await f.result(
        Schema.decodeUnknownSync(ExecutionFence)({
          ...Schema.encodeSync(ExecutionFence)(f.fence),
          commandId: randomUUID(),
        }),
      );

      expect(Result.isFailure(result) && result.failure.reason).toBe("budget");
      expect(f.sends).toHaveLength(limit === "shared" ? 1 : 2);
    } finally {
      await f.close();
    }
  },
);

test("official builder encodes guided half-open boxes and negative points", async () => {
  const f = await fixture();

  try {
    const guided = Schema.decodeUnknownSync(SamInspectionRequest)({
      artifactId: f.artifact.id,
      prompt: {
        kind: "guided",
        box: { left: 10, top: 20, right: 40, bottom: 60 },
        points: [
          { x: 20, y: 40, label: "positive" },
          { x: 30, y: 50, label: "negative" },
        ],
      },
    });

    await f.segment(f.fence, guided);
    expect(f.sends[0]?.body).toContain(
      "<0f>1<|box;x1=10;y1=20;x2=39;y2=59;w=320;h=334|><|point;x=20;y=40;w=320;h=334|>-<|point;x=30;y=50;w=320;h=334|>",
    );
  } finally {
    await f.close();
  }
});

test("out-of-bounds guidance fails before intent and fetch", async () => {
  const f = await fixture();

  try {
    const result = await f.result(f.fence, {
      artifactId: f.artifact.id,
      prompt: { kind: "box", box: { left: 0, top: 0, right: 500, bottom: 500 } },
    });

    expect(Result.isFailure(result) && result.failure.reason).toBe("input");
    expect(f.sends).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("revalidates the committed intent immediately before setting sent=1", async () => {
  const f = await fixture();

  try {
    f.database.exec(
      "CREATE TRIGGER correction_at_admission AFTER INSERT ON review_sam_attempts BEGIN UPDATE review_projects SET payload=json_set(payload,'$.factVersion',1); END",
    );
    const result = await f.result();
    expect(Result.isFailure(result) && result.failure.reason).toBe("conflict");
    expect(f.sends).toHaveLength(0);
    expect(f.database.query("SELECT status,sent FROM review_sam_attempts").get()).toEqual({
      status: "uncertain",
      sent: 0,
    });
    expect(
      f.database.query("SELECT state,admitted_calls FROM review_execution_runs").get(),
    ).toEqual({ state: "uncertain", admitted_calls: 1 });
    await f.reopen();
    const retry = await f.result();
    expect(Result.isFailure(retry) && retry.failure.reason).toBe("uncertain");
    expect(f.sends).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test.each(["headers", "body"])(
  "Effect cancellation aborts transport during %s and persists uncertainty without resending",
  async (phase) => {
    const ready = Promise.withResolvers<void>();
    let aborted = false;

    const f = await fixture({
      transport: async (_url, init) => {
        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
            ready.resolve();
          });
        }

        return new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(new Error("aborted"));
                },
                { once: true },
              );
              ready.resolve();
            },
          }),
        );
      },
    });

    try {
      const controller = new AbortController();
      const pending = f.cancellable(controller.signal);
      await ready.promise;
      f.database.query("UPDATE review_execution_runs SET state='cancelled'").run();
      controller.abort();
      await pending;
      expect(aborted).toBe(true);
      expect(f.database.query("SELECT status,sent FROM review_sam_attempts").get()).toEqual({
        status: "uncertain",
        sent: 1,
      });
      expect(f.database.query("SELECT state FROM review_execution_runs").get()).toEqual({
        state: "cancelled",
      });
      const retry = await f.result();
      expect(Result.isFailure(retry) && retry.failure.reason).toBe("uncertain");
      expect(f.sends).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test("simultaneous delivery shares one intent and sends at most once", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const f = await fixture({
    transport: async () => {
      ready.resolve();
      await release.promise;

      return response();
    },
  });

  try {
    const first = f.result();
    await ready.promise;
    const duplicate = await f.result();
    expect(Result.isFailure(duplicate) && duplicate.failure.reason).toBe("uncertain");
    release.resolve();
    await first;
    expect(f.sends).toHaveLength(1);
    expect(f.database.query("SELECT count(*) AS n FROM review_sam_attempts").get()).toEqual({
      n: 1,
    });
    expect(f.database.query("SELECT admitted_calls FROM review_execution_runs").get()).toEqual({
      admitted_calls: 1,
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

const rotations = [
  {
    rotation: 0,
    map: [2, 0, 0, -2, 40, 80],
    inverse: [0.5, 0, 0, -0.5, -20, 40],
    expected: [
      { x: 40, y: 80 },
      { x: 42, y: 80 },
      { x: 42, y: 78 },
      { x: 40, y: 78 },
    ],
  },
  {
    rotation: 90,
    map: [0, 2, 2, 0, 40, 80],
    inverse: [0, 0.5, 0.5, 0, -40, -20],
    expected: [
      { x: 40, y: 80 },
      { x: 40, y: 82 },
      { x: 42, y: 82 },
      { x: 42, y: 80 },
    ],
  },
  {
    rotation: 180,
    map: [-2, 0, 0, 2, 40, 80],
    inverse: [-0.5, 0, 0, 0.5, 20, -40],
    expected: [
      { x: 40, y: 80 },
      { x: 38, y: 80 },
      { x: 38, y: 82 },
      { x: 40, y: 82 },
    ],
  },
  {
    rotation: 270,
    map: [0, -2, -2, 0, 40, 80],
    inverse: [0, -0.5, -0.5, 0, 40, 20],
    expected: [
      { x: 40, y: 80 },
      { x: 40, y: 78 },
      { x: 38, y: 78 },
      { x: 38, y: 80 },
    ],
  },
] as const satisfies ReadonlyArray<{
  rotation: number;
  map: ExecutionImage["pixelsToPdf"];
  inverse: ExecutionImage["pdfToPixels"];
  expected: ReadonlyArray<{ x: number; y: number }>;
}>;

test.each(rotations)(
  "maps all four corners for $rotation degree source rotation",
  async ({ map, inverse, expected }) => {
    const f = await fixture({
      pixelsToPdf: map,
      pdfToPixels: inverse,
      transport: async () => response(instance(1, "x1=0;y1=0;x2=0;y2=0")),
    });

    try {
      expect((await f.segment()).instances[0]?.pdfCorners).toEqual(expected);
    } finally {
      await f.close();
    }
  },
);

test("offline execution cannot accidentally dispatch live SAM", async () => {
  const f = await fixture();

  try {
    f.database.query("UPDATE review_execution_runs SET route='offline'").run();
    const result = await f.result();
    expect(Result.isFailure(result) && result.failure.reason).toBe("unavailable");
    expect(f.sends).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("rejects a delivered PNG over one MiB before admission", async () => {
  const f = await fixture({
    readImage: (image) =>
      Effect.succeed(
        Schema.decodeUnknownSync(ExecutionImage)({
          ...Schema.encodeSync(ExecutionImage)(image),
          data: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        }),
      ),
  });

  try {
    const result = await f.result();
    expect(Result.isFailure(result) && result.failure.reason).toBe("input");
    expect(f.sends).toHaveLength(0);
    expect(f.database.query("SELECT admitted_calls FROM review_execution_runs").get()).toEqual({
      admitted_calls: 0,
    });
  } finally {
    await f.close();
  }
});
