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
is an optional evidence tool on Meta, rather than a chat-model option. It can
assist a Baseten chat review when a Meta key is also configured.

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
HTTP 429 and 529 mean the provider refused the request before generating, so the
adapter resends it up to six times, honouring `Retry-After` (otherwise backing off
from 2 seconds up to 60). Other failures are not resent. Large packets review each sheet in its own
conversation; see [parallel packet reviews](review-runtime.md#parallel-packet-reviews).

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
  split reviewers that share a prefix.
- **Shared fields first.** A sheet reviewer's opening message lists the request,
  scope, inventory, project configuration and sources before its own sheet, so
  peers reuse the same prefix.
- **Warm before fan-out.** One sheet reviewer starts first. The others start when
  its opening request settles, or after 90 seconds, so they find the prefix cached.
- **Append-only history.** Meta packet requests keep every image. Baseten packet
  requests (8 images) and count checks (6 images) drop the oldest images several
  at a time (4 and 3) instead of one per turn, so an earlier position changes once
  per step.
- **Images by reference.** Live Meta requests upload each delivered image once to
  the [Files API](https://dev.meta.ai/docs/file-handling) (`purpose=user_data`,
  24-hour expiry) and send its `file_id`, so later turns no longer resend base64.
  A failed upload leaves that image inline and is not retried for five minutes.

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
