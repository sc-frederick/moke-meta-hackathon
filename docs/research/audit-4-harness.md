# Audit 4 — inference and review harness

Audited commit: `68deb49100638edc41f8da925ac11d763b7f9627` on `fix/audit-4`,
2026-10-31. Read-only audit; this ledger is the only file written. No provider,
Modal, search, or other live service requests were made. No commits.

## Evidence and limits

Read the project instructions, Effect reference, coding-standards skill, runtime,
inference and model documentation, parallel-review and initial-review research,
Baseten measurements, and prior audit records. Traced packet tool registration,
stage orchestration, request admission, rendering, source retrieval, SAM,
selected-count execution, segmentation experiments, and cloud worker review/export.

`CONFIRMED` means the mechanism is established by source or a local reproduction;
it does not claim a new measured production incidence or performance improvement.
All 12 entries below are CONFIRMED. None relies on a speculative provider limit.

Local verification used Bun **1.4.4**, matching `.bun-version`:

- Inline `bun run -` probes imported the actual workspace provider and pacer with
  recorded transports and fake credentials. Dependencies resolved from Bun's
  existing package cache. No test/source files were created. Captured results:
  - Nine Baseten images, one historical plus eight new: only indices **4–8**
    reached the recorded transport; indices **1–3** were new crops.
  - Forty recorded HTTP 429 refusals: one admitted request ultimately ended
    with **`uncertain: true`**, HTTP 429, despite no accepted generation.
  - `pacer.refused("overloaded", 0, 120000)` returned **60000**.
  - Aborting a Meta generation while its recorded Files upload was held left
    the upload's signal **unaborted**. Once released, generation returned an error
    without dispatching a Responses request.
- Attempted `bun test` on `packet-provider`, `request-pacing`, `packet-parallel`,
  `packet-sam-focus`, `meta-review`, `adaptive-review`, and `packet-sources` smoke
  files. All seven failed to load with **Cannot find package 'effect'** because
  the checkout has no `node_modules`. No assertions ran. Did not install or change
  dependencies. The known WSL clock flakes were not reached.
- Dead-export candidates were checked with whole-repository `rg -l -w`, excluding
  `repos/`, `bun.lock`, and this audit. The apparent one-file exports (`RateLimits`,
  `reportedRateLimits`, `JurisdictionPlace`, `SourceAddress`, `PdfSourceText`,
  `SourceSearchResult`) have internal uses. Experiment modules have script/test
  consumers. No substantial dead-code deletion is claimed.
- Excluded prior fixed timeout/output-policy, affinity, parallel SAM-admission,
  source-verification and missing-notes findings. The prior unowned-compaction
  observation was already recorded in Audit 3 and is not re-reported.
- Excluded a suspected Meta 50-image ceiling: newer `docs/inference.md:57`
  records acceptance of 300 small tool-result images. Also excluded a suspected
  omitted-system-prompt pacing bug: a recorded 90,000-character system prompt
  reserved 22,501 tokens through the real SDK normalization path.

Counts: **12 findings; high 4, medium 8, low 0**. Categories: **inference 3,
perf 3, correctness 5, standards 1, dead-code 0, slop 0**. H-12 requires a product
decision. The other entries restore existing boundaries or remove redundant work.

## Packet service and prompt owner

Keep H-01–H-04 and H-11 with one implementer because they edit
`backend/packet-review/service.ts`. H-12 shares that file but is decision-gated.

### H-01 — Setup exposes the whole review workflow and has no enforced completion boundary

