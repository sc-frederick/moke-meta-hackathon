# Audit 4 — platform ledger

Audited 2026-10-31 at `68deb49100638edc41f8da925ac11d763b7f9627`, branch
`fix/audit-4`. This is a read-only platform audit; this ledger is the only
repository write. No provider requests, deployment, publication, or commits.

Read `AGENTS.md`, the installed coding-standards skill, `repos/effect/LLMS.md`,
`docs/data.md`, `docs/deployment.md`, `docs/development.md`,
`docs/cloud-reviews.md`, and the relevant Audit 3/product-audit records.
Historical provider/product gaps are not repeated below. Fixes must not edit
applied migrations. SQL index changes require a new migration.

Evidence uses source inspection, whole-repository ripgrep excluding `repos/`,
build configuration and installed package inspection, and disposable local Bun
probes. Probes used Bun 1.4.4 and packages already available in Bun's cache.
Temporary probe data was removed. No source/test/config files were added.

The attempted existing-suite command was:

```sh
bun test ./tests/smoke/backend.test.ts ./tests/smoke/database-files.test.ts ./tests/smoke/documents.test.ts ./tests/smoke/credential-files.test.ts ./tests/smoke/cloud-reviews.test.ts ./tests/smoke/cloud-cache.test.ts ./tests/smoke/cloud-transfer-progress.test.ts
```

It stopped during module loading: this checkout has no installed `node_modules`,
and all seven files reported `Cannot find package 'effect'`. Result: 0 pass,
7 load failures; no test assertions ran. Dependencies were not installed during
this audit. This is a validation limitation, not a source regression. No full
verify, packaged run, or macOS timing measurement is claimed. Existing coverage
mentioned below was inspected, not represented as passing here.

## Backend documents and artifacts

### P-01 — Render accepts changed PDF bytes under the original source identity

- Category: correctness. Severity: high. Verdict: CONFIRMED. Size: M.
- Files: `backend/documents/documents.ts:127`,
  `backend/documents/pdf-worker-main.ts:65`, `backend/review/operations.ts:82`.
- Evidence: `Documents.render` validates the hash's syntax and reads the file's
  size, but never verifies its contents against `originalSha256`. The worker
  verifies geometry and rotation, not content identity. The caller records the
  resulting image against the original revision. Offline reproduction used
  `createHeroPdf("A")`, imported it, rendered its first page, replaced its stored
  hash-named PDF with `createHeroPdf("B")`, then rendered again with the original
  sheet and hash. Output was
  `{"tamperedRenderSucceeded":true,"renderPixelsChanged":true,"inspectRejected":true}`.
  Thus the separate `inspectStored` integrity check rejects exactly the file
  that rendering accepts. No concurrent mutation or malicious PDF was needed.
- Fix: include the expected source hash in the private worker render contract
  and verify the exact buffer supplied to PDF.js before rendering. Return a
  typed integrity failure and do not publish/store a render on mismatch. A
  parent-only precheck would still leave a check/read race.
- Proof test: add the A-to-B replacement reproduction to `documents.test.ts`
  and exercise `RenderSource` to show no artifact is committed. Existing
  `audit-3-documents.test.ts:30` covers corruption for label reinspection only;
  geometry/malformed-input tests do not cover a different valid PDF.

### P-02 — Every artifact chunk rereads and hashes the entire file synchronously

- Category: perf. Severity: medium. Verdict: CONFIRMED. Size: M.
- Files: `backend/documents/artifact-store.ts:119`,
  `backend/review/operations.ts:305`, `src/lib/review/client.ts:396`.
- Evidence: `readArtifactChunk` performs `readFileSync(path)` and SHA-256 over
  the full buffer before slicing the requested range. Both the model-image
  reader and renderer loop in 256 KiB chunks. A permitted 16 MiB model image
  therefore causes 64 full reads/hashes: 1 GiB of synchronous processing for
  one image, before image conversion. The endpoint is bounded in response size,
  but its work and allocation per response are not bounded by the chunk size.
  This runs in the Bun API process and blocks other callbacks during each read.
- Fix: give the backend image reader a verified whole-file operation; provide
  renderer chunks from a bounded verified read session/cache with explicit
  invalidation on replacement and file-identity changes. Preserve corruption
  detection; do not simply stop checking hashes or trust the filename.
- Proof test: read a multi-chunk artifact and demonstrate linear total file
  processing, while altered/truncated files still fail. Keep bounded response
  and cancellation checks. `documents.test.ts:282` checks a single 128-byte
  response, not repeated full-file work.

