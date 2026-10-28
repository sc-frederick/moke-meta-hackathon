import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { PacketCalculation } from "#lib/review/packet.ts";
import { ExecutionError } from "#lib/review/execution.ts";

const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/));
const Unit = Schema.Trim.check(Schema.isMaxLength(160));

/** Explicit values and units for repeatable arithmetic; units are retained, not inferred or converted. */
export const CalculationInput = Schema.Struct({
  title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  expression: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  inputs: Schema.Record(Name, Schema.Struct({ value: Schema.Finite, unit: Unit })),
  unit: Unit,
  explanation: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
});

type Input = typeof CalculationInput.Type;

type Operation = {
  readonly minimum: number;
  readonly maximum: number;
  readonly apply: (values: ReadonlyArray<number>) => number;
};

const unary = (apply: (value: number) => number): Operation => ({
  minimum: 1,
  maximum: 1,
  apply: (values) => apply(values[0] ?? NaN),
});

const operations: ReadonlyMap<string, Operation> = new Map([
  ["sqrt", unary(Math.sqrt)],
  ["abs", unary(Math.abs)],
  ["sin", unary(Math.sin)],
  ["cos", unary(Math.cos)],
  ["tan", unary(Math.tan)],
  ["asin", unary(Math.asin)],
  ["acos", unary(Math.acos)],
  ["atan", unary(Math.atan)],
  ["ln", unary(Math.log)],
  ["log10", unary(Math.log10)],
  ["exp", unary(Math.exp)],
  ["round", unary(Math.round)],
  ["floor", unary(Math.floor)],
  ["ceil", unary(Math.ceil)],
  [
    "pow",
    { minimum: 2, maximum: 2, apply: (values) => Math.pow(values[0] ?? NaN, values[1] ?? NaN) },
  ],
  ["min", { minimum: 1, maximum: 64, apply: (values) => Math.min(...values) }],
  ["max", { minimum: 1, maximum: 64, apply: (values) => Math.max(...values) }],
]);

function evaluate(expression: string, inputs: Input["inputs"]) {
  let position = 0;
  let depth = 0;
  let error: string | null = null;

  const fail = (message: string) => {
    error ??= message;

    return NaN;
  };

  const skip = () => {
    while (/\s/.test(expression[position] ?? "")) position++;
  };

  const consume = (value: string) => {
    skip();

    if (expression[position] !== value) return false;
    position++;

    return true;
  };

  const primary = (): number => {
    skip();
    let value: number;

    if (consume("(")) {
      value = sum();

      if (!consume(")")) return fail("A calculation parenthesis is not closed.");
    } else {
      const number = expression.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);

      if (number) {
        position += number[0].length;
        value = Number(number[0]);
      } else {
        const identifier = expression.slice(position).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];

        if (!identifier) return fail("The calculation contains an unexpected token.");
        position += identifier.length;

        if (consume("(")) {
          const operation = operations.get(identifier);

          if (!operation) return fail(`Unsupported calculation function: ${identifier}.`);
          const values: number[] = [];

          if (!consume(")")) {
            do {
              values.push(sum());

              if (values.length > operation.maximum)
                return fail(`Too many arguments for ${identifier}.`);
            } while (consume(","));

            if (!consume(")")) return fail(`The ${identifier} arguments are not closed.`);
          }

          if (values.length < operation.minimum)
            return fail(`Too few arguments for ${identifier}.`);
          value = operation.apply(values);
        } else if (Object.hasOwn(inputs, identifier)) value = inputs[identifier]?.value ?? NaN;
        else if (identifier === "pi") value = Math.PI;
        else if (identifier === "e") value = Math.E;
        else return fail(`Unknown calculation variable: ${identifier}.`);
      }
    }

    return Number.isFinite(value)
      ? value
      : fail("The calculation result is outside its mathematical domain.");
  };

  const power = (): number => {
    const value = primary();

    return consume("^") ? Math.pow(value, signed()) : value;
  };

  const signed = (): number => {
    depth++;

    if (depth > 64) {
      depth--;

      return fail("The calculation is nested too deeply.");
    }

    const value = consume("+") ? signed() : consume("-") ? -signed() : power();
    depth--;

    return value;
  };

  const product = (): number => {
    let value = signed();

    while (error === null) {
      if (consume("*")) value *= signed();
      else if (consume("/")) {
        const divisor = signed();

        if (divisor === 0) return fail("Division by zero is not a valid calculation.");
        value /= divisor;
      } else break;
    }

    return value;
  };

  const sum = (): number => {
    let value = product();

    while (error === null) {
      if (consume("+")) value += product();
      else if (consume("-")) value -= product();
      else break;
    }

    return value;
  };

  const result = sum();
  skip();

  if (position !== expression.length && error === null)
    error = "The calculation contains trailing text or an unsupported operator.";

  if (!Number.isFinite(result) && error === null)
    error = "The calculation did not produce a finite result.";

  return { result, error };
}

/** Evaluate documented arithmetic without executing code, then retain inputs, units and the result. */
export const calculate = Effect.fn("PacketReview.calculate")(function* (input: Input) {
  const request = yield* Schema.decodeUnknownEffect(CalculationInput, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () => new ExecutionError({ reason: "input", message: "The calculation input is invalid." }),
    ),
  );

  const evaluated = evaluate(request.expression, request.inputs);

  if (evaluated.error !== null)
    return yield* new ExecutionError({ reason: "input", message: evaluated.error });

  return Schema.decodeUnknownSync(PacketCalculation)({
    ...request,
    id: randomUUID(),
    result: evaluated.result,
  });
});
