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

Packet review uses high reasoning and automatic Pi compaction for long
conversations. The installed Meta catalog gives Spark 1.3 and Wonder a
1,048,576-token context and a 131,072-token output limit. Meta documents the full
context window in its [model catalog](https://dev.meta.ai/docs/models). Baseten
advertises a [1M-token context for Spark Open](https://www.baseten.co/blog/muse-spark-open-launch/)
but does not publish a separate serving output ceiling there. The desktop leaves
Baseten's output parameter at its API default instead of imposing the older
4,096-token application limit. These capability sources were checked on
2026-10-28.

A packet review defaults to no application call ceiling. An optional user call
budget counts model and SAM requests together. Reaching it pauses work and keeps
the review ledger; explicitly extend the budget to resume. Packet review has no
separate two-SAM cap or six-image context window. The host still bounds transport
memory to 64 MiB of decoded image data and 72 MiB per serialized request. Those
are application memory bounds, not provider token maxima. Image-token accounting
and cost can remain unknown.

The older selected-count execution adapter keeps its narrower admission limits
for compatibility. Those limits do not define ordinary packet review.

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
