import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DrawingCrop, sha256 } from "../backend/segmentation/fixtures.ts";
import {
  inventoryReport,
  proposalSvg,
  type InventoryEvidence,
} from "../backend/segmentation/inventory-report.ts";
import {
  FixtureSchedule,
  reconcileFixtures,
  ReconciliationError,
  type InventoryFixture,
} from "../backend/segmentation/reconciliation.ts";
import { overlaySvg } from "../backend/segmentation/report.ts";
import {
  readSegmentation,
  SegmentationCase,
  type Segmentation,
} from "../backend/segmentation/sam.ts";

const Pixel = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Candidates = Schema.Struct({
  fixtures: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["WC", "LAV"]),
      crop: Schema.NonEmptyString,
      room: Schema.NonEmptyString,
      scope: Schema.Literals(["existing", "new", "unclear"]),
      left: Pixel,
      top: Pixel,
      right: Pixel,
      bottom: Pixel,
    }),
  ),
});

const Summary = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      test: SegmentationCase,
      crop: DrawingCrop,
      inputSha256: Schema.String,
      status: Schema.Literals(["prepared", "succeeded", "failed"]),
    }),
  ),
});

const readText = Effect.fn("readInventorySource")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => new ReconciliationError({ message: `Cannot read ${path}.` }),
  });
});

const readBytes = Effect.fn("readInventoryImage")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(path).bytes(),
    catch: () => new ReconciliationError({ message: `Cannot read ${path}.` }),
  });
});

