import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import {
  Artifact,
  ArtifactChunk,
  ArtifactId,
  CommandId,
  type FindingId,
  OperationId,
  Affine,
  RenderSource,
  ReviewCommand,
  ReviewInputError,
  ReviewError,
  SheetLabelSuggestion,
  SheetLabelSuggestions,
  SuggestSheetLabels,
} from "#lib/review/contracts.ts";
import { ExecutionError } from "#lib/review/execution.ts";
import type { Documents } from "../documents/documents.ts";
import type { DataDirectoryOwnership } from "../ownership.ts";
import { ExecutionEvidence, ExecutionImage, type ExecutionPort } from "./execution-port.ts";
import { validateRenderRequest } from "../documents/render-bounds.ts";
import { renderIdentity } from "../documents/render-identity.ts";
import { invertTransform } from "#lib/review/geometry.ts";
import {
  AgentInput,
  AgentMutation,
  agentCommandFingerprint,
  reviewCommandFingerprint,
  ReviewStore,
} from "./store.ts";

/** Domain SQL is scoped by the application, while processing stays outside its query permit. */
interface ReviewOperationsConfiguration {
  readonly query: <A>(
    operation: Effect.Effect<A, typeof ReviewError.Type, ReviewStore>,
  ) => Effect.Effect<A, typeof ReviewError.Type>;
  readonly documents: Documents["Service"] | undefined;
  readonly owner: DataDirectoryOwnership["Service"];
}

