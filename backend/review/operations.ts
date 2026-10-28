import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import {
  Artifact, ArtifactChunk, ArtifactId, CommandId, OperationId,
  Affine, RenderSource, ReviewInputError, ReviewError,
} from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import type { Documents } from "../documents/documents.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import { ExecutionEvidence, ExecutionImage, type ExecutionPort } from "./execution-port.ts";
import { invertTransform } from "#lib/review/geometry.ts";
import { AgentMutation, ReviewStore } from "./store.ts";

/** Domain SQL is scoped by the application, while processing stays outside its query permit. */
export interface ReviewOperationsConfiguration {
  readonly query: <A>(operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>) => Effect.Effect<A, typeof ReviewError.Type>;
  readonly documents: Documents["Service"] | undefined;
  readonly owner: DataDirectoryOwnership["Service"];
}

/** Compose reviewer operations and the narrower model-tool port from the same domain policy. */
export function createReviewOperations(config: ReviewOperationsConfiguration) {
  const { query, owner } = config;
  const snapshot = (projectId: Parameters<ReviewStore["Service"]["snapshot"]>[0], afterSequence: number) => query(Effect.flatMap(ReviewStore, (store) => store.snapshot(projectId, afterSequence)));
  const unavailable = () => new ReviewInputError({ message: "PDF processing is not configured for this launch." });

  const render = Effect.fn("Review.render")(function* (request: typeof RenderSource.Type) {
    if (config.documents === undefined) return yield* unavailable();
    const state = yield* snapshot(request.projectId, 0);
    const previous = state.artifacts.find((artifact) => artifact.operationId === request.operationId);

    if (previous !== undefined) {
      if (previous.sheetId !== request.sheetId || previous.dpi !== request.dpi || JSON.stringify(previous.region) !== JSON.stringify(request.region)) return yield* new ReviewInputError({ message: "A render operation cannot be reused for different source inputs." });

      return previous;
    }

    const sheet = state.sheets.find((item) => item.id === request.sheetId);
    const original = state.revisions.find((revision) => revision.id === sheet?.revisionId);

    if (sheet === undefined || original === undefined) return yield* new ReviewInputError({ message: "The source sheet is outside this project." });
    const result = yield* config.documents.render(original.sha256, sheet, request.region, request.dpi);
    const artifact = new Artifact({ ...result, id: Schema.decodeUnknownSync(ArtifactId)(randomUUID()), projectId: request.projectId, revisionId: original.id, sheetId: sheet.id, mediaType: "image/png", operationId: request.operationId });

    return artifact;
  });

  const source = (request: typeof RenderSource.Type) => render(request).pipe(Effect.flatMap((artifact) => query(Effect.flatMap(ReviewStore, (store) => store.saveRender(artifact)))));

  const chunk = Effect.fn("Review.chunk")(function* (request: { readonly projectId: Artifact["projectId"]; readonly artifactId: Artifact["id"]; readonly offset: number; readonly limit: number }) {
    if (config.documents === undefined) return yield* unavailable();
    const artifact = yield* query(Effect.flatMap(ReviewStore, (store) => store.artifact(request.projectId,request.artifactId)));
    const result = yield* config.documents.read(artifact.sha256,artifact.mediaType,request.offset,request.limit);

    return new ArtifactChunk({ artifactId: artifact.id, offset: request.offset, ...result });
  });

  const importPdf = Effect.fn("Review.importPdf")(function* (request: { readonly commandId: typeof CommandId.Type; readonly projectId: Artifact["projectId"]; readonly expectedVersion: number; readonly source: string; readonly name: string }) {
    if (config.documents === undefined) return yield* unavailable();
    const imported = yield* config.documents.importPdf(request.source);

    return yield* query(Effect.flatMap(ReviewStore, (store) => store.importPdf({ commandId: request.commandId, projectId: request.projectId, expectedVersion: request.expectedVersion, name: request.name }, imported)));
  });

  const toExecution = <A>(operation: Effect.Effect<A, typeof ReviewError.Type>) => operation.pipe(Effect.mapError((error) => new ExecutionError({ reason: Schema.is(ReviewInputError)(error) ? "input" : "conflict", message: error.message })));

  const own = Effect.fn("Review.owner")(function* (generation: string) {
    yield* owner.assertHeld.pipe(Effect.mapError(() => new ExecutionError({ reason: "conflict", message: "Execution ownership is no longer held." })));

    if (generation !== owner.generation) return yield* new ExecutionError({ reason: "conflict", message: "Execution belongs to another ownership generation." });
  });

  const port: ExecutionPort = {
    readImage: (artifact) => toExecution(Effect.gen(function* () {
      if (config.documents === undefined || artifact.sheetId === null || artifact.mediaType !== "image/png" || artifact.byteLength > 16 * 1024 * 1024) return yield* new ReviewInputError({ message: "The selected evidence is not a bounded source image." });
      const chunks: Array<Buffer> = [];

      for (let offset = 0; offset < artifact.byteLength; offset += 256 * 1024) {
        const result = yield* config.documents.read(artifact.sha256,"image/png",offset,256 * 1024);
        chunks.push(Buffer.from(result.base64,"base64"));
      }

      const converted = yield* Effect.tryPromise({
        try: async () => {
          const image = new Bun.Image(Buffer.concat(chunks));
          const metadata = await image.metadata();
          const scale = Math.min(1,2048 / Math.max(metadata.width,metadata.height));
          const width = Math.max(1,Math.round(metadata.width * scale));
          const height = Math.max(1,Math.round(metadata.height * scale));
          const data = await image.resize(width,height).png().toBuffer();

          return { data: Buffer.from(data), width, height };
        },
        catch: () => new ReviewInputError({ message: "The selected evidence image could not be prepared." }),
      });

      if (converted.data.byteLength > 1024 * 1024) return yield* new ReviewInputError({ message: "Choose a smaller source region for this model inspection." });
      const [a,b,c,d,e,f] = artifact.pdfToPixels;
      const sx = converted.width / artifact.width;
      const sy = converted.height / artifact.height;
      const pdfToPixels = Schema.decodeUnknownSync(Affine)([a*sx,b*sy,c*sx,d*sy,e*sx,f*sy]);
      const pixelsToPdf = invertTransform(pdfToPixels);

      if (pixelsToPdf instanceof ReviewInputError) return yield* pixelsToPdf;

      return new ExecutionImage({ artifactId: artifact.id, projectId: artifact.projectId, sheetId: artifact.sheetId, mimeType: "image/png", data: converted.data.toString("base64"), width: converted.width, height: converted.height, pdfToPixels,pixelsToPdf });
    })),
    inspect: (selection) => toExecution(Effect.gen(function* () {
      const state = yield* snapshot(selection.projectId,0);
      const project = state.project;
      const finding = state.findings.find((item) => item.id === selection.findingId);

      if (project === null || finding === undefined) return yield* new ReviewInputError({ message: "The finding is outside the selected project." });
      const allowed = new Set([finding.drawnSheetId,finding.scheduledSheetId]);

      return new ExecutionEvidence({ sourceVersion: project.sourceVersion, factVersion: project.factVersion, finding,
        sheets: state.sheets.filter((sheet) => allowed.has(sheet.id)),
        facts: state.facts.filter((fact) => fact.findingId === finding.id),
        checks: state.checks.filter((check) => check.findingId === finding.id),
        artifacts: state.artifacts.filter((artifact) => artifact.sheetId !== null && allowed.has(artifact.sheetId)),
      });
    })),
    render: (fence, detail) => Effect.gen(function* () {
      yield* own(fence.ownerGeneration);
      const artifact = yield* toExecution(render({ projectId: fence.projectId, sheetId: detail.sheetId, operationId: Schema.decodeUnknownSync(OperationId)(fence.commandId), region: detail.region, dpi: 300 }));
      const mutation = Schema.decodeUnknownSync(AgentMutation)(AgentMutation.cases.Render.make({detail,
artifact}));
      const receipt = yield* toExecution(query(Effect.flatMap(ReviewStore, (store) => store.agent(fence,mutation))));

      return yield* toExecution(query(Effect.flatMap(ReviewStore, (store) => store.artifact(fence.projectId,Schema.decodeUnknownSync(ArtifactId)(receipt.entityId)))));
    }),
    propose: (fence, proposal) => own(fence.ownerGeneration).pipe(Effect.andThen(toExecution(query(Effect.flatMap(ReviewStore, (store) => store.agent(fence, Schema.decodeUnknownSync(AgentMutation)(AgentMutation.cases.Propose.make({proposal})))))))),
    evaluate: (fence) => Effect.gen(function* () {
      yield* own(fence.ownerGeneration);
      const receipt = yield* toExecution(query(Effect.flatMap(ReviewStore, (store) => store.agent(fence,Schema.decodeUnknownSync(AgentMutation)(AgentMutation.cases.Evaluate.make({}))))));
      const state = yield* toExecution(snapshot(fence.projectId,0));
      const check = state.checks.find((item) => item.id === receipt.entityId);

      if (check === undefined) return yield* new ExecutionError({ reason: "storage", message: "The stored evaluation could not be read." });

      return check;
    }),
    message: (fence, text) => own(fence.ownerGeneration).pipe(Effect.andThen(toExecution(query(Effect.flatMap(ReviewStore, (store) => store.agent(fence,Schema.decodeUnknownSync(AgentMutation)(AgentMutation.cases.Message.make({text})))))))),
  };

  return {
    snapshot,
    command: (command: Parameters<ReviewStore["Service"]["execute"]>[0]) => query(Effect.flatMap(ReviewStore,(store) => store.execute(command))),
    render: source, chunk, importPdf, port,
  };
}
