# SAM 3.1 drawing experiment

The subsequent [plumbing coordination study](plumbing-segmentation.md) tests
Moke fixture inventory, schedule reconciliation, and corrective prompts.

This is the first perception experiment from the October 26 planning thread.
It tests proposed object boundaries on six drawing crops before choosing an
engineering rule. It runs separately from the Electron application.

## Run

Use Bun 1.4.4 from `.bun-version` and install dependencies with `bun install`.
Install Poppler so `pdftoppm` is on `PATH`, for example `brew install poppler` on
macOS or `sudo apt-get install poppler-utils` on Ubuntu. On Windows, install
Poppler and add its `Library/bin` directory to `PATH`.

The local `Moke-Hackathon-Drawings/` pack must include `drawing-manifest.json`
and its `pdfs/` directory. These local fixtures remain excluded from Git.
First prepare the requests without making model calls:

```sh
bun run test:sam
```

Add `MODEL_API_KEY` to the root `.env`. Run the complete ten-case experiment:

```sh
bun run test:sam --live
```

This sends ten real requests to Meta, one per selected case, and may consume
credits. There are no automatic retries. Requests run sequentially, with a
120-second request timeout. Access, model, billing, and quota failures stop the
batch after saving the failed case. Other case failures remain visible in the
report. The CLI exits with status 1 if any attempted case fails.

Select individual cases or use a different fixture pack or case list:

```sh
bun run test:sam --live --case bathroom-toilets --case bathroom-toilet-box
bun run test:sam --fixtures /path/to/pack --cases experiments/sam/cases.json
bun run test:sam --help
```

`META_API_BASE_URL` defaults to `https://api.meta.ai/v1`.
`META_SEGMENTATION_MODEL` must be `sam-3.1`. HTTPS is required except for
`http://127.0.0.1`, which supports local HTTP contract tests. Keys stay in the Bun
process and are never included in request artifacts or logs.

Every invocation creates a new timestamped run under `.local/sam/`. Change the
parent with `--output /path/to/results`. Open that run's `report.html` locally.
The HTML compares each original crop with its mask overlay. Open either image
at full size to inspect edges.

## Cases

The editable [case list](../experiments/sam/cases.json) contains:

| Case                      | Question                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `bathroom-toilets`        | Can a noun phrase find both toilet symbols?                      |
| `bathroom-sinks`          | Does the same sparse plan support sink recognition?              |
| `bathroom-toilet-box`     | Can a manually selected box isolate the upper toilet?            |
| `bathroom-toilet-points`  | Do positive and negative clicks isolate that object?             |
| `bathroom-absent-control` | Does an absent concept produce zero matches?                     |
| `kitchen-sinks`           | Can it find sinks among labels and equipment?                    |
| `revision-ducts`          | What boundaries does it propose on revised M-2?                  |
| `baseline-ducts`          | What happens with the same prompt and rectangle on baseline M-2? |
| `dense-plumbing-sinks`    | How do dense colored pipe overlays affect fixture detection?     |
| `electrical-panel`        | Can it recognize a small electrical symbol?                      |

The location prompts are manual inputs, not verified labels. Text and location
prompts use separate requests, as required by SAM. Baseline/revision object IDs
are independent and must not be matched by number.

## Evidence and coordinates

Each input is rendered directly from its original cleaned PDF at the manifest's
300 DPI, producing 1800 × 1800 pixels. The existing PNGs serve as references;
the harness does not resize them or convert a page overview into a detail crop.
Different renderers may produce different raster bytes from the same PDF.

The manifest uses PDF points with an origin at the top left. At 300 DPI,
one crop pixel corresponds to 0.24 PDF points. The harness validates the crop
rectangle, offsets, scale, and integer raster origin before rendering. It rejects
responses whose declared source dimensions differ from the submitted crop.

SAM's wire boxes have inclusive `x2` and `y2`. Meta's parser converts them to
half-open right/bottom edges. Those normalized edges are transformed to PDF
points. Masks retain their own raster dimensions and are positioned inside the
corresponding box. Neither PDF points nor pixel counts are physical building
dimensions without independently established drawing scale and applicability.

Saved files:

- `inputs/*.png`: exact crops submitted to the model.
- `<case>/request.json`: prompt, crop transform, input SHA-256, source PDF SHA-256,
  and request settings, without credentials or duplicated image data.
- `<case>/response.json`: exact provider body when received, including any usage
  returned by Meta. Failed or interrupted responses are not accepted as evidence.
- `<case>/result.json`: outcome, elapsed case time, masks, pixel and PDF boxes,
  pending human-review state, and any retained parser warnings. Parser errors
  reject the case; harmless warnings do not discard valid geometry.
- `<case>/overlay.svg`: self-contained crop with decoded masks and boxes.
- `summary.json` and `report.html`: attempted-case results and comparison view.
  The summary lists all selected case IDs; the report shows how many remain
  unattempted if a batch stops early.

Elapsed case time includes the HTTP request, parsing, and per-case artifact
writes. It excludes rendering and is not a pure model-inference measurement.
Cost remains unknown unless established from provider billing. Raw provider
responses retain reported usage for later analysis.

## Decide what to build next

Inspect each mask against the source and record missed objects, false positives,
incorrect boundaries, and cases requiring manual selection. Every result starts
with `review: "pending"`. A completed request, a high confidence score, or zero
matches does not establish correctness.

Use the same rendered crops for the later reasoning comparison: images and
text, better crops without SAM, and the same crops with SAM. This harness supplies
the last two visual inputs; it does not yet compare reasoning models or measure
precision, recall, IoU, correction time, or rule accuracy. Choose an object class
and engineering check only after reviewing this evidence. A panel symbol alone
does not establish working clearance, and different masks across editions do not
establish a verified revision.

## Verification and sources

`bun test tests/segmentation.test.ts` covers protocol decoding, empty results,
failed/incomplete output, coordinate mapping, location prompts, and the real CLI
against a local Responses endpoint. The CLI integration test renders a synthetic
PDF and needs Poppler; it is explicitly skipped when `pdftoppm` is unavailable.
Automated checks do not call Meta or require the local drawing pack. Run the full
repository check with `bun run verify`.

Request settings and parsing follow Meta's official documentation, checked
October 27, 2026:

- [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting): concept,
  box, and point prompts, non-streaming Responses, and string metadata settings.
- [Reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation):
  boxes, masks, source coordinates, confidence, and zero-match results.
- [SAM client libraries](https://dev.meta.ai/docs/sam/client-libraries): the
  `@meta-sam/parser` package used to build prompts and decode geometry.