## Backend composition and HTTP transport

### P-03 — Application-layer and background logs bypass the file logger

- Category: correctness. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `backend/main.ts:60`, `backend/cloud/service.ts:310`,
  `backend/cloud/sync.ts:84`, `desktop/backend.ts:47`.
- Evidence: `Logger.layer([logger])` is a sibling in `Layer.mergeAll`, not a
  provider for `Application.layer`. A local Effect 4 probe using this exact
  composition shape printed `acquisition-probe` through the default stdout
  logger; the supplied logger captured only a subsequent runtime call.
  Cloud seeding/reconciliation fibers are forked during layer construction and
  inherit that acquisition context. Their warnings can therefore miss
  `userData/logs`. Stdout is also the readiness channel: Electron treats its
  first line as `BackendReady` and closes the reader afterward. A startup
  warning can interfere with readiness; the complete startup race was not
  separately reproduced, so that consequence remains PLAUSIBLE.
- Fix: provide the logger to application-layer construction, including scoped
  fibers, and expose it to runtime operations. Keep stdout exclusively for the
  readiness envelope. The cloud worker already demonstrates provider-style
  logger wiring in `backend/cloud/worker-main.ts:96`.
- Proof test: use an offline application/cache seam that logs on acquisition
  and in a background fiber; assert both enter the log sink and stdout contains
  only valid readiness. `backend.test.ts` does not exercise startup/background
  logging.

### P-04 — Valid shared-schema requests exceed the backend HTTP body limit

- Category: correctness. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `backend/main.ts:104`, `src/lib/review/contracts.ts:39`,
  `src/lib/review/contracts.ts:313`, `src/lib/review/packet.ts:458`.
- Evidence: the server caps requests at 65,536 bytes, while messages and steering
  allow 32,000 characters. A real `BackendApi` probe created a project and
  conversation, decoded a valid `PostMessage` containing `"界".repeat(24000)`,
  then sent it through RPC. Its command JSON was 72,210 bytes and the typed call
  failed with `RpcClientDefect: Received empty HTTP response from RPC server`.
  JSON escaping can also expand otherwise valid text; this is not limited to
  that language. Shared validation succeeds before the transport rejects it.
- Fix: reconcile request-byte limits with every public payload's encoded
  maximum, including framing, Unicode and escaping. Bound currently unbounded
  array inputs where appropriate; surface an application input error instead
  of a transport defect. Preserve authentication and the origin rejection.
- Proof test: send maximum supported ASCII, Unicode and escape-heavy messages
  through the actual backend HTTP RPC, then reject an explicitly over-limit
  request without losing subsequent API availability. Existing backend tests
  cover an empty invalid name, not large valid payloads.

## Cloud persistence and application queries

### P-05 — The cloud writer can persist state that prevents the next app launch

- Category: correctness. Severity: high. Verdict: CONFIRMED. Size: M.
- Files: `backend/cloud/files.ts:83`, `backend/cloud/files.ts:104`,
  `backend/cloud/service.ts:318`, `backend/cloud/service.ts:546`.
- Evidence: reads refuse state above 8 MiB; writes have no corresponding byte
  check. Admission permits up to 1,000 receipts. Each receipt stores both the
  complete request and its JSON fingerprint, including selected sheet IDs.
  An offline probe schema-validated 500 terminal receipts with 200 selected
  sheets each, wrote them through `writeCloudState`, then read that same file.
  The successful write produced 8,650,412 bytes; read failed with
  `Cloud ownership records exceed the supported limit.` Application layer
  construction awaits this read, so the whole backend fails to start, even
  though all these jobs are terminal. Removing preview data does not prevent it.
- Fix: enforce a write/read-compatible storage budget before replacing the
  last valid state and reserve room for active-job progress. Separate/archive
  terminal receipt bodies or version a compact fingerprint representation while
  retaining durable command deduplication. Provide safe recovery for existing
  oversized files; never discard active ownership or replay old command IDs.
- Proof test: add this 500-receipt round trip and an active-job progress update
  near the byte ceiling. A refusal must leave the previous state readable and
  must happen before external dispatch. Existing cloud tests cover corrupted
  ownership and previews, not aggregate valid-history growth.

### P-06 — Cloud setup scans every attempt per historical count run

- Category: perf. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `backend/application.ts:275`, `backend/application.ts:281`;
  add a NEW migration after `0011_firm_checklist.sql`.
