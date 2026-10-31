# Audit 4: renderer and tests

Read-only audit of `fix/audit-4`, HEAD `68deb4910`, on 2026-10-31. Source, tests and configuration were not changed. This ledger is the only written file.

## Verification and limits

- Read `AGENTS.md`, `PRODUCT.md`, `design/DESIGN.md`, `repos/effect/LLMS.md`, the installed coding and Svelte skills, and the prior Audit 3 and hackathon audit findings. The ignored Forge reference pack is not present in this checkout; `design/DESIGN.md` is the checked-in adaptation specification.
- Bun matches `.bun-version`: **1.4.4**. Ran `bun test ./tests/smoke` once. It ended in **119 ms: 1 pass, 49 fail, 48 errors**, overwhelmingly import failures because `node_modules` is absent. `forge-tokens.test.ts` passed in 13.90 ms; `icons.test.ts` failed in 2.32 ms because its Tabler dependency was absent. These are environment results, not application regressions or useful suite timings.
- Ran `bun run build:ui`: failed immediately with `Script not found "vite"`. **No bundle-size measurements are available.** Did not install packages, call live providers, run cloud scripts, or run Electron e2e. No claims below rely on the known WSL clock-jump failures.
- The Svelte MCP autofixer checked the complete `ReviewWorkbench`, `PacketReviewPanel`, `SourceViewer`, `FindingDecision`, `SheetThumbnail` and `ReviewSelect` components against 5.57.2. All returned zero compiler issues. Workbench and picker returned generic suggestions; these are not treated as findings. An initial truncated workbench submission produced a parse error; resubmitting the complete file removed it.
- Executed two dependency-free harnesses with Bun's TypeScript transpiler, extracting the actual workbench function bodies. They reproduced R-01 and R-02. These establish handler behavior, not a complete Electron reproduction.
- `CONFIRMED` means the cited defect or test limitation is established by source tracing or those harnesses. It does not mean the full test suite passed. Runtime severity and performance measurements still need verification after dependencies are available.

**13 findings:** correctness 4, perf 2, dead-code 1, slop 2, useless-test 1, test-gap 1, slow-test 2. Severity: high 3, medium 9, low 1. All 13 are CONFIRMED, with the measurement limits above.

## Workbench implementation, behavior-preserving work

### R-04: Every packet update launches another complete project snapshot

- **Category:** perf. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `src/lib/review/components/ReviewWorkbench.svelte:469`, `:481`, `:791`, `:809`; `backend/packet-review/service.ts:3921`; `backend/review/store.ts:229`, `:257`.
- **Evidence:** Every `onReview` calls `void refresh(projectId)`, including each existing review replayed when a subscription starts. There is no coalescing or in-flight cancellation. `refreshRequest` discards superseded responses only after their RPC work completes. `afterSequence` limits events, but the snapshot still reads and decodes every revision, sheet, artifact, finding, fact, check, conversation and message. Applying it replaces all these renderer collections and rebuilds the accumulated event array. Starting a subscription with N saved reviews therefore schedules N full snapshot calls. A progress burst also schedules one call per update. This is verified work amplification; no frame-time or latency improvement is claimed without a runnable build.
- **Concrete fix:** Coalesce snapshot invalidation per selected-project generation. Allow one request in flight and one pending refresh. Packet-only progress should update the packet state without fetching unrelated records; refresh messages and evidence on their relevant transitions. Keep R-01's project-generation protection in the same implementation.
- **Proof test:** Replay many saved reviews and emit a controlled progress burst while holding the first snapshot response. Assert bounded snapshot requests, eventual newest messages/evidence, and no application of the previous project's data. Measure snapshot traffic and interaction latency on a large saved project.

### R-07: Source-view ownership is duplicated inside the 4,406-line workbench

