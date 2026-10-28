import type { SpanOptions, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Result, Schema } from "effect";

const Phase = Schema.Struct({
  "task.id": Schema.Int.check(Schema.isGreaterThan(0)),
  "task.name": Schema.Literal("pi.generation"),
  phase: Schema.Literal("request"),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Validated durable provider identity, obtained from host-created phase spans only. */
export type RequestPhase = typeof Phase.Type;

/** Preserve the exact span identity passed by Pi 1.4.0 to registered providers. */
export function createExecutionTelemetry() {
  const phases = new WeakMap<object, RequestPhase>();

  const telemetry: TelemetryContext = {
    async startSpan<T>(
      options: SpanOptions,
      callback: (span: TelemetrySpan) => T | Promise<T>,
    ): Promise<T> {
      const span: TelemetrySpan = {
        startSpan: (childOptions, childCallback) =>
          telemetry.startSpan(childOptions, childCallback),
        addLink() {},
        addEvent() {},
        setAttributes() {},
        setStatus() {},
      };

      if (options.name === "pi.durable.phase") {
        const parsed = Schema.decodeUnknownResult(Phase)(options.attributes);
        Result.match(parsed, {
          onSuccess: (phase) => phases.set(span, phase),
          onFailure: () => undefined,
        });
      }

      return callback(span);
    },
  };

  return {
    telemetry,
    phase: (span: TelemetrySpan | undefined) => (span === undefined ? undefined : phases.get(span)),
  };
}
