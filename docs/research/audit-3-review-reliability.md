# Audit 3 review reliability and source evidence

Question: what explains repeated unresolved Muse Spark Open reviews, and what
changes improve reliability without replaying uncertain paid requests or treating
model coverage as proof of understanding?

Research used Exa search and page retrieval through Executor on 2026-10-29.
Primary sources were retrieved in this session, rather than inferred from search
snippets.

## Evidence and decisions

- The audited adapter applied a 60 second request timeout to both selected-count
  and full-packet reviews. Audit records include failures whose final requests
  ran for approximately that duration. This is consistent with a client timeout,
  but does not establish that every observed failure shared that cause.
- [Baseten HTTP client configuration](https://docs.baseten.co/inference/http-client-configuration)
  says to include expected inference, capacity wait and a buffer in the timeout.
  Streaming needs enough time before headers and between chunks. The full-packet
  adapter now allows five minutes per request, while explicit test configuration
  still takes precedence. The small selected-count adapter retains its minute.
- [Baseten reasoning](https://docs.baseten.co/inference/model-apis/reasoning)
  documents that Muse Spark Open always reasons and that deeper reasoning can
  increase latency. Packet reviews already request high reasoning. Increasing
  Modal CPU cannot accelerate the separately hosted inference model; it can help
  PDF rendering and local work only. No unverified claim of an inference speedup
  is made.
- [Baseten inference errors](https://docs.baseten.co/inference/errors) distinguishes
  HTTP errors from incomplete streams. A new request after an interrupted stream
  is a retry, not resumption. The application's existing no-automatic-replay
  policy remains in force. Safe receipts now retain category, phase, elapsed
  duration and HTTP status, never the raw provider body, prompts or credential.
- The actual Pause operation compared its displayed version with a version
  incremented by ordinary progress. Pause/cancel now tolerate intervening progress
  only while their current state is compatible. Resume remains strict and cannot
  replay an unresolved provider attempt.
- Active execution time now accumulates across running intervals. Pauses,
  uncertainty and cancellation retain that duration. Cancelling preserves the
  failure explanation and safe diagnostics instead of replacing their meaning.

## Source accuracy

The live audit proved supplied page 2 contained calculations and an input/output
matrix that one model run called absent. A better prompt alone cannot establish
that this is fixed. Packet prompt v2 requires a literal page-content inventory,
legible table crops, and an explicit search for contradictory content before an
absence claim. The record tool requires fresh inspection of every frozen page,
a targeted detail at the claimed location, and a structured search and
permit-stage basis. It rejects absence claims whose own search reports
contradicting evidence, including Needs input recommendations. A plain final
model response without the structured finish record is retained as a partial
summary and the review stops as failed; it cannot silently become a completed
source review after a rejected finding.

These host checks enforce evidence collection, not semantic truth. The live
acceptance rerun must compare returned claims with visible battery, NAC voltage
and matrix content. No additional reviewer count is invented: this harness still
uses sequential discipline passes. An independent model verifier would be a
separate orchestration feature and is not represented as present.

## Regression proof

`tests/smoke/audit-3-runtime.test.ts` uses the actual packet service, durable
model adapter and SQLite state. It proves safe HTTP diagnostics and no replay,
version-tolerant Pause, waiting-time exclusion on cancellation, and rejection of
a missing-calculation finding after only a whole-page glance without its source
search and detail inspection. It covers missing, not shown, omitted and does not
contain language without exempting recommendations, and diagnoses a real SDK
deadline as timeout rather than an explicit caller cancellation. The existing packet and selected-execution suites
also exercise the unchanged replay fences.

## Remaining uncertainty

The prior audit did not retain provider failure categories, so it cannot identify
all original external failure causes. A five-minute timeout and better diagnostics
must be evaluated against the same live drawing sets. Source-search records are
model-authored; satisfying the collection gate does not prove that a visible
table was correctly read or that any engineering finding is adequate.

## Native retest isolated the HTTP 400 root cause

The follow-up Windows retest retained safe status diagnostics and showed HTTP
400 after roughly 9–10 full pages, and after repeated crops on the three-page
set. This is a distinct, now reproduced cause rather than evidence for the
initial timeout hypothesis.

[Baseten's vision limits](https://docs.baseten.co/inference/model-apis/vision)
cap Muse Spark Open at **eight images per request**, counting historical image
parts in the conversation. The old packet adapter retained every image. A fresh
synthetic diagnostic with nine tiny tiles returned HTTP 400 with the explicit
reason `Too many images: 9 (max 8)`; a separate eight-tile request returned HTTP 200. Neither diagnostic replayed an unresolved review.

The corrected Baseten adapter retains the newest eight images in each wire
request. All source metadata remains in context and all original pixels remain
in the durable journal. Omitted pixels have an explicit notice requesting a fresh
render before a new claim. The rendering tool rejects a ninth image in one tool
batch before generating or recording that evidence, so newly requested batches
cannot silently lose their first images. Other model routes retain their own
existing image policy.

A live diagnostic through the actual SDK and corrected admission adapter started
with twelve source images and sent eight, returned HTTP 200 on one request, and
left the original transcript unchanged. Regression tests prove the same wire
bound, preservation of the newest image bytes and all metadata, the eight-render
batch limit, and safe image/context rejection classification. A bounded provider
error parser stores only an allowlisted reason and numeric request shape; raw
error text and echoed inputs are discarded.