- **Category:** slop. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `src/lib/review/components/ReviewWorkbench.svelte:493`, `:717`, `:1244`, `:1383`, `:1481`, `:1863`, `:2720`.
- **Evidence:** `openPacketEvidence` and `loadSheetSource` separately implement loading state, blob ownership, request-generation checks, stale-response disposal, error presentation, zoom initialization and overlay setup. Finding selection, import completion, close and component teardown each repeat pieces of invalidation and disposal. The component contains 1,870 lines of script plus source-panel markup and the rest of the application. The issue is repeated ownership logic, not an assumption that Svelte rerenders the entire component on every change. Current blob cleanup is present and is not reported as a leak.
- **Concrete fix:** Extract a source-view controller with `openArtifact`, `renderRegion`, `close` and `dispose`, sharing a single generation and owned URL. Extract the source-panel markup into a component taking its selected finding/sheet and controller actions. Keep snapshot/subscription orchestration together for R-01/R-04. Do not split by arbitrary line counts or introduce a general store framework.
- **Proof test:** Retain existing source-selection e2e tests and add delayed artifact/render completion after close, finding switch and project switch. Verify no stale image appears and each created URL is released once. This refactor must preserve selection geometry, zoom and evidence identity.

## Packet coverage panel

### R-05: Coverage grouping repeatedly scans the full ledger for every sheet

- **Category:** perf. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `src/lib/review/components/PacketReviewPanel.svelte:159`, `:170`, `:188`, `:197`, `:204`, `:212`, `:446`, `:566`; `src/lib/review/packet-coverage.ts:110`.
- **Evidence:** `coverageSheets` filters `matchingCoverage` for each sheet and filters `detailCoverage` again for its counts. Whole-set rows scale with sheets × disciplines × four passes, so these scans grow quadratically with sheet count. The search query also invalidates this grouping. The outer native `<details>` does not conditionally mount its contents, so its closed state does not defer these calculations; `matchingCount` and the sheet list still consume them. Pagination limits records within an expanded sheet, not grouping work. This is an algorithmic finding, not a measured frame-rate claim.
- **Concrete fix:** Build a per-sheet coverage index and counts in one pass when coverage changes. Apply discipline/status/search filters to that indexed representation. If deferring closed details, preserve filter state and accessible summaries. A focused `PacketCoveragePanel.svelte` is a useful split because it owns these filters, pagination and grouping independently of run controls.
- **Proof test:** Compare filtered counts and rows with existing coverage expectations across scopes and earlier coverage. Use a large synthetic packet to verify one grouping pass per coverage change, and benchmark typing in sheet search with the panel open and closed.

## Retired conversation submission code

### R-06: The old count-review send module has no production callers

- **Category:** dead-code. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** S.
- **Files:** `src/lib/review/conversation.ts:27`, `:61`; `tests/smoke/review-conversation.test.ts:33`, `:107`, `:485`, `:562`; `src/lib/review/components/ReviewWorkbench.svelte:959`, `:1041`.
- **Evidence:** Repository-wide `rg` for `sendReviewMessage`, `sendCloudReviewMessage` and `conversation.ts`, excluding the reference repository, found the definitions and only smoke-test consumers of `sendReviewMessage`. `sendCloudReviewMessage` has no caller at all. The real composer uses `postMessage`/`startDrawingReview` and packet APIs. Consequently the smoke test named “a real conversation send routes Moke disciplines…” exercises the retired helper, not the current composer. Its backend persistence/routing assertions still have value; the whole test is not useless.
- **Concrete fix:** Delete the unused production module. Preserve applicable legacy execution tests by calling the supported application operations directly or moving genuinely necessary fixture composition into tests. Add current packet-composer coverage rather than retaining a production API solely for tests.
- **Proof test:** `rg` shows no remaining imports of the deleted module; typecheck and retained legacy execution tests pass. Exercise current local/cloud packet submission, message identity and start-failure behavior through the actual composer.

## Test organization

### T-01: Audit-round filenames mix unrelated behaviors and obscure ownership

