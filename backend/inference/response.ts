import { Schema } from "effect";

const Tokens = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Text = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String),
});

const Thinking = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean),
});

const ToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
  thoughtSignature: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  argumentsError: Schema.optionalKey(Schema.String),
});

/** Supported normalized successful response subset; raw provider envelopes never reach the domain. */
export const ResponseReceipt = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.mutable(Schema.Array(Schema.Union([Text, Thinking, ToolCall]))),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseId: Schema.optionalKey(Schema.String),
  responseModel: Schema.optionalKey(Schema.String),
  usage: Schema.Struct({
    input: Tokens,
    output: Tokens,
    cacheRead: Tokens,
    cacheWrite: Tokens,
    totalTokens: Tokens,
    cost: Schema.Struct({
      input: Tokens,
      output: Tokens,
      cacheRead: Tokens,
      cacheWrite: Tokens,
      total: Tokens,
    }),
  }),
  stopReason: Schema.Literals(["stop", "length", "toolUse"]),
  timestamp: Schema.Finite,
});

/** Decode a receipt and produce SDK-owned mutable arrays only at the adapter boundary. */
// The unknown value is decoded here, at the SDK and persisted-JSON boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseResponseReceipt(input: unknown): typeof ResponseReceipt.Type {
  return Schema.decodeUnknownSync(ResponseReceipt)(input);
}