- Evidence: `localWorkBlockingCloud` uses a correlated lookup on
  `review_execution_attempts(run_id,status)`, but the only key there begins with
  `journal_id`. It also reads JSON state from every packet payload. An in-memory
  SQLite probe applied all existing migration SQL unchanged and ran
  `EXPLAIN QUERY PLAN` on the two exact application queries. Results included
  `CORRELATED SCALAR SUBQUERY 1` / `SCAN a` and `SCAN packet_reviews`.
  Adding temporary in-memory indexes on `(run_id,status)` and
  `json_extract(payload,'$.state')` changed those to indexed searches. The count
  query otherwise has a history-sized nested scan; packet payloads can be large.
- Fix: add both indexes in a new immutable migration. Keep query behavior and
  uncertainty/acknowledgement conditions unchanged. Rebuild the cloud image
  through the separately authorized deployment workflow when shipping it.
- Proof test: migration upgrade preserves rows/history; query results stay the
  same for active, terminal and acknowledged/uncertain cases. Record plans and
  an offline large-history comparison. `cloud-local-work.test.ts` covers fencing
  semantics, not the query plan. Do not modify migration 0003 or 0009.

## Credentials and Modal admission

### P-07 — Accepted provider URLs are rejected only after cloud upload

- Category: correctness. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `desktop/credential-files.ts:20`, `desktop/credential-files.ts:28`,
  `backend/cloud/modal.ts:615`, `backend/cloud/service.ts:588`.
- Evidence: credential validation strips trailing slashes for comparison but
  returns the original URL. Modal dispatch compares that original string to
  the slash-free endpoint. A local parse probe accepted
  `https://api.meta.ai/v1/`, retained the slash, and failed the exact cloud
  canonical comparison. Preflight checks image/secrets, not this URL; `start`
  allocates, uploads and saves the dispatching fence before calling dispatch.
  A valid imported credential can thus leave a paid sandbox and fenced workspace
  for a configuration inconsistency knowable before any cloud action.
- Fix: normalize the accepted URL in the credential boundary and enforce the
  same canonical rule before allocation/upload for non-shell callers. Keep
  endpoint restrictions; do not broaden allowed hosts.
- Proof test: accepted slash variants normalize identically for Meta/Baseten;
  an invalid route fails an offline cloud start before allocate/upload. Existing
  `credential-files.test.ts` lacks this cross-boundary case.

## Packaging and development startup

### P-08 — Entire PDF.js legacy distribution ships for one worker module

- Category: perf. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `scripts/prepare-pdf-assets.ts:66`, `electron-builder.json:22`,
  `backend/documents/pdf-worker-main.ts:31`.
- Evidence: preparation recursively copies `legacy/`; builder includes all
  staged assets. The installed pinned distribution contains 16,493,936 bytes
  under `legacy`, of which 9,540,392 are source maps. The runtime's explicit
  external legacy asset is `build/pdf.worker.mjs` (2,418,244 bytes). The main
  PDF.js module is already bundled into the compiled worker. Whole-repository
  ripgrep and build config inspection found no application loader for the
  legacy web viewer, its images/CSS, declarations, minified duplicates, webpack
  wrapper or source maps. These increase staging, archive/compression work and
  installed size on all three CI platforms, including macOS. No elapsed-time
  saving or compressed-size saving is claimed.
- Fix: stage an explicit runtime asset allowlist: retain fonts, CMaps, WASM,
  the worker module and licenses; exclude unused viewer/development variants.
  Verify any image-decoder dependency before removing it. At least the measured
  9.54 MB of source maps can be excluded without a runtime feature change.
- Proof test: packaged PDF imports/renders with fonts, rotated pages and image
  codecs succeed without source `node_modules`; inspect archive contents/size.
  Existing packaged flows exercise rendering but do not assert an asset budget.

### P-09 — Modal and its transitive packages are also shipped inside Electron

- Category: perf. Severity: low. Verdict: CONFIRMED. Size: S.
- Files: `package.json:39`, `package.json:47`, `electron-builder.json:8`.
- Evidence: Modal is a production dependency. The only SDK import sites found
  by whole-repository ripgrep are Bun backend/tooling/tests; Electron imports
  only shared schemas for Modal configuration. `build:backend:main` compiles
  dependencies into the backend executable without externalizing Modal.
  Electron Builder 26.15.3's installed `platformPackager.js` separately adds
  production node-module file sets, even with the positive application `files`
  allowlist. Its runtime package copy is unnecessary for the compiled backend.
  Modal itself depends on cbor-x, long, nice-grpc, protobufjs, smol-toml and uuid.
  This is a redundant packaged copy, not an unused application SDK.