- **Category:** slop. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `tests/smoke/audit-2.test.ts:20`, `:65`, `:125`, `:415`, `:572`, `:662`; `tests/smoke/audit-3-runtime.test.ts:21`, `:121`, `:229`, `:343`, `:413`, `:478`; `tests/smoke/audit-3-documents.test.ts:30`, `:83`, `:356`; `tests/smoke/audit-3-workbench.test.ts:9`, `:23`; `tests/e2e/audit-2.spec.ts:13`, `:133`, `:311`; `tests/e2e/audit-3-workbench.spec.ts:7`; `tests/e2e/audit-3-sheets.spec.ts:12`, `:196`, `:246`, `:308`, `:429`.
- **Evidence:** These are active, often substantial regression tests. `audit-2.test.ts` alone combines display guards, drop claims, packet lifecycle, scope assignments, subscription recovery and steering. `audit-3-runtime.test.ts` combines provider diagnostics, runtime controls, absence checks, image budgets, coverage gates and crop metadata. Their filenames provide no behavioral ownership and encourage adding unrelated regressions to the same file. Do not delete these suites as “useless.”
- **Concrete fix:** Move smoke cases into `desktop-test-environment.test.ts`, `review-drop.test.ts`, `packet-lifecycle.test.ts`, `packet-steering.test.ts`, `packet-routing.test.ts`, `packet-subscription.test.ts`, `packet-provider.test.ts`, `packet-evidence-policy.test.ts`, `packet-coverage.test.ts`, `documents.test.ts`, `review-packages.test.ts` and `source-url.test.ts` as appropriate. Give e2e cases behavior owners such as `source-viewer.spec.ts`, `sheet-setup.spec.ts`, `revision-mapping.spec.ts`, `conversation-navigation.spec.ts` and `conversation-scroll.spec.ts`; merge overlapping setup with existing `polish.spec.ts`/`packet.spec.ts` only where it reduces duplication. Coordinate these moves with T-04/T-05 before editing shared files.
- **Proof test:** Preserve the collected test cases and assertions through the move; run all smoke tests and affected Electron flows. No audit-round test filenames remain.

## PDF cancellation test

### T-02: “Cancels in-flight PDF work” never proves worker work was cancelled

- **Category:** useless-test. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `tests/smoke/documents.test.ts:303`; `backend/documents/pdf-worker-main.ts:261`.
- **Evidence:** The test sets a 500 ms worker delay, forks import, sleeps 50 ms, interrupts the fiber and asserts only `Exit.isFailure(exit)`. It does not establish that the worker entered the job, inspect the interruption cause, observe process termination or check for late output. An immediate import failure satisfies the assertion. Removing underlying worker cancellation while keeping the parent fiber interruptible also satisfies it. Thus it cannot catch the worker-cancellation regression claimed by its name; the asserted parent-fiber failure has little independent value here.
- **Concrete fix:** Rewrite in `documents.test.ts`. Await an observable worker/job-start handshake, interrupt the import, verify an interruption exit and verify the owned worker terminates or releases the job without late artifacts. Assert a subsequent document operation succeeds so cancellation cannot silently wedge capacity. Replace the arbitrary 50 ms sleep with the handshake; TestClock alone cannot prove a native child started.
- **Proof test:** Deliberately disable worker abort/cleanup and confirm the rewritten test fails even though the parent fiber still reports interruption. Also make import fail before dispatch and confirm it cannot pass as a successful cancellation test.

## Initial Review coverage

### T-03: No test actually clicks Initial Review or proves its fixed submission contract

- **Category:** test-gap. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `tests/e2e/initial-review.spec.ts:8`, `:71`; `tests/smoke/initial-review.test.ts:8`, `:16`, `:27`; `src/lib/review/components/ReviewWorkbench.svelte:1114`.
- **Evidence:** The e2e case checks visibility, enabled state, accessible description, split imports and removal after correspondence, but never calls `initial.click()`. The smoke cases validate static text, schema acceptance and phase calculation. `rg` across all tests found no other preset/Initial Review execution coverage. The button could have a no-op handler, use the wrong model, omit a first-set PDF, copy the optional composer budget or lose preset identity without these tests failing.
- **Concrete fix:** Extend the behavior-owned initial-review suite with an offline local provider/transport fixture and click the actual button. Verify one saved preset message and one admitted packet review containing every sheet from two initial PDFs, Muse Spark 1.3, null call budget and `initial-review-v1`. Separately exercise cloud selection and local fallback at an injected transport boundary, including duplicate-click protection and admission failure. Keep existing visibility tests; they are useful for a different contract.
- **Proof test:** Each of the wrong-model, omitted-PDF, inherited-budget and no-op-handler mutations must fail a relevant assertion. Reopen and verify persisted preset/message/review identity. No paid provider is needed.