- **Category:** inference. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:778`, `:1251`, `:1278`,
  `:1490`, `:1653`, `:1926`, `:2078`, `:2178`;
  `backend/review/prompts/review-prompt.ts:103` (coordinator guidance);
  `docs/research/baseten-rate-limits.md:65` (recorded Brewery run).
- **Evidence:** One registry installs every tool for every conversation. Setup
  receives `render_sheet` for any frozen sheet, coverage/finding tools, SAM and
  other review mutations. `outsideSheet` constrains only assigned children.
  `finish_review` rejects setup calls, but neither findings nor coverage do.
  The host starts children only after the coordinator voluntarily yields. The
  full review method and discipline instructions precede the short setup rule.
  Thus an otherwise valid tool sequence can inspect the whole packet during
  setup. The recorded run's 63 requests / approximately 25 minutes / 24 rendered
  sheets / 10 findings follows a path explicitly permitted by this surface.
- **Concrete fix:** Make setup an explicit tool capability set: inventory,
  project configuration, source research and a typed `finish_setup`. Exclude
  coverage, findings, presentation summaries, count segmentation and review
  completion. Enforce stage permissions at execution too, including replay and
  steering. Scope setup rendering to a host-recorded selection of setup sheets;
  provide an explicit bounded selection step when labels are ambiguous. Persist
  setup completion and transition immediately to sheet work, allowing unknown
  configuration fields to remain Needs input. Use a small setup-specific prompt
  and a deterministic setup turn/render ceiling as a fallback; reaching that
  ceiling must preserve unknowns, never fabricate configuration or completion.
  Preserve distinct stable tool lists per role/stage instead of mutating a tool
  list on every turn. Stronger wording alone does not address this mechanism.
- **Proof test:** Extend `tests/smoke/packet-parallel.test.ts` with an adversarial
  setup script requesting coverage, a finding, SAM and a non-setup sheet. Assert
  these are absent from its wire tools and rejected if emitted anyway; no such
  mutations/paid SAM dispatch occur. Assert a saved setup result or bounded
  setup exit starts children and survives restart. Existing scripted setup
  cooperates; it does not test refusal of setup-stage review work.

### H-02 — Sheet assignments do not fence finding writes or segmentation

- **Category:** correctness. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:784`, `:1494`, `:1543`,
  `:1660`, `:1686`, `:1723`, `:1804`, `:2028`.
- **Evidence:** Rendering and coverage call `outsideSheet`; `record_finding`
  does not. Its location validation checks membership in the entire packet,
  and evidence validation checks the shared packet ledger. A child can create
  a finding on another sheet or supply another child's finding ID and overwrite
  it, including changing the summary's owner to itself. A nonempty evidence note
  permits the write without an artifact. `record_finding_summary` checks owner
  only after that ownership has already been replaceable. `segment_objects`
  similarly accepts any shared evidence artifact, without checking assignment.
  This defeats the documented one-sheet boundary under ordinary model mistakes.
- **Concrete fix:** For children, require every finding location and referenced
  evidence artifact to belong to the assigned sheet. Before replacing a finding,
  verify its existing ownership as well as the new locations; reject attempts
  to adopt a peer's record. Apply the same assignment guard before segmentation.
  Leave multi-sheet creation/updates to the coordinator. Centralize this policy
  beside the existing render/coverage guard so new tools cannot omit it.
- **Proof test:** In `packet-parallel.test.ts`, have child A submit a finding
  located on B, update B's existing finding by ID, and segment B's artifact.
  Assert all fail before mutation or SAM dispatch; coordinator updates still
  work. Existing assignment tests attempt an unauthorized render, not these
  writes. No existing test found covering these paths.

### H-03 — One sheet's failed SAM request stops every sheet and the coordinator

- **Category:** correctness. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:1017`, `:1028`, `:1091`,
  `:1104`, `:1206`, `:1244`, `:2644`; `docs/review-runtime.md:51`.
- **Evidence:** The model adapter marks only the owning sheet failed for an
  uncertain child request. SAM's catch instead sets the whole packet state to
  `uncertain`, regardless of `conversationId`. It is also used by automatic
  finding zooms. `focusFinding` catches the rejection and reports a skipped zoom,
  but the global state has already changed; peers then fail `assertActive` and
  coordination cannot proceed. This is separate from Audit 3's fixed
  conversation-scoped _admission_ conflict: dispatch isolation works, failure
  isolation does not. Even a definite SAM HTTP refusal takes this path.
- **Concrete fix:** Resolve the owning sheet from `assignments` in the SAM failure
  path and mark that child failed, retaining its unresolved receipt and blocking
  only its further work. Allow peers and coordination to complete, then derive
  the overall uncertain outcome as for model failures. Preserve global handling
  for coordinator SAM and never resend an uncertain SAM attempt. Classify known
  HTTP refusals separately from ambiguous post-dispatch failures.
- **Proof test:** Extend the parallel SAM test to return an incomplete/failed SAM
  response for A while B's model is held. B must finish, coordination must run,
  and A's attempt must not be resent. Also cover host-triggered focus SAM.
  Existing `packet-parallel.test.ts:494` covers successful concurrent SAM/model
  admission, not failed SAM isolation.

### H-04 — Repeated source retrieval duplicates network work and the persisted source ledger

- **Category:** perf. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:1412`, `:1424`, `:1257`,
  `:2263`; `backend/packet-review/sources.ts:476`, `:484`, `:492`.
