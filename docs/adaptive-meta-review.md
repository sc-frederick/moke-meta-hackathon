# Adaptive Meta drawing review

The hackathon rubric assigns 25% to creative use of Meta AI tooling. This
experiment combines Muse Spark 1.3 reasoning, independent visual observations,
and SAM 3.1 segmentation in an evidence-seeking electrical review. Muse chooses
local tools through Meta's Responses API; the application executes them against
the original PDF and returns new source images and mask feedback.

This extends the [cross-discipline study](sam-drawing-expansion.md), where SAM
found all 12 receptacles in a clean crop but only two of four in a cluttered exam
room, with nine false positives. Classifying SAM proposals cannot recover objects
that SAM omitted. Independent Muse grounding can find additional devices, but
its supplied boxes can also be misplaced. Neither path verifies the other.

## Run

Use the repository's Bun version and install Poppler (`pdftoppm`). Rendering a
prepared report needs no API credential and makes no provider request:

```sh
bun run test:review-agent --case exam-development
```

Live runs use `MODEL_API_KEY`, `META_API_BASE_URL` (default
`https://api.meta.ai/v1`), Muse Spark 1.3 and SAM 3.1:

```sh
bun run test:review-agent --live \
  --fixtures Moke-Hackathon-Drawings \
  --manifest experiments/sam/symbols/crops.json \
  --cases experiments/sam/adaptive-cases.json \
  --case exam-development \
  --max-turns 12 --max-meta 18 --max-sam 6
```

`procedure-development` and `preop-control` are additional cases. The case file
contains tasks and source geometry; it supplies no expected quantities, truth
centers, successful correction clicks, or circuit answers. Exam and procedure
were explored in the earlier study and are development cases. Pre-op is a clean
control already explored there, rather than an untouched transfer test.

`workarea-transfer` uses a previously untested work-area crop. Its source centers
and attribute expectations were frozen in `adaptive-expectations.json` before
inference. That file is evaluation data and is never read by the live workflow.
Manifest descriptions can contain earlier audit answers; runtime frames use a
neutral description. Original manifest prose stays in private `source.json`
metadata and is excluded from model-visible tool results.

The work-area annotation write completed at 22:51:25 UTC, before the run started;
an evaluator read at 22:51:45 also precedes the blind response at 22:51:54.
Formatting at 22:52:13 replaced the JSON inode, so its later filesystem birth
time is not its first-write time. The parent execution records and a controlled
formatter reproduction are retained in `.local/sam/iteration-4/workarea-parent-chronology.json`
and `formatter-inode-evidence.json`. Annotation timing is explicit in the fixture;
the evaluator labels absent timing as unknown rather than inferring it.

## Tools the model can choose

1. `survey_room` runs SAM circle discovery, a blind Muse inventory, or semantic
   classification of SAM proposals. The independent observer sees only the
   original image and its own instructions. All three are required before
   `finish_review` succeeds.
2. `inspect_region` renders a higher-resolution crop from the original PDF around
   a selected proposal. A separate Muse observation supplies tight locations,
   visible source assertions and fresh positive/negative guidance.
3. `segment_candidate` applies points, a box, or combined guidance from that
   inspection. The reasoning model receives the source and SAM overlay and can
   request another inspection or strategy. A returned mask does not verify class.
4. `record_correspondence` proposes a one-to-one link between an unmatched SAM
   and blind proposal after inspecting both source regions. It preserves SAM
   geometry and both observations, and records the cited inspections and rationale.
   This makes a source-supported duplicate relationship explicit instead of
   leaving it only in the model's prose. Linked rows remain pending review.
5. `finish_review` records the model's conclusion. Unmatched entries remain
   unresolved and every worksheet row remains pending reviewer verification.

