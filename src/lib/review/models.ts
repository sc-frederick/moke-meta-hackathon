import { Schema } from "effect";

/** Chat models supported by the drawing-review runtime; SAM remains a tool. */
export const ReviewModelId = Schema.Literals([
  "muse-spark-1.3",
  "muse-wonder-1.0",
  "meta-models/muse-spark-open-1026",
]);

/** Explicit provider routes keep a model selection from changing credential ownership. */
export const reviewModels = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", provider: "meta" },
  { id: "muse-wonder-1.0", label: "Muse Wonder", provider: "meta" },
  { id: "meta-models/muse-spark-open-1026", label: "Muse Spark Open", provider: "baseten" },
] as const;

/** Renderer-safe model availability contains no credential information. */
export const ReviewModelOption = Schema.Struct({
  id: ReviewModelId,
  label: Schema.String,
  provider: Schema.Literals(["meta", "baseten"]),
  available: Schema.Boolean,
});
