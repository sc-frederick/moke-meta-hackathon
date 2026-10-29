# Reopened provider timeout assessment

Checked 2026-10-29. Read-only source and evidence investigation using Exa through
Executor for primary documentation. No external inference request, replay, code
change or deployment was performed. One local SDK serialization capture used an
injected transport returning a fabricated HTTP response; it sent no network call.

## Finding

**M3-01 cannot be declared resolved by the available evidence.** The image-count
HTTP 400 cause was fixed and demonstrated separately. The reopened three-sheet
cloud review still stopped without a complete third provider receipt. There is
one concrete, minimal adapter policy correction worth making, but no evidence
that it alone will fix the observed timeout: the application does not actually
leave the Baseten output parameter at its API default.

The five successful live sets returning findings also do not establish complete
coverage of the larger sets. The later bounded admission demonstration proves
three admitted requests, including a sent third attempt; it does not prove three
completed model responses or completed review coverage.

## Directly observed local evidence

- `reopened-live-worker-read.jsonl`: review
  `03bcd2b5-7f6b-4b64-822d-2ffa2670578f` has two completed model receipts and a
  third `sent=1`, `status=uncertain`, no response receipt. Two of three sheets were
  rendered; the last rendering activity finished. This rules out an active PDF
  render at the recorded checkpoint. The parent separately observed the native
  300-second timeout and safe no-replay return; this intermediate checkpoint
  alone does not establish what the provider did internally.
- `reopened-live-admission-worker-read.jsonl`: review
  `11ebfa0f-31ad-44ee-90c7-a54edadcf9dc` similarly has two completed receipts and
  a sent third attempt without a complete receipt. The parent explicitly stopped
  that bounded admission test. Its third request is not evidence of another
  independently observed provider timeout.
- `backend/inference/provider.ts:41`: capabilities for the exact required
  `meta-models/muse-spark-open-1026` are `contextWindow=1048576`,
  `maxOutputTokens=null`. The fallback SDK model at line 266 nevertheless sets
  `maxTokens=1048576` because the SDK requires a numeric field.

## Concrete SDK output-policy mismatch

Current call path:

1. Pi Durable `dist/harness/generation.js:353` calls `runtime.models.streamSimple`.
2. Our `provider.ts:519` wrapper forwards to `base.streamSimple`.
3. Installed pi-ai `dist/api/openai-completions.js:520` calls
   `buildBaseOptions` before its ordinary `stream` implementation.
4. `dist/api/simple-options.js:23` substitutes `model.maxTokens` when
   `options.maxTokens` is absent, then subtracts estimated context plus a
   4096-token reserve.
5. `openai-completions.js:592` serializes that value. The fallback Baseten model
   has no explicit `compat.maxTokensField`; automatic compatibility detection
   chooses **`max_completion_tokens`**, not `max_tokens`.

The existing application intentionally omits `result.maxTokens` for packet
reviews on Baseten (`provider.ts:494`). This does **not** survive `streamSimple`.
A local capture through the actual wrapper and SDK, with only the synthetic text
`Capture request policy.`, produced:

```json
{
  "model": "meta-models/muse-spark-open-1026",
  "max_tokens": null,
  "max_completion_tokens": 1044473,
  "reasoning_effort": "high",
  "stream": true
}
```

The `null` above records an absent JSON property; the request did not send literal
null. The exact context-fit number changes with the transcript. This also means
`docs/inference.md` currently overstates the API-default behavior.