## Subscription recovery timing

### T-04: The reconnect regression necessarily waits seven real seconds

- **Category:** slow-test. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `tests/smoke/audit-2.test.ts:572`, `:601`, `:638`, `:660`; `src/lib/review/packet-subscription.ts:5`, `:55`.
- **Evidence:** The test deliberately ends the first three subscriptions and waits for the fourth. Production `followPacketReviews` uses native `setTimeout` backoffs of 1, 2 and 4 seconds before that fourth connection. Therefore the test has a seven-second timer floor, plus fixture/SQL/provider work, and allows 80 seconds. This is derived from the exercised control flow, **not a measured timing from this checkout**; the dependency failure prevented execution. The regression itself is valuable.
- **Concrete fix:** Move the case to `packet-subscription.test.ts` under T-01. Make reconnect delay/clock an owned dependency, preferably Effect sleep/clock under the existing runtime, and drive it with TestClock. A small injected clock is also valid if the helper remains Promise-based. Keep one real persistence integration case without paying every backoff interval.
- **Proof test:** Advance 999 ms, 1 ms, 2 s and 4 s explicitly; assert no early reconnect, each expected reconnect, durable missed-state replay, warning recovery and no reconnect after abort. The test should finish without seven seconds of wall-clock waiting.

## Provider and active-duration timing

### T-05: Fixed sleeps substitute for readiness and elapsed-time control

- **Category:** slow-test. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `tests/smoke/packet-provider.test.ts:459`, `:467`, `:494`, `:499`; `tests/smoke/audit-3-runtime.test.ts:44`, `:100`.
- **Evidence:** Provider cases use an injected pacer clock but still sleep 10/20 ms before asserting admission counts or advancing that clock. If the asynchronous SDK work has not reached acquisition/refusal by then, the assertion or subsequent timeline is wrong. The active-duration cases sleep 25 ms to create paused/cancelled time despite the application using Effect DateTime. These sleeps are confirmed; slowest-test rankings are unavailable. This finding does not classify the explicitly excluded review-conversation/cloud-activity clock failures as regressions.
- **Concrete fix:** Expose a test seam or Deferred signaling acquisition, refusal and next admission in the provider fixtures, then advance the pacer clock only after those signals. Drive active-duration tests through Effect TestClock, using a deliberately large paused interval to prove exclusion. Coordinate the latter moves into `packet-lifecycle.test.ts` under T-01.
- **Proof test:** Add artificial scheduling delay before acquisition/refusal and verify tests remain deterministic. Advance minutes of paused time instantly and verify active duration is unchanged. No fixed real sleep should be necessary for either assertion.

## Checked areas without separate findings