/** Compose reviewer operations and the narrower model-tool port from the same domain policy. */
export function createReviewOperations(config: ReviewOperationsConfiguration) {
  const { query, owner } = config;

  const snapshot = (
    projectId: Parameters<ReviewStore["Service"]["snapshot"]>[0],
    afterSequence: number,
  ) => query(Effect.flatMap(ReviewStore, (store) => store.snapshot(projectId, afterSequence)));

  const unavailable = () =>
    new ReviewInputError({ message: "PDF processing is not configured for this launch." });

  /** Narrow SQL reads plan a render; only a render with no equal stored image reaches PDF.js. */
  const render = Effect.fn("Review.render")(function* (request: typeof RenderSource.Type) {
    const documents = config.documents;

    if (documents === undefined) return yield* unavailable();

    const plan = yield* query(
      Effect.gen(function* () {
        const store = yield* ReviewStore;
        const { sheet, revision } = yield* store.renderSource(request.projectId, request.sheetId);
        const fitted = yield* validateRenderRequest(sheet, request.region, request.dpi);
        const identity = renderIdentity(revision.sha256, sheet, request.region, fitted.dpi);
        const previous = yield* store.renderOperation(request.projectId, request.operationId);

        if (previous !== undefined) {
          if (
            previous.sheetId !== request.sheetId ||
            Math.abs(previous.dpi - fitted.dpi) > 1e-9 ||
            JSON.stringify(previous.region) !== JSON.stringify(request.region)
          )
            return yield* new ReviewInputError({
              message: "A render operation cannot be reused for different source inputs.",
            });

          return { sheet, revision, identity, artifact: previous };
        }

        const artifact = yield* store.reusableRender(request.projectId, sheet.id, identity);

        return { sheet, revision, identity, artifact };
      }),
    );

    if (plan.artifact !== undefined) return { identity: plan.identity, artifact: plan.artifact };

    const result = yield* documents.render(
      plan.revision.sha256,
      plan.sheet,
      request.region,
      request.dpi,
    );

    return {
      identity: plan.identity,
      artifact: new Artifact({
        sha256: result.sha256,
        byteLength: result.byteLength,
        width: result.width,
        height: result.height,
        region: result.region,
        dpi: result.dpi,
        pdfToPixels: result.pdfToPixels,
        pixelsToPdf: result.pixelsToPdf,
        id: Schema.decodeUnknownSync(ArtifactId)(randomUUID()),
        projectId: request.projectId,
        revisionId: plan.revision.id,
        sheetId: plan.sheet.id,
        mediaType: "image/png",
        operationId: request.operationId,
      }),
    };
  });

  const source = (request: typeof RenderSource.Type) =>
    render(request).pipe(
      Effect.flatMap(({ identity, artifact }) =>
        query(
          Effect.flatMap(ReviewStore, (store) =>
            store.saveRender(request.operationId, identity, artifact),
          ),
        ),
      ),
    );

  const chunk = Effect.fn("Review.chunk")(function* (request: {
    readonly projectId: Artifact["projectId"];
    readonly artifactId: Artifact["id"];
    readonly offset: number;
    readonly limit: number;
  }) {
    if (config.documents === undefined) return yield* unavailable();

    const artifact = yield* query(
      Effect.flatMap(ReviewStore, (store) => store.artifact(request.projectId, request.artifactId)),
    );

    const result = yield* config.documents.read(
      artifact.sha256,
      artifact.mediaType,
      request.offset,
      request.limit,
    );

    return new ArtifactChunk({ artifactId: artifact.id, offset: request.offset, ...result });
  });

  const importPdf = Effect.fn("Review.importPdf")(function* (request: {
    readonly commandId: typeof CommandId.Type;
    readonly projectId: Artifact["projectId"];
    readonly expectedVersion: number;
    readonly source: string;
    readonly name: string;
  }) {
    if (config.documents === undefined) return yield* unavailable();
    const imported = yield* config.documents.importPdf(request.source);

    return yield* query(
      Effect.flatMap(ReviewStore, (store) =>
        store.importPdf(
          {
            commandId: request.commandId,
            projectId: request.projectId,
            expectedVersion: request.expectedVersion,
            name: request.name,
          },
          imported,
        ),
      ),
    );
  });

  const suggestSheetLabels = Effect.fn("Review.suggestSheetLabels")(function* (
    request: typeof SuggestSheetLabels.Type,
  ) {
    if (config.documents === undefined) return yield* unavailable();
    const state = yield* snapshot(request.projectId, 0);
    const revision = state.revisions.find((item) => item.id === request.revisionId);

    if (revision === undefined)
      return yield* new ReviewInputError({ message: "The revision is outside this project." });
    const sheets = state.sheets.filter((sheet) => sheet.revisionId === revision.id);

    const inspected = sheets.some((sheet) => sheet.label === `Page ${sheet.pageIndex + 1}`)
      ? yield* config.documents.inspectStored(revision.sha256)
      : undefined;

    return new SheetLabelSuggestions({
      revisionId: revision.id,
      proposals: sheets.map((sheet) => {
        const generic = sheet.label === `Page ${sheet.pageIndex + 1}`;
        const candidate = inspected?.pages.find((page) => page.pageIndex === sheet.pageIndex);
        const proposedLabel = generic && candidate?.label !== sheet.label ? candidate?.label : null;

        return new SheetLabelSuggestion({
          sheetId: sheet.id,
          currentLabel: sheet.label,
          proposedLabel: proposedLabel ?? null,
          status: !generic ? "preserved" : proposedLabel ? "suggested" : "unresolved",
        });
      }),
    });
  });

  const toExecution = <A>(operation: Effect.Effect<A, typeof ReviewError.Type>) =>
    operation.pipe(
      Effect.mapError(
        (error) =>
          new ExecutionError({
            reason: Schema.is(ReviewInputError)(error) ? "input" : "conflict",
            message: error.message,
          }),
      ),
    );

  const own = Effect.fn("Review.owner")(function* (generation: string) {
    yield* owner.assertHeld.pipe(
      Effect.mapError(
        () =>
          new ExecutionError({
            reason: "conflict",
            message: "Execution ownership is no longer held.",
          }),
      ),
    );

    if (generation !== owner.generation)
      return yield* new ExecutionError({
        reason: "conflict",
        message: "Execution belongs to another ownership generation.",
      });
  });

  const lookupReceipt = (commandId: string, hash: string) =>
    query(Effect.flatMap(ReviewStore, (store) => store.receipt(commandId, hash)));

  const verifyEvidence = Effect.fn("Review.verifyEvidence")(function* (
    projectId: Artifact["projectId"],
    findingId: typeof FindingId.Type,
  ) {
    if (config.documents === undefined) return yield* unavailable();
    const state = yield* snapshot(projectId, 0);
    const finding = state.findings.find((item) => item.id === findingId);

    if (finding === undefined)
      return yield* new ReviewInputError({ message: "The finding is outside this project." });

    const sheetIds = new Set([
      finding.drawnSheetId,
      finding.scheduledSheetId,
      ...state.facts
        .filter((fact) => fact.findingId === finding.id && fact.state === "accepted")
        .map((fact) => fact.evidence.sheetId),
    ]);

    const revisionIds = new Set(
      state.sheets.filter((sheet) => sheetIds.has(sheet.id)).map((sheet) => sheet.revisionId),
    );

    for (const revisionId of revisionIds) {
      const original = state.revisions.find((revision) => revision.id === revisionId);

      if (original === undefined)
        return yield* new ReviewInputError({
          message:
            "Source evidence is missing. Restore its complete review package before evaluation.",
        });
      yield* config.documents.read(original.sha256, "application/pdf", 0, 1);
    }
  });

  const command = Effect.fn("Review.command")(function* (input: typeof ReviewCommand.Type) {
    const previous = yield* lookupReceipt(input.commandId, reviewCommandFingerprint(input));

    if (previous !== undefined) return previous;

    if (ReviewCommand.guards.EvaluateFinding(input))
      yield* verifyEvidence(input.projectId, input.findingId);

    return yield* query(Effect.flatMap(ReviewStore, (store) => store.execute(input)));
  });

  const agent = Effect.fn("Review.agent")(function* (
    fence: Parameters<ExecutionPort["propose"]>[0],
    mutation: typeof AgentMutation.Type,
  ) {
    const previous = yield* toExecution(
      lookupReceipt(fence.commandId, agentCommandFingerprint(fence, mutation)),
    );

    if (previous !== undefined) return previous;
    yield* own(fence.ownerGeneration);

    if (AgentMutation.guards.Evaluate(mutation))
      yield* toExecution(verifyEvidence(fence.projectId, fence.findingId));

    return yield* toExecution(
      query(Effect.flatMap(ReviewStore, (store) => store.agent(fence, mutation))),
    );
  });

  const port: ExecutionPort = {
    readImage: (artifact) =>
      toExecution(
        Effect.gen(function* () {
          if (
            config.documents === undefined ||
            artifact.sheetId === null ||
            artifact.mediaType !== "image/png" ||
            artifact.byteLength > 16 * 1024 * 1024
          )
            return yield* new ReviewInputError({
              message: "The selected evidence is not a bounded source image.",
            });

          // One verified read; renderer chunk reads are for the bounded RPC transport.
          const bytes = yield* config.documents.readVerified(
            artifact.sha256,
            "image/png",
            16 * 1024 * 1024,
          );

          const converted = yield* Effect.tryPromise({
            try: async () => {
              const image = new Bun.Image(bytes);
              const metadata = await image.metadata();
              const scale = Math.min(1, 2048 / Math.max(metadata.width, metadata.height));
              const width = Math.max(1, Math.round(metadata.width * scale));
              const height = Math.max(1, Math.round(metadata.height * scale));
              const data = await image.resize(width, height).png().toBuffer();

              return { data: Buffer.from(data), width, height };
            },
            catch: () =>
              new ReviewInputError({
                message: "The selected evidence image could not be prepared.",
              }),
          });

          if (converted.data.byteLength > 1024 * 1024)
            return yield* new ReviewInputError({
              message: "Choose a smaller source region for this model inspection.",
            });
          const [a, b, c, d, e, f] = artifact.pdfToPixels;
          const sx = converted.width / artifact.width;
          const sy = converted.height / artifact.height;

          const pdfToPixels = Schema.decodeUnknownSync(Affine)([
            a * sx,
            b * sy,
            c * sx,
            d * sy,
            e * sx,
            f * sy,
          ]);

          const pixelsToPdf = invertTransform(pdfToPixels);

          if (pixelsToPdf instanceof ReviewInputError) return yield* pixelsToPdf;

          return new ExecutionImage({
            artifactId: artifact.id,
            projectId: artifact.projectId,
            sheetId: artifact.sheetId,
            mimeType: "image/png",
            data: converted.data.toString("base64"),
            width: converted.width,
            height: converted.height,
            pdfToPixels,
            pixelsToPdf,
          });
        }),
      ),
    inspect: (selection) =>
      toExecution(
        Effect.gen(function* () {
          const state = yield* snapshot(selection.projectId, 0);
          const project = state.project;
          const finding = state.findings.find((item) => item.id === selection.findingId);

          if (project === null || finding === undefined)
            return yield* new ReviewInputError({
              message: "The finding is outside the selected project.",
            });
          const allowed = new Set([finding.drawnSheetId, finding.scheduledSheetId]);
          const request = selection.reviewRequest;

          const instruction =
            request === undefined
              ? undefined
              : state.messages.find(
                  (message) =>
                    message.id === request.messageId &&
                    message.conversationId === request.conversationId &&
                    message.role === "reviewer",
                );

          if (request !== undefined && instruction === undefined)
            return yield* new ReviewInputError({
              message:
                "The reviewer request does not belong to the selected conversation and project.",
            });

          return new ExecutionEvidence({
            sourceVersion: project.sourceVersion,
            factVersion: project.factVersion,
            finding,
            sheets: state.sheets.filter((sheet) => allowed.has(sheet.id)),
            reviewerInstructions: instruction === undefined ? [] : [instruction.text],
            facts: state.facts.filter((fact) => fact.findingId === finding.id),
            checks: state.checks.filter((check) => check.findingId === finding.id),
            artifacts: state.artifacts.filter(
              (artifact) => artifact.sheetId !== null && allowed.has(artifact.sheetId),
            ),
          });
        }),
      ),
    render: (fence, detail) =>
      Effect.gen(function* () {
        const previous = yield* toExecution(
          lookupReceipt(
            fence.commandId,
            agentCommandFingerprint(fence, AgentInput.cases.Render.make({ detail })),
          ),
        );

        if (previous !== undefined)
          return yield* toExecution(
            query(
              Effect.flatMap(ReviewStore, (store) =>
                store.artifact(
                  fence.projectId,
                  Schema.decodeUnknownSync(ArtifactId)(previous.entityId),
                ),
              ),
            ),
          );
        yield* own(fence.ownerGeneration);

        const { identity, artifact } = yield* toExecution(
          render({
            projectId: fence.projectId,
            sheetId: detail.sheetId,
            operationId: Schema.decodeUnknownSync(OperationId)(fence.commandId),
            region: detail.region,
            dpi: 300,
          }),
        );

        const mutation = Schema.decodeUnknownSync(AgentMutation)(
          AgentMutation.cases.Render.make({ detail, artifact, renderIdentity: identity }),
        );

        const receipt = yield* toExecution(
          query(Effect.flatMap(ReviewStore, (store) => store.agent(fence, mutation))),
        );

        return yield* toExecution(
          query(
            Effect.flatMap(ReviewStore, (store) =>
              store.artifact(
                fence.projectId,
                Schema.decodeUnknownSync(ArtifactId)(receipt.entityId),
              ),
            ),
          ),
        );
      }),
    propose: (fence, proposal) => agent(fence, AgentMutation.cases.Propose.make({ proposal })),
    evaluate: (fence) =>
      Effect.gen(function* () {
        const receipt = yield* agent(fence, AgentMutation.cases.Evaluate.make({}));
        const state = yield* toExecution(snapshot(fence.projectId, 0));
        const check = state.checks.find((item) => item.id === receipt.entityId);

        if (check === undefined)
          return yield* new ExecutionError({
            reason: "storage",
            message: "The stored evaluation could not be read.",
          });

        return check;
      }),
    message: (fence, text) => agent(fence, AgentMutation.cases.Message.make({ text })),
  };

  return {
    artifact: (projectId: Artifact["projectId"], artifactId: Artifact["id"]) =>
      toExecution(
        query(Effect.flatMap(ReviewStore, (store) => store.artifact(projectId, artifactId))),
      ),
    snapshot,
    command,
    render: source,
    chunk,
    importPdf,
    suggestSheetLabels,
    port,
    /** Source options for governing-source lookups; PDFs need configured PDF processing. */
    sourceOptions: config.documents === undefined ? {} : { pdfText: config.documents.extractText },
  };
}
