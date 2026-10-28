# Review SAM adapter

`backend/inference/segmentation.ts` provides `ReviewSegmentation.layer(config)`.
Its public operations are `segment(fence, request)` and `list(projectId)`. Both
return Effect values with `ExecutionError`; the parent owns their ManagedRuntime
and cancellation. No background runtime, fallback provider, automatic retry,
accepted fact, finding mutation, or new artifact directory is introduced.

## Parent integration

The configuration is:

- `dataDirectory`: the directory containing migrated `app.sqlite`.
- `queries`: the parent's shared `Semaphore.Semaphore` for SQL and recovery.
- `owner`: the held `DataDirectoryOwnership.Service` with its generation.
- `apiKey`: `Redacted.Redacted<string>`, unwrapped only for Authorization.
- `loadArtifact(projectId, artifactId): Effect<Artifact, ExecutionError>`.
- `readImage(artifact): Effect<ExecutionImage, ExecutionError>`.
- Optional `transport(url, RequestInit): Promise<Response>` for local tests.

The only request route is `https://api.meta.ai/v1/responses`, model `sam-3.1`.
Transport injection does not change the recorded route or model. Offline runs
cannot dispatch SAM, and recorded runs require an injected transport. There is one
120-second timeout and no request retry. The Effect abort signal covers fetch
and body consumption. Responses are capped at 8 MiB. The image port must supply
exact base64 PNG bytes, dimensions no larger than 2048 on either axis, at most
1 MiB of encoded PNG bytes, and both complete affine transforms for those
pixels. The service checks the image's identities, schema, and byte bound.

Register the exported Effect schema `SamInspectionRequest` from
`src/lib/review/segmentation.ts` as the tool's argument schema. It accepts an
allowed rendered `artifactId` and `prompt`, a discriminated union:

- `{kind: "concept", text}` with 1–500 trimmed characters.
- `{kind: "box", box: {left, top, right, bottom}}` with half-open pixel edges.
- `{kind: "points", points: [{x, y, label: "positive" | "negative"}]}`.
- `{kind: "guided", box, points}`.

Points are limited to 32, coordinates to 0–2048, and the official prompt builder
checks actual image bounds and nonempty boxes. The supported subset deliberately
omits the experiment's multi-object prompt. The model chooses a rendered source
and guidance; the parent combines the result with the same source image for
subsequent model interpretation. SAM returns proposed instances and masks only.
An empty completed result is a zero-match proposal, never a coverage guarantee
or a deterministic no-issue finding.

The service validates project-qualified artifact membership, PNG media type,
and membership in the selected finding's drawn or scheduled sheet. It validates
run/project/finding/journal/owner identities, running or pausing state, run
versions, and current project source/fact versions before admission and again
immediately before recording `sent=1`. The source loader must return the same
immutable artifact manifest that admission authorized.

## Ledger and recovery

Migration `0004_sam_observations.sql` adds only `review_sam_attempts` and its
indexes. It references the existing run plus project-qualified finding and source
artifact records. The operation UUID is `fence.commandId`. Every new intent is
committed with status `uncertain`, `sent=0`, and an exact key-free request JSON
including the bounded submitted PNG. Admission increments the existing run's
`admitted_calls` and permits at most two SAM rows per run. Unknown token usage
and cost stay null; SAM does not invent token reserves or rates.

A semantic input fingerprint includes run/project/finding/journal IDs, source
and fact versions, request, route, model, and parser version. Owner generation
is a dispatch fence, not a different semantic request. The full receipt
fingerprint additionally includes the source hash, submitted PNG hash, exact
request body, delivered dimensions, and both transforms. A completed matching
operation returns its original immutable receipt before state/version/owner
checks and before reopening source files. Different semantic inputs under that
operation ID conflict. Receipt replay uses the original delivered bytes rather
than encoding the immutable source again.

An existing uncertain intent, including `sent=0`, never dispatches on retry or
reopen. Failures after admission persistently mark the run uncertain and append
an execution event, retaining a cancelled state if cancellation already won.
The parent must not convert an uncertain SAM error into ordinary model progress.
Malformed provider output retains the raw HTTP body and any successfully parsed
response ID in the attempt. SQL connections are scoped to short transactions
under `queries`; each reads back foreign key enforcement and FULL synchronous
mode before its transaction. No SQL permit spans image preparation, network I/O,
or official SAM parsing and geometry processing.

