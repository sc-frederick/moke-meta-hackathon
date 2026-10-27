# Inference setup

The root `.env` is ready for the hackathon keys. Fill in these two entries:

```dotenv
MODEL_API_KEY=
BASETEN_API_KEY=
```

`MODEL_API_KEY` holds the Meta key, matching the name in
[Meta's quickstart](https://dev.meta.ai/docs/quickstart). `BASETEN_API_KEY` holds
the Baseten key. Keep each provider's key with its own endpoint.

For a fresh checkout, create the local file with `cp .env.example .env`.
The existing `.gitignore` excludes `.env` and `.env.*`, with an exception for the
blank `.env.example` template. Keep that template free of credentials.

## Configuration

| Variable                  | Default or purpose                                            |
| ------------------------- | ------------------------------------------------------------- |
| `APP_STAGE`               | `development`                                                 |
| `MODEL_API_KEY`           | Meta hackathon key, initially blank                           |
| `META_API_BASE_URL`       | `https://api.meta.ai/v1`                                      |
| `META_TEXT_MODEL`         | `muse-spark-1.3`                                              |
| `META_WONDER_MODEL`       | `muse-wonder-1.0`                                             |
| `META_IMAGE_MODEL`        | `muse-image-1.0`                                              |
| `META_TRANSCRIBE_MODEL`   | `muse-voice-transcribe-1.0`                                   |
| `META_SEGMENTATION_MODEL` | `sam-3.1`                                                     |
| `BASETEN_API_KEY`         | Baseten hackathon key, initially blank                        |
| `BASETEN_API_BASE_URL`    | `https://inference.baseten.co/v1`                             |
| `BASETEN_MODEL`           | `meta-models/muse-spark-open-1026`, required by the hackathon |

These entries establish configuration for the upcoming inference integration.
The application does not call the providers yet. Bun loads the root `.env` during
local development; restart `bun run dev` after editing it. Provider requests and
key access belong in the Bun backend. Keep keys out of Svelte components, the
renderer bridge, logs, and variables prefixed with `PUBLIC_` or `VITE_`.

The packaged backend disables automatic dotenv loading. This local file is not
packaged credential delivery; that needs explicit backend configuration when
inference is integrated.

## Manual checks after adding keys

The following commands are optional and send real requests. From the repository
root in Bash, load the file into the current shell:

```sh
set -a
. ./.env
set +a
```

List the hosted models enabled for the Meta account:

```sh
curl --fail-with-body --silent --show-error "${META_API_BASE_URL}/models" \
  -H "Authorization: Bearer ${MODEL_API_KEY}"
```

The catalog describes Meta's offerings. Actual hackathon access and free usage
depend on the grant; the list request checks availability for your key.
[Meta's model catalog](https://dev.meta.ai/docs/models#list-models-via-the-api)
documents this endpoint.

Check Baseten Chat Completions with the exact model ID from the supplied
hackathon instructions:

```sh
curl --fail-with-body --silent --show-error "${BASETEN_API_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${BASETEN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-models/muse-spark-open-1026","messages":[{"role":"user","content":"Hello!"}]}'
```

Read the answer from `choices[0].message.content`, as described in
[Baseten's quickstart](https://docs.baseten.co/quickstart). Public examples use
`meta-models/muse-spark-open`; keep the `-1026` suffix for this hackathon key.

See the [model reference](models.md) for capabilities and provider guides.
