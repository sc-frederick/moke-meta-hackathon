# Fast initial review: upload, storage, parallel calls and preseeding

Checked 2026-10-29. Question: why does **Push to cloud** spend so long uploading
before review starts, what would make reviews finish in minutes rather than 40+,
and what should a one-click **Initial Review** start? Sources are Modal, Meta Model
API and Baseten documentation fetched with Exa through Executor, the installed
`modal@0.11.1` and Pi sources, and one bounded Modal benchmark. The benchmark sent
random bytes only; it made no model requests and uploaded no drawings or credentials.

Parallel per-sheet review is being built separately in
`feat/parallel-sheet-review`: one setup conversation, one Pi child per sheet, one
cross-sheet conversation, inside one sandbox on Meta. This note does not repeat that
design. It covers what surrounds it: transfer, storage, provider settings and the
initial-review request.

## Decisions

Recorded 2026-10-29 from the project owner:

- The proposed changes are accepted. Work starts only after the current review
  threads finish; nothing has been sent to them.
- **Cached-input target: at least 90%** of prompt tokens per review, measured as
  `cacheRead / (input + cacheRead)` across all model calls.
- **Seed every project.** The drawing sets are sanitized, so uploading source files
  to Modal and Meta at import time is approved for all projects.
- **Initial Review button**: one button that sends a high-quality, preset initial
  QA request instead of a typed prompt. It is visible only during the initial
  review phase. Once a revised set is uploaded it disappears, and the reviewer
  works from typed prompts and suggested prompts.

## Implementation status

Implemented 2026-10-30 (cloud worker protocol 4; publish a new worker image before use):