[Baseten Chat Completions](https://docs.baseten.co/reference/inference-api/chat-completions)
documents `max_tokens` default 4096 and range 1–262144; larger requested output
budgets can slightly reduce scheduling priority. The checked reference does not
establish that the dated hackathon variant enforces that same range for
`max_completion_tokens`. Its first two successful receipts used the same adapter
policy. Therefore it would be incorrect to infer either that the alias was
rejected or that its value caused the third-request timeout.

## Small correction alternatives

| Alternative                                                                                                    | Effect and limitation                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Preferred: use the existing `base.stream<Api>` path for Baseten packet work in the `streamSimple` callback** | Bypasses SDK injection of a context-sized output ceiling. Keep the existing explicit `reasoningEffort: high`, signal, timeout, telemetry, no-retry transport and image window. Our ordinary `stream` callback already demonstrates this route. Both output-limit keys should be absent on the captured wire. This restores the documented application policy; it is not a demonstrated timeout cure. |
| Strip both output fields with the SDK `onPayload` hook                                                         | Also restores API defaults, but adds a payload mutation hook and must remove both `max_tokens` and `max_completion_tokens` after SDK serialization. More machinery than using the existing ordinary stream path.                                                                                                                                                                                     |
| Explicit 4096-token budget                                                                                     | Uses the public documented default as a deliberate application limit. This changes policy and includes reasoning tokens, so it can truncate a high-reasoning tool call or answer. It is not required to repair the accidental SDK default injection.                                                                                                                                                 |

Proof without external inference: use `ProviderConfiguration.transport` with a
fixture key and `route: recorded`; capture only the decoded outbound JSON model,
reasoning, streaming and output-limit fields, then return a local SSE fixture or
fabricated HTTP rejection. Exercise both `models.complete` and
`models.completeSimple` under the real admission telemetry. Assert both limit
keys are absent for the API-default Baseten policy, while Meta's selected native
output ceiling remains present. This proves request shape only. A future live
acceptance test must be a new, explicitly bounded request, never a replay of the
uncertain third attempt.

## Other assessed explanations

**Image count and size:** the current adapter retains at most eight image parts,
and `render_sheet` caps each fresh batch at eight. The supplied timeout checkpoint
has only two rendered pages. Model images are resized to at most 2048 pixels per
side and at most 1 MiB (`backend/review/operations.ts:291`). The SDK sends base64
`image_url` objects without an explicit detail value. Baseten documents eight
images, a 100 MiB base64 request limit, and optional `auto` detail. No evidence
supports another image-count violation or mandatory resolution/detail fix for
this checkpoint. Reducing resolution could impair dense drawing interpretation.
[Baseten vision](https://docs.baseten.co/inference/model-apis/vision)

**Reasoning:** current requests select `high`, a documented Muse Spark Open value.
Higher effort may increase latency; the model always reasons. That supports a
latency hypothesis, not a finding that `high` is invalid. A reasoning-only token
cap is documented as enforced only by a different model family, so adding one
here is unsupported. [Baseten reasoning](https://docs.baseten.co/inference/model-apis/reasoning)

**Streaming timeout:** the adapter requests SSE with retries disabled. The
installed OpenAI SDK's `client.js:991` deadline wraps fetch and is cleared when
fetch returns headers; it is not an overall stream-completion watchdog. A
`timeout` diagnostic in the adapter's `dispatch` phase with no HTTP status would
identify a wait before headers. A post-header incomplete stream is a separate
failure category. The intermediate worker reads do not expose these wire timing
boundaries or prove provider generation was idle. The SDK buffers the normalized
response until its durable receipt commits, so the absence of a completed
receipt is not proof that no partial SSE chunks were received.

Baseten advises sizing timeouts for actual latency and checking both stream
completion and stop reason. Its dedicated deployment timeout examples do not
establish a guaranteed response time for this shared hackathon Model API. Neither
another timeout increase nor automatic replay is justified by this read-only
assessment. [HTTP clients](https://docs.baseten.co/inference/http-client-configuration),
[streaming](https://docs.baseten.co/inference/streaming),
[inference errors](https://docs.baseten.co/inference/errors)

**Compute:** no active local rendering tool appears in the recorded stall. More
Modal CPU or memory would not establish that the separately hosted Baseten model
responds within the desktop deadline. This is an inference from the observed
process boundary, not a provider uptime claim.

## Implemented follow-up

The preferred narrow stream-path correction is now implemented. Both real SDK
entrypoint captures omit both output-limit fields, retain high reasoning and keep
Meta's native output policy. The old simple-path assertion failed on1044474;
the new assertions pass. Sol independently approved the change after34tests and
375assertions. This is request-policy proof only. A new bounded native Fire alarm
review is recorded separately in the acceptance report.

## Remaining acceptance

Correct the output-policy mismatch if retaining the API-default intent; preserve
all unresolved-attempt records and the no-replay boundary. Keep M3-01 open until a
new real native/cloud review demonstrates the required completion and coverage.
Safe request shape, returning partial records, and three admitted calls establish
specific improvements, not complete provider reliability.

## Recheck: what the 300-second limit measures

Checked 2026-10-29 during the native recheck. Source reading plus one small streamed
request; no review attempt was replayed.

The packet deadline is passed to the OpenAI SDK as `timeout`. In the installed SDK,
`fetchWithTimeout` (`node_modules/openai/client.js`) arms the timer around `fetch` and
clears it in `finally` once the response headers arrive. `parseResponseWithTimeout`
skips its body timer for streamed requests. Pi Durable adds no per-call deadline. The
300-second limit therefore bounds the wait for the first response headers, not the
length of a streamed answer.

A synthetic streamed Muse Spark Open request (`reasoning_effort: high`, 3,000-token
cap, no images) returned headers in 0.71 s. Reasoning deltas started at the same
moment, content at 5.7 s, and the stream finished at 6.2 s, with no gap over 142 ms
across 380 chunks (`.local/audit-3-fixes/opus-followup/stream-timing.json`).

So the earlier 300-second stop was a request that produced no response headers for
five minutes, and slow answers already finish once streaming starts. A 259-second
call during the recheck finished normally. Raising the limit would only delay the
failure report for a stalled request, so it stays at 300 seconds. Nothing here shows
why Baseten held that request; it may have queued under load or stalled.

In the recheck's fresh workspace, five local Muse Spark Open and Muse Spark 1.3 reviews
ran concurrently for 17 to 46 minutes each, and none hit a provider timeout, HTTP 400 or
other provider failure.
