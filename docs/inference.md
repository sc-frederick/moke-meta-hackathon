# Inference setup

For development, copy `.env.example` to `.env` and fill in either or both keys:

```dotenv
MODEL_API_KEY=
BASETEN_API_KEY=
```

Bun loads the root `.env` when `bun run dev` starts. Restart after changing it.
Both configured providers are available together in the Model menu. Keep each
key with its own provider and endpoint; keys never enter renderer code or logs.
The repository ignores `.env` and `.env.*` except the blank `.env.example`.

## Models and routes

| Model                              | Provider | Canonical endpoint                | Credential        |
| ---------------------------------- | -------- | --------------------------------- | ----------------- |
| `muse-spark-1.3`                   | Meta     | `https://api.meta.ai/v1`          | `MODEL_API_KEY`   |
| `muse-wonder-1.0`                  | Meta     | `https://api.meta.ai/v1`          | `MODEL_API_KEY`   |
| `meta-models/muse-spark-open-1026` | Baseten  | `https://inference.baseten.co/v1` | `BASETEN_API_KEY` |

Keep the `-1026` suffix for the supplied Baseten hackathon key. Public examples
use `meta-models/muse-spark-open`, which is a different configured model ID. SAM
3.1 runs on Meta with `MODEL_API_KEY` and is not a chat-model option. When that
key is configured, packet reviews use it with either chat provider; see
[SAM in packet reviews](#sam-in-packet-reviews).

`MOKE_PROVIDER` chooses the preferred startup provider, with `meta` as the
default. Each review saves the model selected in the workbench. Changing the menu
does not change an existing run or silently substitute another provider. The
other endpoint and model variables in `.env.example` support experiment scripts;
they do not override the desktop's canonical routes.

Import the PDF packet and send a natural-language review request. Auto routes a
whole-set QA request or a named discipline; an explicit reviewer selects that
discipline. No count check or manual sheet confirmation is required to start a
packet review. A note is saved without calling a model. The model receives the
full Moke AGENTS.md, shared method and applicable discipline instructions as its
Pi system instructions. See the [prompt documentation](../backend/review/prompts/README.md).

## Model capabilities and operational budgets

Packet review uses automatic Pi compaction for long conversations. On Meta it
matches the settings Meta's console uses for Muse Spark 1.3: `xhigh` reasoning, a
256,000-token output limit, and Meta's built-in `web_search` tool with high search
context. Web search runs on Meta's side and returns cited text. Reviewers still
record governing sources with `read_source`. Baseten packet requests use high
reasoning. The installed Meta catalog gives Spark 1.3 and Wonder a 1,048,576-token
context and records a 131,072-token output limit; Meta accepted 256,000 for Spark
1.3 on 2026-10-29. Meta documents the full context window in its
[model catalog](https://dev.meta.ai/docs/models).

Meta's [rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for Spark 1.3
are 3,000 requests and 4,000,000 tokens a minute, shared by every key on a team;
response headers confirmed them for the configured key. Meta reads images returned
in tool results, and accepted 300 small tool-result images in one request.
The Baseten hackathon key reports 100 requests and 2,000,000 tokens a minute
(2026-10-31). Its request limiter allows about 50 requests at once, and
[Baseten counts cached input](https://docs.baseten.co/inference/model-apis/pricing-and-limits#rate-limits)
toward the token limit. `bun run check:api-keys` prints both keys' current limits.

### Rate-limit pacing and refusals

Every request on a key in the backend process passes through one shared pacer
(`backend/inference/pacing.ts`). It holds at most half a minute of requests and
estimated tokens, replenishes them continuously, and releases requests in arrival
order. Each response's `x-ratelimit-limit-*` and `x-ratelimit-remaining-*` headers
update it. Both providers send them. The pacer waits before the durable request
attempt is recorded, so a cancel or shutdown during the wait leaves nothing
unresolved, and the 300-second request deadline starts only when the request is sent.

HTTP 429 and 529 mean the provider refused the request before generating. The
refusal starts one cooldown that every conversation on the key waits out, so
parallel sheet reviewers do not retry into the same limit. The cooldown honours
`Retry-After` in full, as delay-seconds or an HTTP-date. Otherwise, or when it is
zero or malformed, it starts at 2 seconds and doubles up to 60 when requests sent
after it began are refused again. Baseten's 429 carries no `Retry-After`. Meta
also answers a served model with HTTP 404 `model_not_found` now and then (1 in 8
requests for one team's key on 2026-10-30). Nothing is generated, so that request
alone is resent after its own backoff. A refused request is resent within the same
admitted attempt for up to 10 minutes or 40 sends, and stops at once if its next
send could go out only after the 10 minutes. A packet request refused on every
send generated nothing, so the review pauses without an unresolved request and
says it was not charged; Resume continues it. Other failures are not resent.
Large packets review each sheet in its own conversation; see
[parallel packet reviews](review-runtime.md#parallel-packet-reviews).

Baseten
advertises a [1M-token context for Spark Open](https://www.baseten.co/blog/muse-spark-open-launch/)
but does not publish a separate serving output ceiling there. The desktop leaves
Baseten's output parameter at its API default by using the ordinary stream path;
the SDK's simple stream would insert a context-sized output limit. The public
[Chat Completions reference](https://docs.baseten.co/reference/inference-api/chat-completions)
documents a 4,096-token default for `max_tokens`. The dated hackathon variant's
separate limit for `max_completion_tokens` is not established by that reference.
The adapter sets neither field for Baseten packet requests and retains explicit
high reasoning. Request-shape captures verify both completion entrypoints.
These capability sources were checked on 2026-10-29. The output-policy correction
does not establish the cause of the observed provider timeout or guarantee review
completion.

A packet review defaults to no application call ceiling. An optional user call
budget counts model and SAM requests together. Reaching it pauses work and keeps
the review ledger; explicitly extend the budget to resume. Packet review has no
separate two-SAM cap or six-image context window. The host still bounds transport
memory to 64 MiB of decoded image data and 72 MiB per serialized request. Those
are application memory bounds, not provider token maxima. Image-token accounting
and cost can remain unknown.

## SAM in packet reviews

With `MODEL_API_KEY` configured, packet reviews use SAM 3.1 in two places:

- **Device counts.** The reviewer calls `segment_objects` on a focused crop to
  find receptacles, switches, luminaires, plumbing fixtures and similar symbols,
  then checks each candidate against the source. The host rejects a finding
  that states a drawn device or fixture count until SAM has segmented a crop of
  one of its sheets in the same review. Room, circuit, sheet and code-section
  numbers before a device name do not count as a quantity.
- **Finding zooms.** After `record_finding`, the host renders a padded zoom of
  the first location region that covers at most half its sheet. It sends the
  region to SAM as a box with a positive point at its center and stores the
  masks with the finding. The workbench opens a finding on its zoom with the
  masks drawn over the source, and the exported report embeds the same view.
  Whole-sheet locations get no zoom.

Both uses share the review's request ledger and call budget. If the budget is
already spent, the finding is recorded without a zoom. An unresolved SAM outcome
stops the review as an unresolved model request does, and it is never resent.
SAM masks propose locations only. They do not verify a symbol's class, establish
coverage or measure physical dimensions.

The older selected-count execution adapter keeps its narrower admission limits
for compatibility. Those limits do not define ordinary packet review.

## Prompt caching and request images

Meta and Baseten cache prompt prefixes automatically. Moke routes requests that
share a prefix to the same cache and keeps earlier turns unchanged, aiming for at
least 90% of prompt tokens served from cache (`cacheRead / (input + cacheRead)`).

- **One key per shared prefix.** Every sheet reviewer of a review shares one key,
  and the coordinator's setup and coordination turns share another. The key is a
  hash of the model, project and instructions; it carries no names or prompt text.
  Meta receives it as `prompt_cache_key` with `prompt_cache_retention: "24h"`;
  Baseten receives it as `x-session-affinity`. Each count check uses its own key.
  Pi's per-conversation session ID is not forwarded, because per-session keys would
  split reviewers that share a prefix. On Baseten (2026-10-31), a prefix cached under
  one `x-session-affinity` value was never reused by requests with a different value,
  so each extra key would pay the full prefix again. Twelve parallel 4-turn
  conversations on one key had 91.7% of prompt tokens cached, against 88.7% with no
  header. See [Baseten rate limits and caching](research/baseten-rate-limits.md).
- **Shared fields first.** A sheet reviewer's opening message lists the request,
  scope, inventory, project configuration and sources before its own sheet, so
  peers reuse the same prefix.
- **Warm before fan-out.** One sheet reviewer starts first. The others start when
  its opening request settles, or after 90 seconds, so they find the prefix cached.
- **Append-only history.** Meta packet requests keep every image. Baseten packet
  requests (8 images) and count checks (6 images) drop the oldest images several
  at a time (4 and 3) instead of one per turn, so an earlier position changes once
  per step. Images added since the model's last turn are never dropped for older
  ones; the step stops short of them.
- **Images by reference.** Live Meta requests upload each delivered image once to
  the [Files API](https://dev.meta.ai/docs/file-handling) (`purpose=user_data`,
  24-hour expiry) and send its `file_id`, so later turns no longer resend base64.
  A failed upload leaves that image inline and is not retried for five minutes.
  A review uploads at most eight images at once. An upload stops when every request
  waiting for it is cancelled, and the next request uploads that image again.

A probe on 2026-10-30 confirmed that Meta accepts `file_id` images inside
`function_call_output` and reads them, that a base64 request after the matching
`file_id` request still hit the cache, and that the second of two requests with
the same key and a 7,216-token prefix was 99.1% cached. Each review records its
token totals, overall and per sheet reviewer. The packet panel shows the cached
share, and **Copy review diagnostics** includes it for every finished review.

## Packaged desktop credentials

Packaged builds use an explicitly selected private credential file or the File
menu's encrypted credential import. They do not search the installation directory
for `.env`. The development keys can be transferred through that private launch
configuration; never bundle `.env` or expose keys through `PUBLIC_` or `VITE_`
variables.

A session file accepts one provider configuration or both:

```json
{
  "providers": [
    {
      "provider": "meta",
      "apiKey": "YOUR_META_KEY",
      "baseUrl": "https://api.meta.ai/v1",
      "model": "muse-spark-1.3"
    },
    {
      "provider": "baseten",
      "apiKey": "YOUR_BASETEN_KEY",
      "baseUrl": "https://inference.baseten.co/v1",
      "model": "meta-models/muse-spark-open-1026"
    }
  ]
}
```

Set `MOKE_SESSION_CREDENTIAL_FILE` to that private file for the launch. Unix files
must be owner-only; Windows uses file ACLs. Importing one provider preserves the
other provider's saved connection. Restart after changing the session file.
A model whose provider is unconfigured stays disabled. Connected in settings
means configuration is present; it does not prove that the provider authenticated
a live request. See [packaged launch details](deployment.md#provider-credentials-in-a-packaged-launch).

## Optional authentication check

```sh
bun run check:api-keys
```

This sends one small text request to Meta and one to Baseten using `.env`, and
prints only a safe success or failure summary. It is separate from ordinary
verification, which needs no keys and makes no hosted requests. A successful text
check proves authentication and a text response, not a completed drawing review.
See the [model reference](models.md) for provider documentation and experiments.