const save = Effect.fn("saveReconciliation")(function* (path: string, text: string) {
  yield* Effect.tryPromise({
    try: () => Bun.write(path, text),
    catch: () => new ReconciliationError({ message: `Cannot write ${path}.` }),
  });
});

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      parseArgs({
        args: Bun.argv.slice(2),
        options: {
          schedule: { type: "string" },
          candidates: { type: "string" },
          run: { type: "string" },
          "schedule-image": { type: "string" },
          output: { type: "string" },
          help: { type: "boolean", default: false },
        },
      }),
    catch: () => new ReconciliationError({ message: "Invalid arguments; use --help." }),
  });

  const { schedule, candidates, run, output, "schedule-image": scheduleImage } = args.values;

  if (args.values.help) {
    console.log(
      "bun run reconcile:fixtures --schedule JSON --candidates JSON --run SAM_RUN --schedule-image PNG --output NEW_HTML\nOffline only. Joins saved Muse candidate boxes to matching SAM requests, verifies input hashes, and compares WC/LAV quantities with the independently read schedule.",
    );

    return;
  }

  if (!schedule || !candidates || !run || !output || !scheduleImage) {
    return yield* new ReconciliationError({
      message: "All source/output arguments are required; use --help.",
    });
  }

  if (
    yield* Effect.tryPromise({
      try: async () =>
        (await Bun.file(output).exists()) || (await Bun.file(`${output}.json`).exists()),
      catch: () => new ReconciliationError({ message: "Cannot inspect output path." }),
    })
  ) {
    return yield* new ReconciliationError({
      message: "Output already exists. Choose a new report path to preserve the prior review.",
    });
  }

  const scheduleText = yield* readText(schedule);
  const candidateText = yield* readText(candidates);
  const summaryText = yield* readText(resolve(run, "summary.json"));

  const scheduleData = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureSchedule))(
    scheduleText,
  ).pipe(Effect.mapError(() => new ReconciliationError({ message: "Invalid schedule JSON." })));

  const candidateData = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Candidates))(
    candidateText,
  ).pipe(Effect.mapError(() => new ReconciliationError({ message: "Invalid candidate JSON." })));

  const summary = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Summary))(
    summaryText,
  ).pipe(Effect.mapError(() => new ReconciliationError({ message: "Invalid SAM summary." })));

  const inventory: Array<InventoryFixture> = [];

  const regions = new Map<
    string,
    { crop: DrawingCrop; bytes: Uint8Array; segmentation: Segmentation | null }
  >();

  for (const [index, candidate] of candidateData.fixtures.entries()) {
    const matches = summary.results.filter((result) => {
      const prompt = result.test.prompt;

      return (
        result.crop.id === candidate.crop &&
        prompt.kind === "box" &&
        prompt.box.left === candidate.left &&
        prompt.box.top === candidate.top &&
        prompt.box.right === candidate.right &&
        prompt.box.bottom === candidate.bottom
      );
    });

    const [result] = matches;

    if (!result || matches.length !== 1) {
      return yield* new ReconciliationError({
        message: `Candidate ${index + 1} has no unique matching SAM request. Preserve candidate-to-request provenance.`,
      });
    }

    let evidence: "available" | "failed" = "failed";
    const bytes = yield* readBytes(resolve(run, "inputs", `${result.crop.id}.png`));

    if (sha256(bytes) !== result.inputSha256) {
      return yield* new ReconciliationError({
        message: `Input image hash differs for ${result.crop.id}.`,
      });
    }

    if (!regions.has(result.crop.id)) {
      regions.set(result.crop.id, { crop: result.crop, bytes, segmentation: null });
    }

    if (result.status === "succeeded") {
      const body = yield* readText(resolve(run, result.test.id, "response.json"));
      const segmentation = yield* readSegmentation({ status: 200, body }, result.crop);

      if (segmentation.objects.length === 1) {
        evidence = "available";
        const objects = segmentation.objects.map((object) => ({ ...object, id: result.test.id }));
        const previous = regions.get(result.crop.id);
        regions.set(result.crop.id, {
          crop: result.crop,
          bytes,
          segmentation: {
            ...segmentation,
            objects: [...(previous?.segmentation?.objects ?? []), ...objects],
          },
        });
      }
    }

    inventory.push({
      id: result.test.id,
      mark: candidate.kind,
      room: candidate.room,
      scope: candidate.scope,
      crop: candidate.crop,
      pdf: result.crop.pdf,
      page: result.crop.page,
      evidence,
      proposal: {
        left: candidate.left,
        top: candidate.top,
        right: candidate.right,
        bottom: candidate.bottom,
      },
    });
  }

  const rows = yield* reconcileFixtures(scheduleData, inventory, ["WC", "LAV"]);

  const evidence: Array<InventoryEvidence> = Array.from(regions.values(), (region) => {
    const boxesSvg = proposalSvg(
      inventory.filter((fixture) => fixture.crop === region.crop.id),
      region.crop,
      region.bytes,
    );

    return {
      id: region.crop.id,
      caption: `${region.crop.pdf} · sheet ${region.crop.sheet} · page ${region.crop.page} · ${region.crop.id}${region.segmentation === null ? " · no usable SAM mask; original proposals only" : ""}`,
      svg:
        region.segmentation === null
          ? boxesSvg
          : overlaySvg(region.segmentation, region.crop, region.bytes),
      boxesSvg,
    };
  });

  const schedulePng = yield* readBytes(scheduleImage);

  const revision = sha256(
    Buffer.from(
      JSON.stringify({
        schedule: scheduleData,
        candidates: candidateData,
        inventory,
        evidence: evidence.map((region) => sha256(Buffer.from(region.svg))),
        scheduleImage: sha256(schedulePng),
      }),
    ),
  );

  yield* save(output, inventoryReport(rows, inventory, evidence, schedulePng, revision));
  yield* save(
    `${output}.json`,
    JSON.stringify(
      {
        revision,
        review: "pending",
        coverage: "Selected restroom regions; WC/LAV only. Not a full-sheet or regulatory review.",
        sources: {
          schedule: resolve(schedule),
          candidates: resolve(candidates),
          samRun: resolve(run),
        },
        rows,
        inventory,
      },
      null,
      2,
    ),
  );
  console.log(`Saved offline reconciliation: ${resolve(output)}`);

  for (const row of rows)
    console.log(
      `${row.mark}: schedule ${row.scheduled}, scoped proposals ${row.proposed ?? "not tested"}, ${row.status}`,
    );
});

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
).catch(() => {
  console.error("Fixture reconciliation stopped unexpectedly.");
  process.exitCode = 1;
});
