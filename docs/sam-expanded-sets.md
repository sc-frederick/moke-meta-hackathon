# SAM on the additional discipline sets

## Inputs and method

This continues the [drawing expansion](sam-drawing-expansion.md) and
[adaptive Meta review](adaptive-meta-review.md) using the additional fixture pack
at `Moke-Hackathon-Drawings/expanded/`. Its README inventories 37 anonymized
sheets from Samples D–J plus a hydraulic extract. The pack contains three new
electrical styles, structural plans and connection details, civil grading,
fire alarm, sprinklers and related coordination inputs.

Two source-only agent audits saved electrical/alarm and structural observations
at 23:15:00 and 23:15:27 UTC on 2026-10-27, before those crops' first inference.
The parent separately recorded civil observations before its probes. These are
implementation-agent observations, not a human benchmark. Annotation points,
quantities and timing are retained in `experiments/sam/expanded/expectations.json`.
Inference used original source images; it did not read that evaluation file.

The study made 42 SAM requests and eight completed Muse Spark 1.3 requests.
Every request, response, rendered input, source hash and coordinate transform is
retained under `.local/sam/iteration-5/`. All 13 supplied noun-prompt cases
completed with zero objects. Subsequent experiments used geometric prompts,
legend-based Muse classification/grounding, batched per-object SAM boxes and
explicitly manual source corrections. These methods are reported separately.

## Useful results

| Workflow                 | Captured result                                                                                                                                                                                        | Review value and boundary                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J alarm symbols          | SAM `square` and `hexagon` proposals together hit all eight frozen regional centers, with no extra boxes. Muse read HD×2, DH×1, CR×2, TD×1, F×1 and wall-V×1.                                          | Compare source-localized classes to the legend. The full-plan legend totals 15; this crop exhausts only some rows. Riser repetitions are not additional physical devices.                                                                             |
| F tagged lighting        | SAM `circle` proposals plus Muse tag reading retained all 13 A-fixture centers with no extras. The observer rejected EF-2 and switch text.                                                             | Supports a regional lighting inventory even though this PDF's text is not extractable. The image-readable A legend and panel rows provide separate evidence; the crop cannot establish full-circuit load agreement.                                   |
| G connection detail      | `small outlined circle` found five of six hole centers and one large E detail bubble. A supplied box recovered the missing hole; the corrected set excludes the detail bubble.                         | Inspect four holes in the full-plate detail and two in the alternative half-plate detail. These six drawn circles are not six installed anchors. The successful correction uses manual source guidance.                                               |
| G support marks          | Independent Muse proposed five posts with C1×1/C2×2/C3×2 and FD-1×3/FD-2×2. Guided SAM geometry hit four of five source centers; the west-wall C3 proposal was misplaced.                              | Trace candidate locations to same-sheet schedules and S-3 details. A source-reviewed box corrects that location. A returned mask does not validate its type or capacity.                                                                              |
| I grading arrows         | `blue arrow` returned eight proposals; Muse retained five complete arrows and treated the other three as edge fragments. Complete-arrow readings are 16% up-right, 4% down, 9% down, and two 2% right. | Provides selectable slope/direction evidence. Directions are on the image, not geographic bearings. The earlier color-component control also found the five complete arrows; an incremental discovery benefit over that simpler baseline is unproven. |
| D/E lighting and F power | Independent Muse proposed the source-audited object families, and SAM returned one mask for every supplied object in four batches. Several locations remain imperfect.                                 | Useful selection and correction candidates. Batch size or successful response count is not segmentation accuracy; score locations and classes separately.                                                                                             |

The J legend and F legend/panel images were supplied as context when classifying
existing proposals. Those calls were not independent discovery tests and were
not evaluated against a quantity hidden from the classifier. The independent
D/E/F/G grounding prompts supplied no expected quantities. Their semantic
counts still do not establish correct locations or mask boundaries.

Typed, strict center checks give D fixtures 6/7, E fixtures 6/7 and F power 8/10.
The F power grounding boxes scored 7/10 before SAM. On E, the missed high-bay
center lies exactly on a returned box's exclusive bottom edge; a separately
reported one-pixel sensitivity check recovers it. That does not replace the
strict result. Matching within each semantic kind prevents the large fan box
from being counted as a missing high-bay. Manual source boxes recover the two
real F troffers and the misplaced G post. These controls are not autonomous
recovery claims.

## Failures that matter

The F `rectangle` result selected equipment below a real troffer, although Muse
called that proposal a troffer. This is another example of a semantic label
failing to verify location. Two actual complete rectangular light symbols are
recorded in the source audit and tested with explicit manual boxes.

On the complete civil building crop, `building footprint` returned no objects.
An interior point selected part of the printed `28` dimension, and a supplied box
returned complicated geometry crossing linework. Neither establishes a usable
footprint polygon. The printed 60-foot by 28-foot rectangle supports 1,680 square
feet by arithmetic; that number is not a validated SAM area measurement.

The sprinkler noun probe returned zero and plain `circle` returned one proposal.
The legend distinguishes head symbols from the many pipe-size callout circles.
Notes also require duplicate heads above and below ceiling panels in several
areas. Counting plan icons alone would miss that physical-quantity distinction.
No complete sprinkler inventory or spacing/hydraulic check was demonstrated.
The two hydraulic pages are result excerpts, not a complete calculation model.

The truss and bracing noun probes returned zero. A separate Muse reference-reading
experiment transcribed the S-1 note `SEE DETAIL A/S-1` and the supplied S-2 section
A caption, whose bubble contains both S-2 and S-1. This is a reference to clarify
against the sheet convention, not a confirmed design defect. SAM did not discover
that text mismatch, and no structural capacity conclusion follows from it.

## Reproduce

The original PDFs and images remain in the Git-ignored fixture pack. The tracked
manifest has 18 source regions; seven recipe files contain 42 unique case IDs.
Preparation renders original PDF crops without inference:

```sh
bun run test:sam \
  --fixtures Moke-Hackathon-Drawings/expanded \
  --manifest experiments/sam/expanded/crops.json \
  --cases experiments/sam/expanded/shape-cases.json
```

Add `--live` to make paid requests. Other recipe files are `provided-cases.json`,
`structural-cases.json`, `structural-correction-cases.json`, `civil-cases.json`,
`guided-cases.json` and `manual-cases.json`. The guided recipes preserve captured
Muse box proposals in crop pixels; they do not rerun Muse or test independent SAM
discovery. Manual recipes explicitly use source-reviewed locations.

`tests/smoke/expanded-segmentation.test.ts` validates every recipe and prompt before
inference, including image bounds, required point labels and unique IDs across
the recipe files. This preflight needs no PDF files, API credentials, or model
calls. Historical scores for the 15 branches remain in `captured-locations.json`
and `expected-metrics.json`; the test suite no longer reruns the scoring helper.

Source review methods: Moke's
[electrical](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/electrical.md),
[structural](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/structural.md),
[civil](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/civil.md),
[fire alarm](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/fire_alarm.md)
and [sprinkler](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/fire_sprinkler.md)
instructions. This study tests selected supporting workflows; it is not a full
permit review or a claim of complete sheet coverage.