- **Evidence:** Every `read_source` invocation fetches again and assigns a new
  UUID, even for the identical URL in the same review. `upsert` keys by UUID, so
  repeated calls append complete duplicate source text. Children initially get
  only source IDs/URLs/titles and have no tool to read the already-retrieved body
  by ID; retrieving a known source again is a natural way to inspect it. Parallel
  children can all perform the same fetch. The full coordinator inventory later
  contains every copy, and every packet save serializes the enlarged ledger.
- **Concrete fix:** Provide review-scoped access to a saved source by ID and
  deduplicate same-review retrieval by canonical URL including the PDF page
  selector. Share in-flight retrievals, return one stable source receipt, and
  give an explicit refresh operation if needed. Do not silently reuse another
  review's historical source as current verified evidence. Keep failed reads
  retryable rather than permanently caching unavailability.
- **Proof test:** Through packet tools with a recorded source transport, make
  two children read the same URL concurrently and subsequently read it by ID.
  Assert one fetch and one saved source with identical IDs/content; separate
  `#page=` selectors must stay distinct. Existing source tests exercise retrieval
  and parsing, not shared packet-level deduplication. Performance magnitude was
  not benchmarked in this audit.

### H-11 — The supposedly shared child prefix is read from mutable global review state

- **Category:** inference. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:1453`, `:1473`, `:2210`,
  `:2252`, `:2262`, `:2325`, `:2437`;
  `tests/smoke/packet-parallel.test.ts:312`.
- **Evidence:** Each queued child reloads the current review and serializes its
  current `projectConfiguration` and `sources` before its assignment. Earlier
  children can call `record_project` and `read_source`, changing both between
  child launches. Children can therefore review against inconsistent project
  assumptions and get different bytes in the advertised shared prefix, despite
  using the same affinity key. The append-only test compares a conversation
  with its own previous request; it does not compare openings across children
  after a peer changes shared state. The stable system/tool prefix still hits;
  this finding does not claim loss of the entire approximately 20k-token prefix.
- **Concrete fix:** At the setup-to-sheets transition persist a canonical setup
  snapshot and serialize every child opening from it in stable order. Children
  should report proposed project-fact corrections in notes for coordinator
  reconciliation, rather than overwrite global configuration. Newly discovered
  sources remain available by ID without changing later children's opening
  prefix. Persist the snapshot for restart/resume; do not merely cache it in RAM.
- **Proof test:** Hold a queued child until an earlier child adds a source and
  attempts to alter occupancy. Compare serialized opening prefixes before the
  assigned-sheet field, and verify every child uses the same setup version.
  Repeat across restart. Existing cache tests do not mutate setup between child
  openings. Actual cache-rate improvement remains unmeasured.

## Review operations and store owner

### H-05 — Every model crop loads the entire workbench snapshot

- **Category:** perf. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/review/operations.ts:54`, `:56`, `:65`;
  `backend/review/store.ts:229`, `:261`, `:268`, `:281`;
  `backend/packet-review/service.ts:1323`, `:2036`.
- **Evidence:** `render` needs one sheet, its revision and an operation receipt,
  but uses `snapshot(projectId, 0)`. That loads all project artifacts, findings,
  accepted facts, checks, conversations, messages, correspondence and up to
  2,000 historical events, as well as the project list. Every crop and automatic
  focus render repeats this under the shared SQL exclusion. `segment_objects`
  also loads a full snapshot to find one artifact. Data volume and parsing cost
  grow with project history; the work is repeated across parallel children.
- **Concrete fix:** Add narrow scoped store reads for render inputs and
  operation receipts, and use the existing artifact lookup for segmentation.
  Preserve project ownership, source version and render-input checks. Keep the
  workbench snapshot for actual workbench callers. This removes serialized SQL
  and Schema work without weakening scoped resource ownership.
- **Proof test:** Populate unrelated messages/artifacts and instrument the SQL
  adapter for a render and segment lookup. Assert only targeted records are read
  while the same output and source rejection behavior remain. Existing rendering
  tests verify output and fencing, not this query shape. No timing claim made.

### H-06 — Identical crops are rasterized again under every new tool task

