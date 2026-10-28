import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { SamInspectionRequest } from "#lib/review/segmentation.ts";
import { Type } from "typebox";
import {
  CountProposal,
  DetailRequest,
  type ExecutionToolEvidence,
} from "../review/execution-port.ts";

/** Tools use durable task IDs rather than model-supplied tool-call IDs for command identity. */
interface ExecutionTools {
  readonly inspect: (taskId: number) => Promise<ExecutionToolEvidence>;
  readonly render: (
    taskId: number,
    request: typeof DetailRequest.Type,
  ) => Promise<ExecutionToolEvidence>;
  readonly propose: (taskId: number, proposal: typeof CountProposal.Type) => Promise<string>;
  readonly evaluate: (taskId: number) => Promise<string>;
  readonly message: (taskId: number, text: string) => Promise<string>;
  readonly finish: (taskId: number, text: string) => Promise<string>;
  readonly segment?: (
    taskId: number,
    request: SamInspectionRequest,
  ) => Promise<ExecutionToolEvidence>;
}

/** Restrict the descriptor bridge to required JSON fields; Effect parses again on execution. */
export function createReviewTools(operations: ExecutionTools) {
  const registry = createRegistry();

  const descriptor = (schema: Schema.Top) => {
    const document = Schema.toJsonSchemaDocument(schema);

    return Type.Unsafe<unknown>({ ...document.schema, $defs: document.definitions });
  };

  const Empty = Schema.Struct({});

  const Message = Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  });

  const imageOutput = (result: ExecutionToolEvidence) => [
    { type: "text" as const, text: result.text },
    ...result.images.flatMap((image) => [
      {
        type: "text" as const,
        text: JSON.stringify({
          artifactId: image.artifactId,
          sheetId: image.sheetId,
          width: image.width,
          height: image.height,
          pdfToPixels: image.pdfToPixels,
          pixelsToPdf: image.pixelsToPdf,
        }),
      },
      { type: "image" as const, data: image.data, mimeType: image.mimeType },
    ]),
  ];

  const tools = [
    defineTool({
      name: "inspect_selected_evidence",
      description: "Inspect only the selected finding's source evidence and input versions.",
      parameters: descriptor(Empty),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        Schema.decodeUnknownSync(Empty, { onExcessProperty: "error" })(args);

        return { output: imageOutput(await operations.inspect(api.taskId)) };
      },
    }),
    defineTool({
      name: "render_missing_detail",
      description:
        "Render a bounded region on a selected sheet. Region x/y/width/height are original PDF points with bottom-left origin; raster rows start at the top. Use the supplied pixelsToPdf transform rather than copying screen y coordinates. Identify the missing fact this detail will resolve.",
      parameters: descriptor(DetailRequest),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        const request = Schema.decodeUnknownSync(Schema.toCodecJson(DetailRequest), {
          onExcessProperty: "error",
        })(args);

        return { output: imageOutput(await operations.render(api.taskId, request)) };
      },
    }),
    defineTool({
      name: "propose_count",
      description:
        "Propose a count and exact source evidence for reviewer acceptance. This never accepts evidence or confirms coverage.",
      parameters: descriptor(CountProposal),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        const proposal = Schema.decodeUnknownSync(Schema.toCodecJson(CountProposal), {
          onExcessProperty: "error",
        })(args);

        return { output: [{ type: "text", text: await operations.propose(api.taskId, proposal) }] };
      },
    }),
    defineTool({
      name: "evaluate_accepted_inputs",
      description: "Request the application's deterministic count check against accepted inputs.",
      parameters: descriptor(Empty),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        Schema.decodeUnknownSync(Empty, { onExcessProperty: "error" })(args);

        return { output: [{ type: "text", text: await operations.evaluate(api.taskId) }] };
      },
    }),
    defineTool({
      name: "ask_reviewer",
      description:
        "Ask the reviewer for missing source detail or clarification; prose is not accepted evidence.",
      parameters: descriptor(Message),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        const { text } = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" })(args);

        return { output: [{ type: "text", text: await operations.message(api.taskId, text) }] };
      },
    }),
    defineTool({
      name: "finish_review",
      description:
        "Record a bounded progress summary. Finishing does not accept inputs, close findings, or declare engineering completeness.",
      parameters: descriptor(Message),
      replay: "safe",
      executionMode: "sequential",
      async execute(args, api) {
        const { text } = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" })(args);

        return { output: [{ type: "text", text: await operations.finish(api.taskId, text) }] };
      },
    }),
  ];

  const segmentation = operations.segment;

  if (segmentation !== undefined)
    tools.push(
      defineTool({
        name: "segment_source_region",
        description:
          "Use SAM to propose object locations on a rendered source artifact. Shape prompts such as square/circle and source-guided boxes/points are useful; verify class and coverage independently. Coordinates refer to the delivered image. Zero matches do not establish absence.",
        parameters: descriptor(SamInspectionRequest),
        replay: "safe",
        executionMode: "sequential",
        async execute(args, api) {
          const request = Schema.decodeUnknownSync(Schema.toCodecJson(SamInspectionRequest), {
            onExcessProperty: "error",
          })(args);

          return { output: imageOutput(await segmentation(api.taskId, request)) };
        },
      }),
    );

  registry.install(defineExtension({ name: "selected-finding-review-v1", tools }));

  return registry;
}