- **Storage cache.** A per-workspace Modal Volume v2 holds immutable package files by
  SHA-256. Source PDFs and renders seed in the background after import. Send uploads the
  database and files the cache lacks; the worker fills the rest from a read-only mount
  and checks each hash. Uploaded files are copied into the cache from the input
  snapshot, and result downloads reuse matching local artifacts. See
  [cloud reviews](../cloud-reviews.md#workspace-cache).
- **Prompt cache.** Shared `prompt_cache_key` per prefix with 24-hour retention on Meta,
  `x-session-affinity` on Baseten, shared fields first in sheet inputs, a warmed prefix
  before fan-out, a stepped image window, and per-review and per-sheet cached share in
  diagnostics. An offline test asserts each request extends the previous one byte for
  byte. See [inference](../inference.md#prompt-caching-and-request-images).
- **Meta Files API.** Live Meta requests reference uploaded images by `file_id`.
- **Render concurrency.** PDF jobs run up to four at a time (one fewer than the cores).
- **Progressive findings** in the cloud card, and the **Initial Review** button
  (`initial-review-v1`).

Live validation on 2026-10-30 is in [fast-initial-review-validation.md](fast-initial-review-validation.md):
the 29-sheet Brewery set took 14.3 minutes on the Windows app at 91.2% cached and 15.4
minutes in the cloud at 94.9% cached, and a cloud Send dispatched 5 s after the click.
It also added two fixes: Meta's intermittent 404 `model_not_found` is resent like a rate
limit, and result files download eight at a time.

A live probe on 2026-10-30 (one synthetic image, six minimal-reasoning calls, file
deleted afterwards) answered two open questions below: Meta accepts `file_id` images in
`function_call_output`, and `prompt_cache_retention: "24h"` is accepted, with the second
request 99.1% cached. Still open: Meta's cache share on a real packet review, background
responses, an adaptive rate limiter, and lower per-sheet reasoning effort.

## Summary

1. **Upload time is set by the uplink, not by Modal.** Sandboxes start in about a
   second. The review package uploads at the reviewer's measured uplink speed
   (about 1.8 MiB/s), so the observed 506 MiB package costs about 4.5–5 minutes
   before review can begin. Warm sandboxes and parallel copies cannot remove that.
   The fix is to send fewer bytes.
2. **Cache source files by content hash in Modal storage and fill the cache when a
   PDF is imported**, not when the reviewer presses Send. Package artifacts are
   already named `artifacts/<sha256>.pdf|png`, so a push only needs the database,
   journals and artifacts missing from the cache. A set with no new revisions
   uploads no PDFs.
3. **Engineer for a 90%+ cache hit rate.** Recorded Baseten reviews reached 79.8%
   with no cache routing at all. Pi provides a session ID, but
   `backend/inference/provider.ts` drops it when it rebuilds request options, so
   no cache key or session-affinity header is sent today. The rolling image window
   and compaction also rewrite earlier history, which discards the cached prefix.
   See [section 3](#3-cache-hit-target-90).
4. **Upload sheet images to Meta's Files API once and reference them by `file_id`.**
   Every turn currently resends every retained image as base64. This also unlocks
   background responses, which avoid long-request timeouts but cap the request
   body at 1 MiB.
5. **Initial Review should be a versioned request, not typed text**, started from
   one button with the whole set, all detected disciplines, Meta Spark 1.3 and
   cloud execution when configured. Show findings as each sheet finishes, before
   the final package returns.

## 1. Where Push to cloud spends its time

### Current path

`backend/cloud/modal.ts` resolves the image and secrets, runs a network-blocked
identity probe (2.1 s first time, 0.4 s cached, per `audit-3-cloud.md`), and the
application exports a complete workspace package. `upload` then calls
`sandbox.filesystem.copyFromLocal` once per file, **sequentially**, then
`snapshotDirectory("/moke")` before dispatch. In `modal@0.11.1`,
`copyFromLocal` runs a remote fs-tools exec and streams stdin in 256 KiB chunks
(`dist/index.js:75583`, `STREAMING_STDIN_CHUNK_SIZE`).

The package is the **whole workspace**. The Audit 3 native run uploaded 506.1 MiB
in 297 files spanning 7 projects and downloaded a 506.3 MiB result
(`audit-3-validation.md`). Only one project was under review.

### Benchmark

Run from WSL2 on the development Windows host, assumed to share the Windows app's
network uplink, against `moke-review-engine:d7ba4f874`, 4 CPU / 8 GiB, network blocked.
Data: one 40 MiB file plus forty 1 MiB files of random bytes (80 MiB).

| Operation                                  |        Time | Rate            |
| ------------------------------------------ | ----------: | --------------- |
| `sandboxes.create` returns                 |      202 ms |                 |
| First exec completes                       |      952 ms |                 |
| Upload, sequential `copyFromLocal`         |   51,319 ms | 1.56 MiB/s      |
| Upload, 8 parallel `copyFromLocal`         |   45,424 ms | 1.76 MiB/s      |
| Upload, single tar stream over exec stdin  |   42,424 ms | 1.89 MiB/s      |
| `snapshotDirectory` of the 80 MiB folder   |    3,755 ms |                 |
| Download 48 MiB, sequential `copyToLocal`  |    6,261 ms | 7.7 MiB/s       |
| Download 48 MiB, 8 parallel `copyToLocal`  |    3,759 ms | 12.8 MiB/s      |
| New 1 CPU sandbox: create + first exec     |    1,279 ms |                 |
| `mountImage` of that directory snapshot    |      301 ms |                 |
| Read all 80 MiB from the mounted snapshot  |    1,165 ms | ~69 MiB/s       |
| Raw uplink baseline, 20 MiB HTTP POST (×2) | 10.2–11.8 s | 1.69–1.96 MiB/s |

Both sandboxes were terminated (`sb-01M64EKAQXN0GXYNRZS7C9PCH3`,
`sb-01M64EQP7ZQ6B0E56X1G1RSWPS`); the snapshot had a one-hour TTL.

**Conclusions.** Modal's upload path matches the raw uplink, and parallelism adds
only about 12%. At that rate, 506 MiB takes about 4.6 minutes. Snapshotting the
same 506 MiB would take about 24 s if it scales linearly from the measured 80 MiB
(not measured). Returning the full package takes another 40–65 s. Sandbox start,
which a warm pool would save, is about one second. Remounting data that is
already in Modal costs well under a second.

**What the bytes are.** The Windows development workspace (not the 506 MiB audit
workspace) contains a 3 MB `app.sqlite`, 7 source PDFs totaling 47.3 MiB, 124
rendered PNG artifacts totaling 118.1 MiB, and 16 closed execution journals
totaling 92 MiB. Everything except the database and journals written since the
last push is immutable and content-addressed. Copied journals are historical only;
a cloud run never resumes them.

Not measured: local package export time on Windows.

## 2. Storage design for "use the cached PDF"

The goal is to upload a source file once, ideally in the background right after
import, and have each review sandbox read it from Modal storage.

| Option                                               | How it fits                                                                                                                                                                                                                                                                                 | Limits                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Named Volume v2, content-addressed** (recommended) | `client.volumes.fromName(name, { createIfMissing: true, version: 2 })`; mount with `volumes` in `sandboxes.create`, read-only in review sandboxes via `withMountOptions({ readOnly: true })`. Files never change once written under their hash. `sync /cache` commits explicitly (v2 only). | The JS SDK has **no Volume upload API** (Python's `batch_upload` only), so writes go through a short-lived uploader sandbox using `copyFromLocal`. Volumes are mounted at create time. |
| Directory-snapshot chain                             | Already used for checkpoints. `mountImage` measured at 0.3 s. Mount the previous cache snapshot, upload only missing hashes, snapshot again.                                                                                                                                                | Each round re-snapshots the whole cache. Directory snapshots default to a 30-day TTL (configurable, including no expiry).                                                              |
| R2 bucket + `CloudBucketMount`                       | Desktop uploads with S3 multipart; sandboxes mount the bucket read-only. Uploads need no running sandbox and can resume.                                                                                                                                                                    | Needs separate R2 credentials in a Modal Secret and in the desktop. Uplink speed is unchanged. Mountpoint semantics (no append or seek-write).                                         |

**Recommended flow.**

1. On PDF import or revision import, the backend queues a background "seed" job:
   list cached hashes, then upload missing artifacts to the Volume through an
   uploader sandbox (0.25 CPU, a short `idleTimeoutMs`, no network, no provider
   secrets). The same job seeds new renders and closed journals by hash as they
   appear. A 47 MiB drawing set takes about 25 s at the measured uplink, while the
   reviewer is still setting up sheets.
2. On Send, the package keeps today's complete-package manifest, but the upload
   step skips any artifact whose hash is already in the cache. The worker
   hard-links or copies cached files into `/moke/input` and verifies each SHA-256
   against the manifest. It is the same integrity check, fed from a different
   place, so the current whole-workspace replacement semantics stay intact.
   Unrelated projects stop costing upload time without needing the unresolved
   project-scoped merge protocol.
3. The pre-dispatch checkpoint then covers only the small, changed part of
   `/moke`. Cached artifacts are immutable and live on in the Volume.
4. On return, seed the download directory from local artifacts with matching
   hashes before `downloadCloudPackage`. `downloadedCloudFileMatches` already
   skips verified files, so only the database, journals and new crops come back.

With seeding, a typical push uploads the 3 MB database plus any new journal, about
2 s at the measured uplink. Seeding is approved for every project. It still needs
a cache retention rule and a delete path for removed projects. The cloud
composer's current disclosure says files leave the device at Send; update it to
say source files are synced to cloud storage after import.

**Warm sandboxes.** The current single-use warm pool (`bun run modal:warm`) saves
about a second per review and keeps paying until it expires. It is not worth
running as standing capacity. What is worth doing is starting the review sandbox
speculatively when the reviewer opens the cloud composer, and terminating it if
they leave. That overlaps the cache delta upload with the reviewer choosing
options.

## 3. Cache-hit target: 90%+

### Baseline

Read from a copy of the Windows development database (`packet_review_attempts`):
16 recorded packet reviews, all on Baseten, 128 model calls and 5.16M prompt
tokens. pi-ai stores `usage.input` as uncached tokens only
(`openai-completions.js:1186`), so the hit rate is `cacheRead / (input +
cacheRead)`.

| Measure                      | Result |
| ---------------------------- | -----: |
| All prompt tokens cached     |  79.8% |
| First call of each review    |  65.7% |
| Later calls                  |  80.5% |
| Later calls below 50% cached | 19/112 |

Per-turn patterns show where the misses come from. Some reviews fall steadily
(99% → 51% over eight turns). Others drop suddenly mid-review to 0–34% and then
recover. No Meta packet reviews were recorded, so Meta's baseline is unmeasured.

### What breaks the cache today

1. **No routing key.** `requestOptions` drops Pi's `sessionId`, so Meta gets no
   `prompt_cache_key`. Baseten gets no `x-session-affinity` either. The fallback
   Baseten model also lacks `compat.sendSessionAffinityHeaders`, so pi-ai would
   not send the header even if the session ID were passed
   (`openai-completions.js:544`). Requests can land on replicas without the
   prefix, which fits the sudden drops.
2. **History rewrites.** `boundedImageContext` replaces images that fall out of
   its window with a text notice. That applies to Baseten packet reviews (8
   images) and every non-packet call (6 images, 2 MiB). Each slide changes an
   earlier position in the prompt, so everything after it is recomputed, which
   fits the steady declines. Pi compaction (131,072-token reserve) also rewrites
   history once the context nears the window.
3. **Cold starts.** Each review's first call finds no prefix unless an earlier
   request sent the same one. Starting 29 sheet children at the same instant
   would make all 29 cold.
4. **Eviction.** The default cache lives in memory and can be evicted between
   turns.

### Rules for 90%+

- **Append-only transcripts.** Never edit earlier turns. On Meta, keep images
  rather than sliding a window. Per-sheet children stay well under the 50-image
  limit, and reaching it should end the child or trigger one planned checkpoint.
  On Baseten, when the 8-image window fills, start a fresh turn from a text
  summary: one planned miss instead of one per turn.
- **One stable prefix, in a fixed order.** Versioned system prompt with no dates,
  counters or request text; tool definitions in a fixed order; the project setup
  record; the sheet inventory; then the child's sheet assignment last. Host notes
  (progress, budgets, warnings) are appended as new messages. The packet prompt
  already ends with its one variable line, `Requested scope`.
- **One routing key per shared prefix**, such as
  `moke:<packetPromptVersion>:<instructionRevision>:<projectId>`. Send it as
  `prompt_cache_key` on Meta and `x-session-affinity` on Baseten, for the setup
  conversation, every sheet child and the cross-sheet pass. Meta warns that
  per-session keys lower hit rates.
- **`prompt_cache_retention: "24h"`** on Meta, so same-day reruns and revision
  re-reviews still hit.
- **Warm the prefix before fanning out.** Start sheet children after the setup
  conversation's first response, or after one minimal request
  (`max_output_tokens: 16`) carrying the shared prefix.
- **Byte-identical media.** Reference images by Files API `file_id`, or replay the
  stored artifact bytes exactly. Never re-render or re-encode an image already in
  the history.

Illustrative arithmetic, not measured: a sheet child with a 21K-token shared
prefix that adds about 4K tokens per turn over 30 turns sends about 2.37M prompt
tokens, of which about 120K are new. That is about 95% cached if every turn hits.
One mid-child miss recomputes the whole context at that point, so a few misses
push a child below 90%. History rewrites matter most.

At Spark 1.3 rates ($0.15 cached, $1.25 uncached per million), 80% cached costs
$0.37 per million input tokens and 95% costs $0.21, about 45% less. If Meta does
not count cached tokens toward its 4M TPM limit (undocumented), caching also
allows more sheets to run at once.

### Measure and enforce

- Report each review's cached share, and each sheet child's, in **Copy review
  diagnostics**. The data is already stored as `cacheRead` on every response
  receipt.
- Offline test, no paid calls: drive consecutive turns through the real provider
  adapter with the recorded transport. Assert that each request's serialized
  `input` starts with the previous request's `input` byte for byte. This catches
  history rewrites, unstable ordering and changing system text in CI.
- Live acceptance on a sanitized set: a bounded Meta review must report at least
  90% weighted cached share. Treat anything under 85% as a regression.

## 4. Provider levers for parallel review

### Meta Model API (selected for parallel review)

- **Rate limits** are per team, per model: `muse-spark-1.3` allows 3,000 RPM and
  4,000,000 TPM. Background-response creation is separately capped at 600 per
  minute. Read `x-ratelimit-remaining-tokens` and back off on 429 with
  `Retry-After`. Prefer an adaptive limiter driven by those headers over a fixed
  sheet concurrency. The docs do not say whether cached tokens count toward TPM.
  Baseten's docs say they do on Baseten.
- **Prompt caching** is automatic prefix caching. `prompt_cache_key` routes
  requests that share a prefix to the same backend. Meta advises one stable key
  per shared prefix, not per session. `prompt_cache_retention: "24h"` asks for
  longer retention on Responses. Cached input costs $0.15 vs $1.25 per million.
  Section 3 gives the prefix and key rules.
- **Current gap.** Pi Durable sets `sessionId` for every generation
  (`pi-durable/dist/harness/generation.js:129`), and pi-ai maps it to
  `prompt_cache_key` (`pi-ai/dist/api/openai-responses.js:267`). Our
  `requestOptions` in `backend/inference/provider.ts` returns a new object without
  `sessionId` or `cacheRetention`, so neither field is sent. Per-session keys
  would also be too fine for children that share a prefix; pass an explicit
  shared key instead.
- **Files API.** `POST /v1/files` with `purpose=user_data` returns a `file-` ID
  usable as `input_image.file_id` or `input_file.file_id` in later requests. Files
  can be up to 1 GiB, count toward a 100 GiB team storage limit, and never expire
  unless `expires_after` (1 hour to 30 days) is set. Today pi-ai serializes every
  retained image as a base64 data URL inside `function_call_output`
  (`openai-responses-shared.js:216`), and stateless replay resends all of them on
  every turn. Over the measured 1.8 MiB/s uplink, a local turn carrying 6 MiB of
  images spends about 3 s just uploading. In the cloud sandbox this matters less.
  Preseeding sheet renders through the Files API makes requests small in both
  places. Untested: whether Meta accepts `file_id` images inside
  `function_call_output`. Meta's docs say images belong in user messages, but the
  parallel-review thread confirmed that base64 images in tool results are read.
- **Background responses** (`background: true`) are exempt from the server-side
  time limit that returns HTTP 504 on long non-streaming requests. Responses can
  be polled, stream-retrieved by ID with `starting_after`, and cancelled. The
  creation body is capped at **1 MiB**, so image-heavy turns need Files API IDs
  first. This is Meta's documented route for long reasoning turns. The 300 s
  client timeout recorded in Audit 3 was on Baseten, which offers no equivalent
  for Model APIs.
- **Reasoning effort** runs `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`
  (Spark 1.3 and Wonder only). Higher effort costs more tokens and time. Packet
  review currently fixes `high`. An initial review could use `medium` or `high`
  per sheet and `xhigh` for the cross-sheet pass. That is a hypothesis to test
  against known findings, not a documented accuracy claim.
- **Parallel tool calls** default to on. `render_sheet` is declared
  `executionMode: "sequential"`, so several crops requested in one turn render one
  after another. Allowing them to run concurrently would use the sandbox's 4 CPUs.
- **Data use.** Content sent on free credits may be used for product improvement,
  and Files API uploads stay on Meta's side until deleted or expired. The
  drawing sets are sanitized and seeding is approved; still set `expires_after`
  and delete files with the project to stay under the 100 GiB team limit.

### Baseten (Muse Spark Open)

Default Model API limits are 15 RPM / 100K TPM (unverified Basic), 120 / 500K
(verified Basic) and 120 / 1M (Pro). Cached and uncached input count equally
toward TPM, so on Baseten caching lowers cost but does not raise concurrency.
Caching is automatic. `x-session-affinity` routes related requests to the same
replica to improve cache hits. A 529 means no serving capacity even
within limits. Async inference exists only for dedicated deployments, not Model
APIs. Baseten's 8-image request window remains in force. At these limits Baseten
supports only a few parallel sheet children, so Meta is the right default for
parallel initial reviews. Baseten remains useful as the open-weight option.

## 5. Initial Review button

A new feature; no equivalent exists in the code. The composer has no suggested
prompts yet (the only suggestions are sheet labels).
`backend/review/prompts/assets/REVIEW_METHOD.md` defines the four passes, and
`docs/inference.md` says Auto routes a whole-set request.

Specified behavior:

- **What it sends.** One click sends a preset, high-quality user prompt through
  the normal message path, so it appears in the conversation as the reviewer's
  message. The text is a versioned template (`initial-review-v1`) whose identity
  is recorded with the prompt hashes, so runs stay comparable.
- **When it is visible.** Only during the initial review phase: the project has
  its first drawing set and no revised set yet. Revised sets are separate
  `Revision` imports linked through `RevisionCorrespondence`. Once a revised set
  is imported, the button is gone for good and the reviewer uses typed prompts
  and suggested prompts. Before it ships, confirm how an initial set made of
  several PDFs is modeled, so a multi-file first set doesn't count as a revision.
- **When it is enabled.** After sheet setup has a frozen inventory. Disabled with
  status while an initial review is running. During the initial phase it can be
  run again, for example after sheet corrections.
- **What it runs.** Whole set, disciplines inferred from the sheet index, all four
  passes, Meta `muse-spark-1.3`, cloud when configured and local otherwise. Show
  this as one summary line beside the button, not a form.
- **Template content.** Record project facts first (jurisdiction, occupancy, code
  editions, areas, service size). Review each sheet for completeness and
  discipline items. Run cross-sheet coordination last. Rank findings by severity,
  state uncertainty explicitly, and never mark coverage complete without
  evidence. Keep the text static: everything project-specific comes from tools
  and the setup record, which keeps the prompt cacheable (section 3).
- **Preseeding at import**, before anyone clicks: render sheet overviews, upload
  source files to the Modal cache, and upload sheet overviews to Meta Files with
  an expiry. Paid model calls start only on click.
- **Progressive results.** As each sheet child finishes, publish its findings
  through `progress.json` as a read-only preview, so the reviewer sees findings
  within minutes and can start correcting. The authoritative import stays the
  complete-package return, which avoids a live database merge.
- **After revisions.** Re-reviews run from typed or suggested prompts. Cached
  source files and a warm 24-hour prompt cache mean unchanged sheets cost little.
  Suggested prompts are a separate feature to design; candidates are "Re-review
  changed sheets" and "Check that prior comments are closed".

## Expected timeline, not measured end to end

| Stage                       | Today (Brewery, 29 sheets)   | With these changes                                      |
| --------------------------- | ---------------------------- | ------------------------------------------------------- |
| Source upload               | ~4.6 min at Send (506 MiB)   | ~0 at Send; seeded in the background after import       |
| Database and journal upload | included above               | about 2 s for a 3 MB database, plus any new journal     |
| Sandbox start               | ~1 s                         | ~1 s, overlapped with option choice                     |
| Pre-dispatch checkpoint     | ~24 s (extrapolated)         | about a second for the changed portion                  |
| Review                      | 33+ min, 220 of 1,276 passes | parallel-review thread estimates 20–25 min at 16 sheets |
| First findings visible      | at the end                   | as the first sheets finish                              |
| Result return               | ~40–65 s download            | database, journals and new crops only                   |

## Unresolved

- Local package export time on Windows.
- Volume v2 read throughput from a sandbox, and uploader-sandbox write speed into
  a mounted Volume (expected to match the uplink).
- Meta's cache hit rate for packet reviews (no Meta reviews recorded yet), and
  whether Meta replays reasoning items into the prefix unchanged across turns.
  The first live Meta run should log per-turn cached share.
- Whether Meta accepts `file_id` images in `function_call_output`, and whether
  cached tokens count toward Meta TPM.
- Accuracy of lower reasoning effort per sheet. This needs a small evaluation set
  with known findings before changing defaults.
- How a multi-PDF initial set is modeled, for the Initial Review visibility rule.

## Sources

- Modal: [Sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots),
  [directory snapshots blog](https://modal.com/blog/directory-snapshots-resumable-project-state-for-sandboxes),
  [Filesystem access](https://modal.com/docs/guide/sandbox-files),
  [Volumes](https://modal.com/docs/guide/volumes),
  [Cloud bucket mounts](https://modal.com/docs/guide/cloud-bucket-mounts),
  [Sandboxes: idle timeouts and readiness probes](https://modal.com/docs/guide/sandboxes),
  [Networking and connect tokens](https://modal.com/docs/guide/sandbox-networking),
  [Warm sandbox pool](https://modal.com/docs/examples/sandbox_pool),
  [JS Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox). Installed
  `modal@0.11.1` type definitions for `VolumeFromNameParams.version`,
  `SandboxCreateParams.volumes` and `cloudBucketMounts`.
- Meta: [Prompt caching](https://dev.meta.ai/docs/features/prompt-caching),
  [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits),
  [File handling](https://dev.meta.ai/docs/file-handling),
  [Image understanding](https://dev.meta.ai/docs/image-understanding),
  [Responses API](https://dev.meta.ai/docs/protocols/responses),
  [Reasoning](https://dev.meta.ai/docs/reasoning),
  [Tool calling](https://dev.meta.ai/docs/tool-calling),
  [Token counting](https://dev.meta.ai/docs/token-counting).
- Baseten: [Pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits),
  [Async inference](https://docs.baseten.co/inference/async),
  [Muse Spark Open](https://www.baseten.co/library/muse-spark-open/).
- Repository: `backend/cloud/modal.ts`, `backend/cloud/transfer.ts`,
  `backend/inference/provider.ts`, `backend/packet-review/service.ts`,
  `docs/cloud-reviews.md`, `docs/research/audit-3-cloud.md`,
  `docs/research/audit-3-validation.md`.