The hosted contract uses ordinary per-object box/point guidance. This does not
implement SAM's research image-exemplar mode that discovers every similar object.
See Meta's [tool calling documentation](https://dev.meta.ai/docs/tool-calling)
and [Responses protocol](https://dev.meta.ai/docs/protocols/responses). These were
checked through Executor Exa; Firecrawl could not scrape the developer site.
Only `tool_choice: "auto"` is supported by the checked contract. The adapter
uses `store: false` with `include: ["reasoning.encrypted_content"]`, replaying
encrypted reasoning, prior calls/results and images on subsequent turns. A
server-managed-history attempt failed with “referenced response not found or
expired”; it is retained as a failure rather than retried automatically.

## Evidence and boundaries

Each run creates a fresh directory under `.local/sam/adaptive/` containing:

- `source.json`: crop, PDF and rendered image hashes and coordinate transform.
- `model/`: redacted request metadata and raw Meta responses. Image bytes are
  represented by hashes in saved request metadata; metadata is not a POST replay.
- `sam/`: prompt, raw response, parsed geometry and PNG/SVG feedback per request.
- `inspections/`: original PDF zooms with their transforms and observed assertions.
- `result.json` and a self-contained `report.html`: comparison, worksheet and
  model-directed operation trace, including partial results after a failure.

Budgets cover all Muse requests, all SAM requests and reasoning turns separately.
There are no automatic retries. Each target permits two inspections. HTTP,
schema and parsing failures stop the run visibly, retaining earlier evidence;
invalid tool arguments are returned to the model within the same bounded loop.

Geometric agreement requires a mutually unique match with comparable box area
and sufficient overlap or center proximity. Ambiguous pairs remain unmatched.
Agreement is a localization heuristic, not semantic validation or proof of
coverage. If both observers omit a device, the present proposal-centered tools
do not guarantee discovery elsewhere in the room.

The worksheet keeps room, panel, circuit and visible protection assertions with
their quote, source image and normalized source box. Unsupported or conflicting
assertions must be reviewed individually. A displayed `GFI` reading describes
drawing notation; it does not establish installed protection or code compliance.
SAM mask bounds do not establish physical clearances, symbol completeness or
precise fixture footprints.

## Evaluation

Compare SAM plus classification, independent Muse grounding, and the final
combined proposals against frozen source annotations outside the model prompts.
Score locations one-to-one; equal totals do not establish correctness. Score
room/circuit/protection attribution separately from location and mask usefulness.
Retain unsuccessful requests, call totals and elapsed time.

`tests/spatial-inventory.test.ts` replays the earlier frozen-center checks against
the small, hash-linked `captured-locations.json` fixture: procedure 10 hits / two
extras / zero misses; exam two hits / nine extras / two misses; fresh lighting
10 hits / zero extras / zero misses. Procedure annotations are a post-run visual
audit; exam and lighting expectations were recorded before their SAM runs. These
are implementation-agent annotations independently audited by Sol, not a human
benchmark or an estimate of performance on unseen drawings.

The initial adaptive attempt stopped after its blind observer used all 7,000
completion tokens on reasoning and returned no inventory. The next configuration
uses a 16,000-token allowance with medium observer reasoning. The planner keeps
high reasoning effort. Failed attempts are retained under `.local/sam/iteration-4/`.

The next two development attempts were excluded from unassisted performance
claims after discovering expected quantities in manifest prose that reached the
planner through frame metadata. The independent observer remained isolated,
but the planner's correction decisions were potentially influenced. A dedicated
regression test now checks that a hidden-quantity marker cannot enter tool results.

The useful demonstration gate is autonomous disagreement investigation and an
improved, inspectable location or attribution, with remaining uncertainty visible.
Passing a known development case does not establish general recall or a reviewer
time saving.

The first clean procedure run correctly described eight in-room devices and two
adjacent-room devices, and rejected the `@` and sink-drain distractors. Its source
zooms also recognized two duplicated proposal pairs, but the worksheet retained
12 rows because the geometric matcher could not express those relationships.
That result motivated the explicit correspondence tool; it was not counted as a
successful unique inventory.

## Captured transfer result

The first `workarea-transfer` run finished with four source-linked proposals,
all four matching the frozen centers, with zero extra boxes or missed centers.
SAM discovery and SAM plus Muse classification each scored 4 hits / 0 extras /
0 misses. Independent Muse returned four semantic entries, but one box stopped
above its actual symbol center: the stricter center-hit test scored 3 / 1 / 1.
The final worksheet retained the SAM locations and the observers' source
assertions. This is a small measured example of complementary geometry, rather
than evidence of broad accuracy gains.

The run used one SAM request and ten Muse requests: six planner turns, independent
inventory and classification, and two zoom observations. Muse requested both
zooms itself, confirmed the distinction between duplex circles and communication
triangles, and chose to keep the existing SAM geometry. The source supports Room
107, panel NP-1 and circuit 8 for all four. Visible protection stays unsupported.
All four rows remain pending review; geometric agreement alone does not verify
room-wide coverage. The self-contained report was opened with Playwright: four
images and four rows loaded with no page errors.

Captured artifacts: `.local/sam/iteration-4/workarea-transfer/2026-10-27T22-51-25-380Z-a6647c7b/`.
The offline study evaluator and its full comparison are retained as
`.local/sam/iteration-4/evaluate.ts` and `evaluation.json`.

The clean exam recovery run finished with four proposed instances. SAM plus
classification initially hit two of four centers; independent Muse also hit two
despite returning four entries. Muse requested two source zooms, repaired the
upper-left outlet using fresh points, saw a second point prompt spill outside
the study crop, and retried the lower-left object with a box. The returned lower
mask highlights only part of the occluded symbol and misses its frozen center.
The final strict score is therefore 3 hits / 1 extra box / 1 missed center,
rather than 4/4 accurate geometry. It used 13 Muse and four SAM requests. The
visible partial association is useful review evidence, with incomplete geometry
explicitly retained as a limitation.

With the correspondence tool available, the next procedure run finished with ten
unique rows: ten center hits, zero extras and zero missed centers. SAM plus
classification was already 10/0/0; independent Muse's strict locations were
7/3/3. The combined worksheet initially had 13 rows because three blind boxes
were offset. Muse requested source zooms for both sides of each disputed pair
and recorded three one-to-one links, retaining the original SAM geometry.
The final row count returned to ten with all three relationships cited and
pending review. The source supports eight devices in Procedure 208 on NP-2
circuit 8 and two adjacent-room devices. Adjacent circuit text is truncated;
the model left those assignments unknown. It used 21 Muse and one SAM request.

This demonstrates a useful coordination worksheet with inspectable room scope,
disagreement handling and recovery decisions. It does not show that running
every independent observer is cheaper or faster than a human or SAM alone.