- Fix: move Modal to build/dev dependencies, preserving the pin/lock and all
  backend functionality. Keep Effect/electron-effect-rpc production packages
  because the desktop bundle externalizes them.
- Proof test: inspect a built asar for the absent Modal dependency tree and
  run packaged startup plus offline cloud tests. Existing packaged tests do not
  check dependency contents; a package build was not run in this audit.

### P-10 — Development startup compiles a backend it never launches

- Category: tooling. Severity: low. Verdict: CONFIRMED. Size: S.
- Files: `scripts/desktop-dev.mjs:12`, `desktop/main.ts:99`, `package.json:33`,
  `package.json:39`.
- Evidence: every `bun run dev` runs the complete `build:backend`, including
  compilation of `dist/backend/app-backend`. The unpackaged launch path then
  starts `bun --no-orphans backend/main.ts`, not that executable. It does use
  the compiled PDF worker and staged assets. Ripgrep/build-config checks
  confirmed the app-backend executable is needed for packaged/compiled proof,
  not this development path.
- Fix: have the development preparation build the PDF worker/assets and desktop
  entrypoints only; retain full backend compilation in production build/verify.
- Proof test: a clean-output development launch reaches readiness and imports
  a PDF without `dist/backend/app-backend`; normal packaged build still includes
  and launches it. No measured startup-time reduction is claimed.

## Agent tooling and documentation

### P-11 — Local lint-rule regression entrypoint still invokes pnpm

- Category: tooling. Severity: low. Verdict: CONFIRMED. Size: S.
- Files: `tools/oxlint/anti-slop/rules/require-readable-spacing-cli.test.ts:15`,
  `package.json:25`, `package.json:28`, `bunfig.toml:9`.
- Evidence: the CLI regression calls `spawnSync("pnpm", ["exec", "oxlint", ...])`.
  There is no pnpm installation/declaration in either CI workflow. Application
  tests are deliberately rooted at `tests/smoke`, lint ignores `tools/oxlint`,
  and whole-repository script/workflow search found no explicit rule-test
  command. An agent changing a local rule has no documented Bun-only way to
  run this CLI regression; normal verify does not execute it. This does not
  imply that every vendored test belongs in the ordinary application suite.
- Fix: change the local regression's executable to the pinned Bun/Oxlint route;
  add a focused opt-in rule-test command and document it for local customization
  work. Preserve vendored licenses/provenance and avoid unrelated rule changes.
- Proof test: run the CLI regression with no pnpm on PATH; bad input is rejected,
  `--fix` produces the expected files, and a second pass is stable. Existing
  assertions already cover those behaviors but the launcher is stale.

### P-12 — Current cloud compatibility instructions contradict the implementation

- Category: docs. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `docs/data.md:175`, `docs/cloud-reviews.md:395`;
  references: `backend/cloud/contracts.ts:21`, `backend/cloud/progress.ts:22`,
  `backend/cloud/service.ts:559`.
- Evidence: data.md calls protocol 4 / packet prompt v4 current; the cloud guide
  correctly introduces protocol 5, then says new ownership receipts save
  `workerProtocol: 3`. Code admits protocol 5, stamps that protocol into new
  receipts, and has explicit separate recovery schemas for protocols 2–4.
  These conflicting current instructions can lead an implementer to publish
  the wrong worker or incorrectly narrow recovery compatibility.
- Fix: separate historical deployment evidence from current admission/recovery
  rules; document new protocol-5 receipts and the actual older-worker matrix in
  one current section. Retain historical evidence with its date/version.
- Proof test: compare documentation to the literal identity and all progress
  schema branches; keep `cloud-reviews.test.ts` identity/recovery regressions.
  Existing historical reports do not verify current documentation.

### P-13 — Desktop test instructions describe the removed native-session route

- Category: docs. Severity: low. Verdict: CONFIRMED. Size: S.
- Files: `docs/development.md:12`, `docs/development.md:22`,
  `scripts/isolated-desktop.ts:8`, `scripts/isolated-desktop.ts:41`,
  `scripts/desktop-test-environment.ts:6`.
- Evidence: development.md recommends `DISPLAY=:0` and says Windows/macOS use
  native desktop sessions. The actual local runner rejects non-Linux hosts and
  requires private Linux user/mount/network/PID/IPC namespaces, Xvfb, xdpyinfo
  and other command-line tools; native sessions are allowed only on disposable
  GitHub-hosted runners. Inherited displays are explicitly rejected/hidden.
  The command table also says `check` includes a design study, but package.json
  only runs typecheck, lint and format checking. These are active setup
  instructions, not the clearly dated research records.
