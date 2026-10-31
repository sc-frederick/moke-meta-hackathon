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
5. Keep one affinity key per shared prefix.

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