- No renderer imports of backend services, Bun APIs or `repos/` were found. `src/lib/backend-rpc.ts` contains private startup schemas, but a schema declaration under `src` is not itself a credential leak; no renderer entrypoint import of it was found. Renderer RPC uses shared Effect Schema contracts. Relative sibling imports exist, but import spelling alone is omitted as a style nit.
- No unused Svelte component was confirmed. No `nightdesk` or `--nd-` references remain in `src`. Six Forge declarations have no consumers: `--color-surface-sunken`, `--color-focus`, `--color-ember-wash`, `--leading-tight`, `--space-xl`, `--space-2xl` at `src/lib/forge.css:17`, `:24`, `:30`, `:47`, `:61`, `:62`. They are optional token cleanup, not a separate impact finding or evidence that Nightdesk remains.
- Source/thumbnail URLs, IntersectionObserver, ResizeObserver and component timers have cleanup paths. Important collection loops use keys. Index keys on immutable text fragments/overlays alone do not establish a defect. Packet panel timers continue in terminal views, but are a minor issue compared with R-04/R-05.
- Poppler-dependent tests in `adaptive-review.test.ts` and `segmentation.test.ts` use explicit `skipIf(Bun.which("pdftoppm") === null)` guards. They exercise external CLI rendering, so the guards have a real reason. CI does not explicitly install Poppler; ensure a designated lane runs them if that CLI remains supported. This checkout's import failures prevented a reliable skip count, and hosted runner availability was not checked.
- The stale-promotion half of `review-execution.test.ts:466` uses a fixture-owned fence implementation, but `review-fences.test.ts:24` separately exercises real `createReviewOperations`/`ReviewStore` promotion. The former still verifies runtime handling of a rejecting port; it is not labeled useless or counted as a missing production fence test.
- `playwright.config.ts` uses one worker; desktop script selection keeps the screenshots project separate. No unsupported claim of duplicate CI execution is made. Fixtures generally use real SQLite/PDF/service operations with injected external transports, which is a useful test boundary.

## Needs decision

These findings change visible behavior when fixed. Recommended outcomes are given explicitly. R-01 and R-03 correct violations of existing project/source ownership; they do not require a new product feature. R-02 needs a draft-preservation policy. Group these with the workbench work above when assigning implementers.

### Workbench selection, composer and preview behavior

### R-01: Previous-project progress can replace the newly selected project's snapshot

- **Category:** correctness. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `src/lib/review/components/ReviewWorkbench.svelte:450`, `:469`, `:481`, `:791`, `:825`, `:918`, `:934`.
- **Evidence:** `selectProject(B)` changes `selectedProjectId` and starts `refresh(B)` without aborting A's subscription. That subscription is replaced only after a snapshot is applied. A subsequent A callback calls `receivePacketReview`, which correctly rejects A, **then unconditionally calls `refresh(A)`**. Its newer request number supersedes B's fetch. `refresh` checks only the request number and never verifies the requested/result project against the selected project. It can apply A's snapshot, choose A's conversation, and discard B's response. The dependency-free harness extracted the actual `refresh` body and resolved this ordering; output was `{"selectedProjectId":"B","snapshotProject":"A","selectedConversationId":"conversation-A","appliedB":false}`. The composer and sheet actions take `project` from the snapshot, so this is an ownership problem, not just a breadcrumb glitch.
- **Concrete fix:** Abort/invalidate A's subscription at selection time; ignore callbacks unless their subscription/project generation is still selected; reject snapshot application for a stale selection generation even if it is the newest RPC request. Handle initial null-project loading explicitly. Fence `selectProject`'s post-await conversation selection as well, so rapid B→C navigation cannot apply B's requested conversation to C.
- **Proof test:** Hold B's snapshot at the real RPC boundary, deliver A progress, then release responses in both orders. Assert project, conversation, sheets, composer target and subscription all remain B. Repeat B→C with explicit conversation choices and delayed snapshots. Existing packet source/menu delay tests do not cover this ordering.
- **Recommended visible result:** Navigation stays on the project the user most recently selected.

### R-02: Saving a message erases text typed while its acknowledgement is pending

- **Category:** correctness. **Severity:** medium. **Verdict:** CONFIRMED. **Size:** S.
- **Files:** `src/lib/review/components/ReviewWorkbench.svelte:959`, `:990`, `:1028`, `:1032`, `:1060`, `:2532`, `:2554`.
- **Evidence:** The composer textarea remains enabled while `busy` is true; its disabled condition checks project, conversation and cloud state only. Successful note save, steering delivery and the review `onSaved` callback clear `draft` unconditionally after awaiting RPC. A user can send text, type their next text while the save is pending, and lose the new draft when the first response arrives. Extracting the actual `postMessage` body and holding `runCommand` reproduced this for note mode: changing draft to `Second note still being written` before resolving the save returned `{"draft":"","notice":"Note saved."}`. Navigation being disabled while busy does not prevent editing the textarea.
- **Concrete fix:** Clear the submitted draft synchronously and restore it on failure only if no newer draft exists, or record a draft revision and clear only when it still matches the submitted revision. Preserve all text added after submission. Apply the policy consistently to note, initial packet send and steering paths.
- **Proof test:** Hold each send acknowledgement, type another draft, release success and failure, and verify the new text survives while the first message is saved exactly once. Include edits that restore the same string so a revision-based solution is tested correctly.
- **Decision:** Prefer allowing continued composition and preserving the new draft. Disabling the textarea during save is simpler but changes the current interaction and needs explicit product agreement.