- **Category:** perf. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:1326`, `:1329`, `:1167`;
  `backend/review/operations.ts:65`, `:82`;
  `backend/documents/documents.ts:159`, `:161`, `:171` (called boundary only).
- **Evidence:** Render reuse matches only `operationId`. Packet tools derive that
  ID from the Pi task, so re-opening a previously rendered page/detail in a later
  task misses reuse. The documents adapter always calls the PDF worker before
  storing content-addressed bytes. On-disk deduplication therefore saves storage
  but not rasterization, worker-slot time or base64 conversion. Re-opening is
  explicitly required after image eviction and occurs between setup/children/
  coordination as well.
- **Concrete fix:** Reuse immutable render results by source hash, page identity,
  rotation/user unit, exact region, effective DPI and renderer version. Preserve
  a distinct operation receipt/association so replay and evidence provenance
  remain correct. Share identical in-flight renders. Implement the lookup in
  review operations/store, coordinating with the documents auditor if a renderer
  version is needed; no broad documents rewrite is required.
- **Proof test:** Request the same crop with two distinct operation IDs through
  review operations and assert one worker render and valid evidence for both
  tasks. Changes to source, rotation, region or effective DPI must render again.
  Existing idempotency tests cover operation identity, not equivalent crops
  across different tasks. Savings were not benchmarked.

## Provider and pacing owner

### H-07 — Stepped image eviction discards fresh images before their first model inspection

- **Category:** correctness. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/inference/provider.ts:292`, `:299`, `:599`;
  `backend/packet-review/service.ts:1304`, `:1336`, `:1358`;
  `tests/smoke/packet-provider.test.ts:312`.
- **Evidence:** With nine total images, `ceil((9 - 8) / 4) * 4` drops four.
  A locally captured real-SDK Baseten request with one old image plus eight new
  images contained only indices 4–8: three of the eight fresh images were
  replaced with the omission notice. The render tool explicitly allows eight
  per generation and marks all rendered sheets inspected before provider
  serialization. Consequently the host's inspection ledger can get ahead of
  images actually made available for inspection. The existing test uses twelve
  images, where the arithmetic happens to preserve the last eight.
- **Concrete fix:** Track the latest unconsumed image batch and protect it from
  eviction. Drop historical images in steps only while all fresh images fit;
  reduce the step at that boundary. If a fresh batch itself exceeds byte/count
  bounds, split or reject it before recording delivery. Preserve the useful
  stepped cache behavior for previously seen images. Do not equate rendering
  alone with successful model delivery when coverage depends on delivery.
- **Proof test:** Add real-SDK recorded requests for total counts 9, 10, 11, 13
  and 17 with varying old/new splits. Every fresh image must appear on its first
  request, no request exceeds eight images, and the durable transcript remains
  unchanged. Add one packet-tool test that verifies the delivered crop set before
  coverage can be recorded. Existing 12-image test misses the failure.

### H-08 — Exhausted definite refusals are persisted as ambiguous paid attempts

- **Category:** correctness. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/inference/provider.ts:760`, `:763`, `:793`, `:806`,
  `:813`; `backend/inference/response.ts:52`;
  `backend/packet-review/service.ts:2474`, `:2490`, `:2678`.
- **Evidence:** After 40 explicit 429/529 refusals or the refusal time budget,
  the loop hands an error response to `parseResponseReceipt`. Its successful
  stop-reason schema rejects it, and the catch calls `end(true, ...)`. A recorded
  all-429 probe reproduced this exactly. SQL retains an uncertain attempt and
  future admission blocks it; the user-facing path says it may have been charged.
  The adapter itself has already established these responses generated nothing.
  This is the terminal-state bug after the new retry budget, not the prior
  fixed six-retry pacing policy.
- **Concrete fix:** Persist a distinct definitive refusal outcome with safe
  status/detail before ending the run. Stop or pause on prolonged provider
  unavailability, and allow an explicit later resume without treating that
  attempt as an unresolved charge. Continue to block genuine network/stream
  ambiguity. Do not implement this by marking an error as a successful receipt
  or by automatically replaying a previously uncertain dispatch.
- **Proof test:** Use recorded refusals and a manual clock to exhaust both limits.
  Assert a definitive non-success receipt/disposition, no success usage, accurate
  messaging and safe explicit resume. Existing provider tests recover after one
  or nine refusals; they do not exhaust the new policy.

### H-09 — Provider Retry-After is truncated and HTTP-date values are ignored

- **Category:** correctness. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** S.
- **References:** `backend/inference/pacing.ts:192`, `:197`;
  `backend/inference/provider.ts:120`, `:171`.
- **Evidence:** Both shared refusal cooldown and routing-refusal delay apply
  `min(60000, requested)`. A local pacer call requesting 120,000 ms returned
  60,000 ms. `retryAfterMs` only accepts a positive numeric string, so an
  HTTP-date is treated as absent. This conflicts with the documented promise
  to honor provider waits and can send every waiting sheet into a known refusal.
- **Concrete fix:** Cap only locally generated exponential backoff. Honor a
  validated provider delay in full; if it exceeds the allowed refusal budget,
  terminate as a definitive refusal without an early resend. Parse both
  delta-seconds and HTTP-date, converting once into a monotonic deadline with
  injected wall/monotonic time for tests.
- **Proof test:** Extend `request-pacing.test.ts` and recorded provider tests with
  `Retry-After: 120`, an HTTP-date, zero, and malformed headers. No dispatch
  before the valid requested deadline; cancellation still removes waiters.
  Existing tests cover short numeric waits only.

### H-10 — Files uploads are detached from review cancellation and lifetime

- **Category:** standards. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/inference/provider.ts:458`, `:471`, `:485`, `:489`,
  `:519`, `:880`, `:901`.
