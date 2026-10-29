import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { calculate } from "../../backend/packet-review/calculations.ts";

const base = {
  title: "Engineering check",
  inputs: {},
  unit: "",
  explanation: "Reproduce the stated source inputs and formula.",
};

test("calculates a three-phase current with retained source values and units", async () => {
  const result = await Effect.runPromise(
    calculate({
      ...base,
      title: "Three-phase current",
      expression: "power / (sqrt(3) * voltage * pf)",
      inputs: {
        power: { value: 18000, unit: "W" },
        voltage: { value: 208, unit: "V" },
        pf: { value: 0.9, unit: "dimensionless" },
      },
      unit: "A",
    }),
  );

  expect(result.result).toBeCloseTo(55.5144, 3);
  expect(result.inputs.voltage).toEqual({ value: 208, unit: "V" });
  expect(result.expression).toBe("power / (sqrt(3) * voltage * pf)");
  expect(result.unit).toBe("A");
  expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
});

test("records a beam moment using an explicit source load and span", async () => {
  const result = await Effect.runPromise(
    calculate({
      ...base,
      expression: "w * L^2 / 8",
      unit: "kip-ft",
      inputs: { w: { value: 1.5, unit: "kip/ft" }, L: { value: 12, unit: "ft" } },
    }),
  );

  expect(result.result).toBe(27);
  expect(result.inputs.L?.unit).toBe("ft");
});

test.each([
  ["2 + 3 * 4", 14],
  ["(2 + 3) * 4", 20],
  ["-2^2", -4],
  ["2^-2", 0.25],
  ["2^3^2", 512],
  ["min(5, 3, 8) + max(2, 4)", 7],
  ["sin(pi/2) + cos(0)", 2],
  ["1.2e3 + .5", 1200.5],
] as const)("evaluates arithmetic precedence in %s", async (expression, expected) => {
  expect((await Effect.runPromise(calculate({ ...base, expression }))).result).toBeCloseTo(
    expected,
    8,
  );
});

test.each([
  "1/0",
  "sqrt(-1)",
  "2^1024",
  "missing + 1",
  "pow(2)",
  "sqrt(1,2)",
  "process.exit()",
  "1; globalThis",
  "2(3)",
  "1 +",
  "(1+2",
  "Math.max(1,2)",
  `${"(".repeat(100)}1${")".repeat(100)}`,
  `${"-".repeat(100)}1`,
])("rejects undefined arithmetic or code in %s", async (expression) => {
  const result = await Effect.runPromise(Effect.result(calculate({ ...base, expression })));
  expect(Result.isFailure(result)).toBe(true);

  if (Result.isFailure(result)) expect(result.failure.reason).toBe("input");
});

test("rejects nonfinite inputs instead of returning an apparently valid record", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      calculate({ ...base, expression: "load", inputs: { load: { value: Infinity, unit: "lb" } } }),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);
});
