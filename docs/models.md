# Model reference

Checked on 2026-10-27. This covers the models on
[Meta's catalog](https://dev.meta.ai/docs/models) and the Baseten model in the
organizer's supplied hackathon screenshot. Configure keys using
[Inference setup](inference.md).

## Meta Model API

Base URL: `https://api.meta.ai/v1`. Authenticate with the Meta `MODEL_API_KEY`.
[Meta's quickstart](https://dev.meta.ai/docs/quickstart) documents the connection.

| Model                  | API model ID                | Input                          | Output and use                       |
| ---------------------- | --------------------------- | ------------------------------ | ------------------------------------ |
| Muse Wonder            | `muse-wonder-1.0`           | Text, image, video, audio, PDF | Text; complex coding and agent tasks |
| Muse Spark             | `muse-spark-1.3`            | Text, image, video, audio, PDF | Text; reasoning, coding, tools       |
| Muse Image             | `muse-image-1.0`            | Text, image                    | Generated or edited images           |
| Muse Voice Transcribe  | `muse-voice-transcribe-1.0` | Audio                          | Transcripts                          |
| Segment Anything Model | `sam-3.1`                   | Text prompts, image, video     | Object boxes and masks               |

Spark also has `muse-spark-1.2` and `muse-spark-1.1`. Contributor variants are
`muse-spark-1.3-contributor` and `muse-spark-1.2-contributor`; these permit training
use of content. Our defaults use Standard mode. Wonder and all Spark versions
have a 1,048,576-token context window. Wonder Full is available only through
Muse Code subscriptions, without a Model API ID.
[Meta's catalog](https://dev.meta.ai/docs/models) lists these versions and access modes.

### Text, reasoning, and tools

Wonder and Spark support Responses, Chat Completions, and Messages. Choose the
model ID for the workload and use the matching API's request format. See
[Meta's quickstart](https://dev.meta.ai/docs/quickstart) for a Responses example
and [the catalog](https://dev.meta.ai/docs/models) for model capabilities.

### Image generation and editing

Use Muse Image through `POST /v1/images/generations`, `POST /v1/images/edits`, or
Responses for edits across conversation turns. Reference images can guide the
result. See [Image generation](https://dev.meta.ai/docs/image-generation).

### Transcription

Use `POST /v1/asr/transcribe` for recordings and
`wss://api.meta.ai/v1/asr/realtime` for live audio. Features include speaker
labels, speech-turn detection, vocabulary biasing, and 25 languages. Transcripts
have turn timestamps. This model does not generate speech.
See [Speech to text](https://dev.meta.ai/docs/speech-to-text), including its
WebSocket authentication handshake.

### Segmentation

SAM 3.1 finds objects using text prompts or point and box prompts. It returns
segmentation geometry and tracks objects through video. Use Responses, with
Files for reusable video uploads. See
[Media segmentation](https://dev.meta.ai/docs/media-segmentation).

## Meta open-weight models

These are separate from Meta's hosted Model API model IDs.

| Model           | Input and output                  | Context                | Access                           |
| --------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Muse Spark Open | Text, image, video, audio to text | 1,048,576 tokens       | Hosted provider or self-hosted   |
| Muse Glimmer    | Text, image to text               | 128K tokens by default | Self-hosted or separate provider |

[Muse Spark Open](https://dev.meta.ai/docs/muse-spark-open) uses a mixture of
experts with 816B total and 42B active parameters. BF16 and NVFP4 checkpoints are
available under the Muse Model License. We will use the Baseten hackathon
endpoint below for hosted access. Meta also documents
[other providers and self-hosting](https://dev.meta.ai/docs/muse-spark-open/deploy).

[Muse Glimmer](https://dev.meta.ai/docs/muse-glimmer) is a dense 30B model
distilled from Spark, released under Apache 2.0. Local use needs downloaded
weights and a serving runtime. Hosted access requires a separate provider;
it is not served by Meta Model API. See
[Glimmer inference](https://dev.meta.ai/docs/muse-glimmer/deploy).

## Baseten hackathon: Muse Spark Open

| Setting                     | Value                                             |
| --------------------------- | ------------------------------------------------- |
| API key variable            | `BASETEN_API_KEY`                                 |
| Base URL                    | `https://inference.baseten.co/v1`                 |
| Endpoint                    | `POST /chat/completions` relative to the base URL |
| Required hackathon model ID | `meta-models/muse-spark-open-1026`                |
| Protocol                    | OpenAI-compatible Chat Completions                |
| Input                       | Text, image, video, audio                         |
| Output                      | Text, with reasoning support                      |

The organizer's supplied `image.png` is the source for the `-1026` model ID and
the restriction that the hackathon key works only with this model. Public
Baseten examples use `meta-models/muse-spark-open`. Replace that public ID with
`meta-models/muse-spark-open-1026` in every hackathon request.

The supplied instructions describe Muse Spark Open as always reasoning. Read
the final answer from `choices[0].message.content` and consult the reasoning
guide when integrating reasoning output or streaming.

[Meta's Baseten deployment guide](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/hosted/baseten.md)
documents the provider's full 1,048,576-token context and multimodal inputs.
[Baseten's model page](https://www.baseten.co/library/muse-spark-open/) describes
coding, agent workflows, and tool use. Hackathon quotas and access follow the
organizer's grant; public per-token pricing does not define that grant.

Provider guides:

- [Quickstart](https://docs.baseten.co/quickstart)
- [Model APIs and Chat Completions](https://docs.baseten.co/inference/model-apis/overview)
- [Reasoning](https://docs.baseten.co/inference/model-apis/reasoning)
- [Vision](https://docs.baseten.co/inference/model-apis/vision)
- [Audio](https://docs.baseten.co/inference/model-apis/audio)

For hackathon access issues, use the Baseten channel in the hackathon Discord,
as directed in the supplied instructions.