- Fix: document actual local requirements, CI-only native sessions and current
  command composition. Keep the isolation protections; do not make the code
  accept the obsolete instructions.
- Proof test: walk through the documented command on a prepared Linux host;
  inspect the intentional early failure on a local macOS/Windows host. Existing
  environment guards test enforcement, not prose accuracy.

## Needs decision

These entries require a product/retention choice. They are separated from fixes
that restore the existing advertised behavior. Do not silently change their
policies while implementing the entries above.

### P-14 — The advertised one-minute cloud configuration cannot dispatch

- Category: correctness. Severity: medium. Verdict: CONFIRMED. Size: S.
- Files: `src/lib/backend-rpc.ts:52`, `backend/cloud/service.ts:567`,
  `backend/cloud/modal.ts:591`, `backend/cloud/contracts.ts:48`,
  `docs/cloud-reviews.md:252`.
- Evidence: configuration accepts 1–60 minutes. The saved deadline starts before
  allocation/upload, while dispatch floors the remaining time to seconds and
  requires at least 60,000 ms. With a one-minute setting, even 1 ms of setup
  yields 59,000 ms and refusal. The worker schema also requires a minimum
  60,000 ms. This follows directly from the three admission boundaries; no
  live sandbox was started to demonstrate an arithmetic invariant.
- Decision/fix: choose whether one minute means a full minute of review after
  setup (requiring coordinated deadlines/warm admission), or raise/reject the
  unsupported configuration before allocation. Do not silently grant additional
  paid time. Until that decision, fail this impossible setting early with a
  specific explanation instead of uploading and leaving a dispatching fence.
- Proof test: offline one-minute start with nonzero allocation/upload time;
  assert the chosen policy, no late surprise, and no unauthorized extra runtime.
  Existing deadline-precision tests cover fractional seconds, not this setting.

### P-15 — Terminal cloud packages accumulate without local retention controls

- Category: perf. Severity: medium. Verdict: CONFIRMED. Size: M.
- Files: `backend/cloud/service.ts:553`, `backend/cloud/service.ts:641`,
  `backend/cloud/service.ts:700`, `backend/cloud/service.ts:716`.
- Evidence: each new job gets full `input/` and later `output/` package
  directories under `<dataDirectory>.cloud/<id>`. Successful import and cancel
  save a terminal receipt but do not delete either directory. Whole-repository
  searches for these staging paths and removal/pruning found cache-volume and
  interrupted-download cleanup, but no terminal local-package retention path.
  At the supported near-1-GiB workspace size, one completed job can retain about
  2 GiB of transfer packages, apart from the intentional pre-restore backups.
  The 1,000-receipt limit is not a storage budget. This is source-confirmed
  accumulation; no user workspace was measured or cleaned.
- Decision/fix: define how long terminal transfer packages remain recoverable
  and whether cleanup is automatic or explicit. Retain small replay/ownership
  receipts; never remove active, paused, failed-but-owned or interrupted-restore
  inputs/outputs. Treat pre-restore backup retention as a separate decision.
- Proof test: under the selected policy, terminal staging shrinks while command
  replay remains non-dispatching and active/paused recovery remains intact
  across reopen. Existing cloud-cache pruning tests concern remote cache files,
  not these local directories.

## Audit conclusions and split notes

15 findings, all CONFIRMED for the stated defect or cost. P-03 explicitly marks
its unexercised startup-race consequence PLAUSIBLE. Categories: correctness 6,
perf 5, tooling 2, docs 2; dead-code/security/standards/slop 0. Severities:
high 2, medium 9, low 4.

Suggested independent implementation ownership: documents P-01/P-02; backend
bootstrap P-03/P-04; cloud persistence/query P-05/P-06; credential normalization
P-07; packaging/dev/tooling P-08–P-11; docs P-12/P-13. P-14 and P-15 await policy
decisions and overlap the cloud implementer's files.

No confirmed trusted-frame/authentication bypass was found. Loopback binding,
private startup credentials, browser-origin rejection, narrow HTTPS shell URLs,
schema boundaries and migration-hash checks are present. This is not a claim
that every security property was exhaustively proved. Existing migrations must
remain byte-for-byte unchanged.

Dependency/export/experiment searches did not establish a worthwhile whole
feature removal. Some exports are only used within their defining module, but
removing `export` alone is trivia. Manually invoked research scripts and recorded
experiment recipes are not declared dead merely because the production app
does not import them. `@opentelemetry/api`, despite no direct app import, is an
optional SvelteKit peer; no removal is recommended without separate build proof.
