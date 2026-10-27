import { Effect, Redacted, Schema } from "effect";

// Bun loads the root .env automatically. Run this script from the repository root.
const providers = [
  {
    name: "Meta",
    keyVariable: "MODEL_API_KEY",
    apiKey: Bun.env.MODEL_API_KEY,
    baseUrl: Bun.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
    model: Bun.env.META_TEXT_MODEL ?? "muse-spark-1.3",
  },
  {
    name: "Baseten",
    keyVariable: "BASETEN_API_KEY",
    apiKey: Bun.env.BASETEN_API_KEY,
    baseUrl: Bun.env.BASETEN_API_BASE_URL ?? "https://inference.baseten.co/v1",
    model: Bun.env.BASETEN_MODEL ?? "meta-models/muse-spark-open-1026",
  },
] as const;

const NonBlankString = Schema.NonEmptyString.check(Schema.isTrimmed());

const ProviderConfig = Schema.Struct({
  apiKey: Schema.RedactedFromValue(NonBlankString),
  baseUrl: Schema.URLFromString.check(
    Schema.makeFilter(
      (url) =>
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "",
    ),
  ),
  model: NonBlankString,
});

const ChatCompletion = Schema.fromJsonString(
  Schema.Struct({
    choices: Schema.NonEmptyArray(
      Schema.Struct({
        message: Schema.Struct({ content: Schema.Trim.check(Schema.isMinLength(1)) }),
      }),
    ),
  }),
);

class ApiKeyCheckFailed extends Schema.TaggedError<ApiKeyCheckFailed>()("ApiKeyCheckFailed", {
  message: Schema.String,
}) {}

const statusHints = new Map([
  [400, "Request or model parameters were rejected."],
  [401, "API key was rejected."],
  [402, "Billing or credits are required."],
  [403, "Key or account lacks access."],
  [404, "Model or endpoint was not found."],
  [429, "Rate limit or quota was reached; retry later."],
]);

const checkProvider = Effect.fn("checkProvider")(function* (provider: (typeof providers)[number]) {
  const config = yield* Schema.decodeUnknownEffect(ProviderConfig)(provider).pipe(
    Effect.mapError(
      () =>
        new ApiKeyCheckFailed({
          message: `Check ${provider.keyVariable}, the provider base URL, and model in .env. Keys and models must be nonblank; URLs must use HTTPS without credentials, query strings, or fragments.`,
        }),
    ),
  );

  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${config.baseUrl.href.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Reply with only OK." }],
          max_completion_tokens: 256,
          reasoning_effort: "low",
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });

      return { ok: response.ok, status: response.status, body: await response.text() };
    },
    catch: () =>
      new ApiKeyCheckFailed({
        message:
          "Network request failed or exceeded the 30-second timeout. Check connectivity and the base URL.",
      }),
  });

  if (!response.ok) {
    return yield* new ApiKeyCheckFailed({
      message: `HTTP ${response.status}: ${statusHints.get(response.status) ?? "Provider returned an error; retry later or check its status page."}`,
    });
  }

  // Schema errors and provider bodies can include sensitive input. Report only a safe summary.
  yield* Schema.decodeUnknownEffect(ChatCompletion)(response.body).pipe(
    Effect.mapError(
      () =>
        new ApiKeyCheckFailed({
          message: `HTTP ${response.status}, but no valid text completion was returned.`,
        }),
    ),
  );
});

const program = Effect.gen(function* () {
  console.log(
    "Checking Meta and Baseten with one small text generation each. Bun loads .env automatically.",
  );

  const results = yield* Effect.forEach(providers, (provider) =>
    checkProvider(provider).pipe(
      Effect.match({
        onFailure: (error) => {
          console.error(`[FAIL] ${provider.name}: ${error.message}`);

          return false;
        },
        onSuccess: () => {
          console.log(`[PASS] ${provider.name}: authenticated and received a text completion.`);

          return true;
        },
      }),
    ),
  );

  process.exitCode = results.every(Boolean) ? 0 : 1;
});

await Effect.runPromise(program).catch(() => {
  console.error("API key checker stopped unexpectedly.");
  process.exitCode = 1;
});