A completed late response is saved with `recordedAs: "historical"` if the fence
has changed, then the caller receives `ExecutionError` with reason `conflict`.
Replaying that historical receipt also returns conflict. `list(projectId)`
returns normalized completed observations, including historical entries, with
no private request bytes, HTTP headers, or raw response. `recordedAs: "proposal"`
means eligible at completion, not permanently fresh after later corrections.
The observation's source/fact versions remain available to assess later staleness.
A forced Effect abort can leave an uncertain attempt even if a server eventually
finishes; the service does not detach a callback or resend to recover it.

The full review package already contains `app.sqlite`, including these private
requests and raw responses. No additional export artifact type is needed.

### Required parent SQL changes

The parent owns these changes outside this adapter's assigned files:

1. `ExecutionStore.status`: add the following count to the existing unresolved
   execution-attempt count, for the same run:

   ```sql
   SELECT count(*) AS n FROM review_sam_attempts
   WHERE run_id = ? AND status = 'uncertain';
   ```

2. Start/resume/reopen guards: include uncertain SAM rows in every unresolved
   attempt check. For a run, use the query above. For project/finding start
   admission, join `review_sam_attempts s` to `review_execution_runs r` on
   `r.run_id = s.run_id`, filtering `r.project_id = ?`, `r.finding_id = ?`, and
   `s.status = 'uncertain'`:

   ```sql
   SELECT count(*) AS n
   FROM review_sam_attempts s
   JOIN review_execution_runs r ON r.run_id = s.run_id
   WHERE r.project_id = ? AND r.finding_id = ? AND s.status = 'uncertain';
   ```

   Do not resume or start a replacement run to reissue
   unresolved work. Preserve cancelled state while still reporting its unknown
   attempt count.

3. Completion and driver error handling must preserve an uncertain run or an
   existing cancellation after a SAM failure, including a tool error the model
   would otherwise treat as recoverable. Shared `admitted_calls` already includes
   SAM; do not add its count a second time. The parent also owns maintenance
   admission while an operation or unresolved intent exists.

## Geometry and parser evidence

The adapter uses published `@meta-sam/parser@0.1.0` exports: `buildObjectPrompt`,
`formats.segmentation.image()`, `recordsOfKind`, and `decodeMaskToSVGPath`.
The request asks for `include_confidence: "true"` and `mask_encoding: "one_bit"`.
The official decoder supports both one-bit and lossless masks; both are retained
with their own encoding and native raster dimensions. It rejects malformed
records, text in the segmentation lane, duplicate instance IDs, unsupported
frames, incomplete masks, and boxes outside the delivered image. The normalized
public receipt retains inclusive source-pixel edges as well as the parser's
half-open rectangle. Each half-open corner passes through the actual delivered
`pixelsToPdf` affine transform; the receipt stores four corners and their PDF
bounds. Mask bounds stay in source pixels, while mask width/height stay in the
mask's own raster space.

The public parser drops declared wire `w`/`h` after checking that wire boxes fit
those declared dimensions. The adapter checks normalized boxes against actual
submitted dimensions but cannot independently reject a changed declaration
whose boxes still fit. It does not add handwritten token parsing to work around
that API gap. The merged experiment's supplemental regex check is intentionally
not copied. Exact source and submitted dimensions, hashes, transforms, and raw
response remain available in the receipt for audit. Exposing declared source
size in the official parser would close this remaining protocol validation gap.

`tests/smoke/review-segmentation.test.ts` uses real temporary SQLite databases with all
four migrations and an injected transport. It covers completed zero/one/multiple
outputs; confidence-bearing one-bit masks; source-pixel inclusive one-pixel edges;
mask dimensions distinct from the image; rotated, resized, offset inverse maps;
malformed responses; paused/cancelled/old-owner receipt replay; uncertain intent
reopen; correction/cancellation/revision/owner changes during inference; project,
finding, source, journal and owner admission; shared and SAM-specific call limits;
pre-send revalidation; concurrent delivery; and Effect abort during fetch headers
and body consumption. No paid request runs in these tests. The parent owns live
SAM validation, final integration, full verification, council, and publishing.
