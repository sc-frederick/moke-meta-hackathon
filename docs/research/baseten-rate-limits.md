# Baseten rate limits and caching

Checked 2026-10-31 with the Baseten hackathon key and `meta-models/muse-spark-open-1026`.
The probes sent synthetic text only (repeated policy lines), with `max_tokens` 16 to 24 and
`reasoning_effort: "low"`. Together they used about $2 of credit at Baseten's list prices.

## What limits the key

- **Reported limits.** Every response carries `x-ratelimit-limit-requests: 100` and
  `x-ratelimit-limit-tokens: 2000000`. The documented tier defaults top out at 120 requests and
  1,000,000 tokens a minute ([Pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits#default-limits-by-account-tier)),
  so the key's own headers are the authority. Meta's team key reports 3,000 and 4,000,000 with
  the same header names.
- **Requests, not tokens, bind.** Sixty concurrent requests with a 43,353-token prompt (about
  2.6M tokens in 5 seconds, 99.8% cached) produced one 429. That response reported
  `x-ratelimit-remaining-requests: 0`. Remaining tokens stayed between 1.93M and 2.0M
  throughout.
- **The request limiter is sharded.** `x-ratelimit-remaining-requests` never exceeded 50 and
  varied between responses in the same burst (0, 2, 29 to 50), so it reports one of several
  buckets. A client should treat a low value as a hint and pace below the whole limit.
- **429 shape.** The body is `{"error":"Rate limit exceeded"}` and there is no `Retry-After`.
  Baseten documents the same retry treatment for 429 and 529, and asks clients to honour
  `Retry-After` on 529 ([Inference errors](https://docs.baseten.co/inference/errors#529-overloaded)).
- **Credits cannot be read with this key.** `GET /v1/model_apis/{slug}`,
  `/v1/model_apis/usage` and `/v1/billing/model_apis` return `PERMISSION_DENIED`. The
  hackathon key is inference-only, so the remaining credit is visible only in the Baseten
  dashboard's billing page.

## Session affinity and the prompt cache

| Probe                                          | Cached share | Workers |    p50 |
| ---------------------------------------------- | -----------: | ------: | -----: |
| 32 concurrent, one affinity key, prefix warmed |        99.7% |       1 |  3.2 s |
| 32 concurrent across 8 keys, each key warmed   |        99.7% |       2 | 2.25 s |
| 12 conversations × 4 turns, one shared key     |        91.7% |       1 | 1.86 s |
| 12 conversations × 4 turns, no affinity header |        88.7% |       3 | 1.84 s |

- A prefix cached under one `x-session-affinity` value was never reused by requests sent with a
  different value: eight new keys each reported 0 of 24,352 tokens cached, on eight different
  workers. Requests with no header reused it (24,320 cached), so Baseten's router does consider
  prefix overlap, but an affinity value overrides that choice.
- Splitting sheet reviewers across several keys would therefore pay the shared prefix once per
  key. One key per shared prefix, the existing design, gives the best cache share. Sixteen sheet
  reviewers send about 40 requests a minute on that key, within Baseten's guidance of about 60
  a minute for one session.
- Recorded Baseten packet requests from 2026-10-28 and 2026-10-29 (128 requests) were 79.8%
  cached. Twelve requests whose cached prefix fell below 60% of the previous prompt accounted
  for 35% of the uncached input. Those reviews predate session affinity and the 4-image window
  step. At list prices ($1.25 input, $0.15 cached input and $4.25 output per million tokens,
  [Baseten model library](https://www.baseten.co/library/muse-spark-open/)), uncached input was
  56% of their cost, so the cache share remains the main cost lever.

## Live parallel review with the pacer

On 2026-10-31 the Brewery packet (project 01, 29 sheets) ran an Initial Review on Spark Open
through the real packet service, with the Meta key for SAM, the default parallel settings (16
Baseten sheet reviewers) and a 600-call budget. The harness was a local script outside the
repository.

| Measure                                     | Result                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| Time to the call budget                     | 36.4 min; the review paused at 600 calls                   |
| Coordinator setup                           | 63 requests, about 25 min, 92.6% cached                    |
| Sheet reviewers at once                     | 16                                                         |
| Baseten responses                           | 477, all HTTP 200; no 429 or 529                           |
| Lowest `x-ratelimit-remaining-requests`     | above 5 on every response                                  |
| Sheets finished before the budget           | 13 of 29; 82 findings recorded                             |
| Cached share (473 completed model requests) | 87.4%                                                      |
| Cost at list prices                         | $10.35 (3.62M uncached, 25.1M cached, 0.48M output tokens) |

One sheet reviewer stopped when a stream returned HTTP 200 but did not complete. Baseten
documents that a stream can end early without an error event
([Streaming responses](https://docs.baseten.co/inference/errors#streaming-responses)). It
was not a refusal, so it was not resent.

The setup stage ran long because Spark Open reviewed sheets there: it rendered 24 sheets and
recorded 10 findings and a coverage batch before ending setup, although the setup instructions
ask only for project configuration and sources. Sheet fan-out began about 25 minutes in.

### Where the uncached input came from

- Sheet reviewers' first requests were 2% of the uncached input: they averaged 20,029 cached
  and 2,054 uncached tokens, so warming the shared prefix before fan-out works.
- 49 requests whose cached prefix fell below 60% of the previous prompt were 45% of the
  uncached input. In sheet reviewers the cache fell back to the shared prefix of about 21,000
  tokens, the position of the conversation's first image. These are the 8-image window's
  steps: dropping the oldest images rewrites the first image's position.
- Replaying the 30 journal transcripts through alternative windows, with images costed at
  7,000 tokens to match the measured prompt totals, gave these prefix-stable shares:

  | Window                               | Share | Images per request |
  | ------------------------------------ | ----: | -----------------: |
  | Current: drop the oldest 4 at a time | 89.6% |               5.03 |
  | Drop the oldest 8 at a time          | 90.6% |               4.56 |
  | Keep the first 2 and the latest 6    | 87.9% |               5.38 |

  Keeping early images moves each eviction later in the prompt but evicts on every turn, which
  costs more. The best alternative gains one point and removes a tenth of each request's images,
  so the window stays as it is. Baseten's 8-image limit keeps Spark Open packet reviews near
  88 to 90% cached; Meta, which keeps every image, measured 91 to 95% on the same packets
  ([fast initial review validation](fast-initial-review-validation.md)).

## Decisions

1. Pace every request on a key in one process through a shared bucket for requests and
   estimated tokens. Each bucket holds half a minute of allowance and learns its limits from
   response headers.
2. Wait for capacity before the durable attempt is recorded, so a cancel or shutdown during the
   wait leaves no unresolved attempt, and the request deadline does not include the wait.
3. Treat a 429 or 529 as a refusal shared by every conversation on the key: one cooldown,
   honouring `Retry-After`, otherwise 2 seconds doubling to 60. Resend the refused request in
   the same admitted attempt for up to 10 minutes. The previous adapter resent each request
   six times on its own timer, about 90 seconds in total, and then stopped the review as
   uncertain with a message saying it might have been charged.
4. Run 16 Baseten sheet reviewers at once instead of 4.
5. Keep one affinity key per shared prefix, and keep the current image window.

## Sources

- Baseten: [Pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits),
  [Inference errors](https://docs.baseten.co/inference/errors),
  [Configure HTTP clients](https://docs.baseten.co/inference/http-client-configuration#implement-retries),
  [Request lifecycle](https://docs.baseten.co/deployment/autoscaling/request-lifecycle),
  [Muse Spark Open](https://www.baseten.co/library/muse-spark-open/).
- Client-side limiter designs found with Exa:
  [Anvil's per-provider RPM and TPM buckets](https://github.com/esanmohammad/Anvil/blob/main/packages/agent-core/src/router/rate-limiter.ts),
  [dsh-llm-rate-limit](https://github.com/Asong6824/dsh-llm-rate-limit) (FIFO admission, shared
  cooldown, usage reconciliation) and
  [Nucleo's admission accounting](https://docs.redouble.ai/nucleo/current/harness-llm-internals.html)
  (reserve before the call, roll back only when the call never happened).
- Repository: `backend/inference/pacing.ts`, `backend/inference/provider.ts`,
  `backend/packet-review/service.ts`, `docs/research/audit-3-provider-timeout.md`.