### R-03: Reopening previews creates durable artifacts until the project hits its record ceiling

- **Category:** correctness. **Severity:** high. **Verdict:** CONFIRMED. **Size:** M.
- **Files:** `src/lib/review/components/ReviewWorkbench.svelte:1265`, `:1271`, `:1383`, `:1411`; `src/lib/review/components/SheetThumbnail.svelte:14`, `:21`; `backend/review/operations.ts:54`, `:65`, `:99`, `:107`; `backend/review/store.ts:146`, `:150`, `:261`, `:1164`, `:1197`.
- **Evidence:** Every thumbnail/source load generates a fresh random `operationId`. `Review.render` reuses an artifact only by that operation ID; otherwise it renders again and creates a fresh artifact ID. `saveRender` persists that new record. Sheet thumbnails reload when the Sheets or Revision pane remounts, so revisiting the same images grows durable artifact records even when their PNG hash is unchanged. `records` rejects more than 2,000 records per project/kind, and every normal snapshot reads artifacts through it. At 2,001 artifacts, subsequent snapshots fail with “This project exceeds the workbench record limit…”. Ordinary viewing can therefore make the project unreadable in the workbench. Content-addressed PNG storage does not deduplicate these metadata records. This consequence is verified by the source path; a 2,001-render runtime stress test was not run.
- **Concrete fix:** Reuse immutable preview identity keyed by project, revision/source hash, page, region, rotation and effective DPI, rather than issuing a new durable evidence operation per view. Reuse existing matching artifacts across pane remounts and app restarts. Keep separately identified model evidence/history intact. Coordinate any backend preview-cache change with the platform auditor; a renderer-only in-memory cache would not protect across restarts.
- **Proof test:** Repeatedly open/close sheets and revision comparisons and navigate the same source at the same DPI; assert stable artifact-record count and no extra render after cache warmup. Reopen the app and repeat. Change source revision/region/DPI and verify correct fresh pixels. Seed near the limit and demonstrate ordinary repeated viewing does not cross it.
- **Recommended visible result:** Browsing the same source remains repeatable and does not consume the project's durable record allowance. Do not silently delete existing evidence to solve this.

### Shared select control

### R-08: An already-open select menu ignores later changes to disabled

- **Category:** correctness. **Severity:** low. **Verdict:** CONFIRMED. **Size:** S.
- **Files:** `src/lib/review/components/ReviewSelect.svelte:43`, `:84`, `:124`, `:130`; `src/lib/review/components/ReviewWorkbench.svelte:2575`; `src/lib/review/components/FindingDecision.svelte:40`.
- **Evidence:** `disabled` is applied to the trigger only. The open popover persists when that prop changes; each option uses only `option.disabled`, and its click handler invokes `onChange` without checking the component's disabled state. Asynchronous review/lock updates can therefore disable the displayed selector while its already-open menu still accepts a choice. This is a UI consistency issue, not a demonstrated backend authorization bypass.
- **Concrete fix:** Close the popover when the control becomes disabled, disable its options with `disabled || option.disabled`, and guard activation. Avoid stealing focus during an asynchronous disable.
- **Proof test:** Open the menu, flip disabled through a real component parent update, and attempt mouse/keyboard activation. Assert no change event and no active menu, then re-enable and verify normal selection.
- **Recommended visible result:** Disabled selectors stop accepting choices immediately, including through an already-open menu.