- **Evidence:** `onPayload` awaits image uploads, but those use only a new
  60-second timeout. The review abort signal is forwarded to the model SDK, not
  the upload. The recorded held-upload probe showed the upload still active after
  cancelling generation; generation could finish only after the probe released
  it. Recursive `Promise.all` can start many such uploads. This violates explicit
  runtime cleanup: cancelled work can continue transferring source images and
  hold shutdown/drain for the upload timeout.
- **Concrete fix:** Give the review's image-upload pool an explicit lifetime and
  abort it on review cancel/close. Because peers share the same image promise,
  do not tie the shared upload solely to one child's cancellation; use pool
  ownership or waiter accounting. Make each cancelled waiter stop awaiting the
  upload promptly, and bound upload concurrency. Retain byte-identity reuse and
  avoid turning cancellation into a five-minute cached upload failure for peers.
- **Proof test:** Hold a recorded Files upload, cancel its only review, and assert
  its signal aborts and drain completes without release. With two live child
  waiters, cancelling one must not cancel the other's upload. Existing file-ID
  tests cover reuse and fallback, not cancellation/lifetime.

## Refactoring guidance without a separate style finding

The service's length alone is not a finding. While fixing the issues above,
three useful boundaries reduce actual duplicated policy:

- A stage/role capability module shared by wire tool selection and execution
  authorization (H-01/H-02/H-11).
- A packet SAM dispatcher owning intent, receipt, failure disposition and
  conversation isolation, called by both explicit segmentation and finding
  focus (H-03/H-12). Keep geometry preparation/decoding in the existing `sam.ts`.
- A coverage reducer shared by single and batch tools: the two handlers at
  `service.ts:1490` and `:1537` duplicate inventory, inspection, reason and upsert
  rules. Extract only those rules when touching them; preserve atomic batch
  rejection and durable tool receipts.

Keep SQL mutation/replay ownership in one service/store boundary. Splitting every
tool into a tiny wrapper would spread dependencies without simplifying policy.
No standalone slop or dead-code findings are counted for these suggestions.

## Needs decision

### H-12 — Every qualifying finding synchronously buys a SAM presentation zoom

- **Category:** inference. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **References:** `backend/packet-review/service.ts:1125`, `:1135`, `:1162`,
  `:1206`, `:1775`, `:987`; `docs/inference.md:107`.
- **Evidence:** After saving a finding, `record_finding` always awaits
  `focusFinding`. With a Meta key and a location under half a sheet, this renders
  another crop and makes a paid SAM call even for a prose note, code citation or
  table discrepancy. No object-identification need is required. Calls consume
  the shared review budget and block that conversation's next tool/model work.
  Existing focus tests explicitly expect this behavior. The finding is already
  saved and the model-facing result includes only an artifact ID and segment
  count; this work principally serves presentation, not additional reasoning.
  H-03 separately covers its current global-failure consequence.
- **Decision:** Keep automatic SAM zooms for every qualifying finding, or make
  them selective/on demand? This changes visible evidence presentation and the
  established SAM product behavior, so it is not an automatic audit fix.
- **Concrete fix if approved:** Retain the mandatory model-requested SAM path
  for device counts. For other findings, persist a deterministic PDF highlight
  immediately, and request SAM only for an explicit object-location need or
  reviewer action. If retaining automatic enrichment, move it to an owned,
  bounded post-save queue with visible status, explicit budget accounting and
  cancellation; package export must drain or record pending enrichment.
- **Proof test:** Update `packet-sam-focus.test.ts`: a textual finding should
  require no presentation SAM call under the approved policy, while a device
  count still requires its evidence SAM. Verify deterministic highlights, optional
  enrichment failure, budget handling and cloud export. Existing tests cover
  today's unconditional focus generation; they must change only after approval.
  No claim is made about accuracy or measured cost savings from removing it.
