# SAM drawing experiments beyond plumbing

## Question and inputs

Can the current SAM 3.1 API help Moke count electrical devices, inspect other
drawing objects, and review revisions? This continues the
[plumbing study](plumbing-segmentation.md). Research used Executor with Exa
search and Firecrawl scraping on 2026-10-27. Drawing experiments use the original
anonymous local PDFs, rendered directly with Poppler. No application integration
or complete permit review is claimed.

The fixture pack has these relevant sheets:

| Set                     | Lighting                              | Power        | Other useful sheets                         |
| ----------------------- | ------------------------------------- | ------------ | ------------------------------------------- |
| A revision and baseline | E-2, PDF page 12                      | E-3, page 13 | M-2 page 9; LS-1 page 3; B-1/B-2 pages 1/2  |
| C                       | E-2, page 7                           | E-3, page 8  | M-2 page 5; P-1/P-2 pages 1/2               |
| B                       | No electrical sheets in supplied pack | None         | B-2 page 2, sparse residential architecture |

Moke's [electrical method](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/electrical.md)
calls for fixture marks, circuits, controls, room use and schedule coordination.
Its [mechanical method](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/mechanical.md)
calls for terminal airflow, equipment marks and system tracing. An object count
is useful evidence for these tasks, while classification, scope and coverage
remain separate checks.

## Results so far

| Target                                                   | Observed result                                                                           | Practical use and limit                                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C waiting/reception/lobby lighting crop                  | `black circle`: 20 round downlights; `green circle`: 2 sconces                            | Direct SAM discovery. Legend inspection separates 19 plain CL-110 fixtures from one circled-1 directional CL-112.                                                   |
| Same PDF rectangle at 150 vs 300 DPI                     | Same 20 downlights and 2 sconces                                                          | A resolution control on one region, not another independent test.                                                                                                   |
| Fresh C pre-op lighting crop                             | Frozen `black circle` prompt found all 10 visible downlights                              | Successful wording transfer to another room.                                                                                                                        |
| C pre-op receptacles                                     | `circle` found all 12 actual receptacles; `triangle` found 5 communication-family symbols | Useful scoped device inventory. Triangle subtypes still require the legend.                                                                                         |
| Fresh C procedure power crop                             | `circle`: 10 true receptacles plus 2 false positives                                      | Precision 10/12, recall 10/10 against visual audit. Eight belong to room 208/circuit 8; two belong to the adjacent circuit-7 room.                                  |
| Fresh C exam-125 power crop                              | `circle`: 2 true receptacles, 9 false positives, 2 missed receptacles                     | Precision 2/11, recall 2/4. Both misses are partly occluded left-wall symbols.                                                                                      |
| SAM proposals followed by Muse classification            | Procedure: 10 receptacles retained; exam: only 2 retained                                 | Classification removed false positives but could not recover missing proposals. An independent omission pass is necessary.                                          |
| Independent Muse grounding on the same fresh power crops | 10 procedure-crop and 4 exam-crop receptacle proposals                                    | Identified four semantic exam entries, including a misplaced GFI box. Grounding and subsequent mask quality differ from semantic detection.                         |
| A rectangular and pendant lights                         | Muse supplied 9 fluorescent and 5 pendant proposals                                       | Nine fluorescent masks associate with real fixtures; four pendant masks are tolerable highlights; one originally filled blank floor.                                |
| Correcting that bad pendant                              | Fresh positive/negative points recovered its P symbol                                     | Moving/tightening the box alone failed; retaining a box with points also leaked. Save failed guidance and remove it when retargeting.                               |
| C HVAC terminals                                         | Three guided masks isolate blue supply, cyan outside-air and magenta return symbols       | Good terminal selection evidence. Labels read 194, 45 and 1200 CFM; the return is in Hall 203 and the crop omits other terminals. Do not sum these as room airflow. |
| B hinged doors                                           | Muse proposed 7; independent visual audit found 8                                         | The omitted bathroom/living door was recovered with a supplied box. Other masks leak into floor/wall regions; not accurate opening footprints.                      |
| A life-safety symbols                                    | Muse proposed 2 exit combinations, 6 emergency lights, 3 extinguishers, 2 detectors       | Several tiny-object boxes/masks miss their symbols. Proposal count is not a successful segmentation count.                                                          |
| B room interiors                                         | Point masks filled much of a bedroom but also its open closet, with holes and leakage     | Not suitable for area or accessibility measurements in this configuration. Extra negative points did not fix the boundary.                                          |
| A duct revision comparison                               | Main-duct masks leaked onto kitchen equipment and floor in both versions                  | Additional points did not establish reliable system isolation. No mask-area delta is reported.                                                                      |

Muse's GFI proposal box was misplaced: `[23,219,65,268]` versus the visible
symbol near `[68,202]`. Four semantic entries did not establish four correct
groundings. Fresh source-guided points, with or without a corrected tight box,
subsequently selected the visible arc. Its incomplete mask does not reconstruct
linework hidden by the drawing's text backgrounds. The failed box is preserved.

Concrete electrical noun prompts such as `electrical outlet symbol`,
`duplex receptacle`, and `recessed light symbol` returned zero on these crops.
Short geometric prompts worked better in some contexts. This does not make
geometric candidates a general electrical classifier: procedure false positives
were a sink drain and the `@` in `USB@42`; exam false positives included furniture
and other devices.

The local visual audit includes an independent Sol pass. These are development
experiments on a few drawings, not measured performance on a representative
benchmark or a human timing study. Exam, pre-op lighting and resolution-control
expectations were generated before their SAM calls. Procedure-room centers were
added as a later visual audit; the retained evidence does not establish pre-run
provenance for that annotation. Each entry now states its timing separately.
Prompt selection and earlier crops were exploratory.

## Scaling control

Seven overlapping tiles cover the two drawn plan wings on C E-2 while excluding
the legend. Plain `circle` returned 268 proposals before overlap removal, including
non-lighting circles. `black circle` returned zero in five of those larger tiles,
despite succeeding on smaller room crops; the other two returned 6 and 31.
Color-qualified prompts also missed sconces in larger contexts.

A follow-on pass classified the original source patches for all 268 candidates,
using Muse without an expected quantity. Mapping boxes to PDF coordinates and
greedily merging boxes with IoU at least 0.5 produced 236 geometric groups.
Of those, 215 were proposed as lighting: **197 plain downlights, 11 directional
downlights and 7 sconces**, with no class disagreement within merged groups.
These are captured model proposals, not verified quantities. The full-sheet
overlay visibly omits some sconces. Rectangular fixtures, R3 multi-head lights,
cove strips, emergency devices and low-voltage assemblies need other prompts.
No whole-sheet precision/recall or complete lighting takeoff is established.

The classification used enlarged patches with candidate IDs outside the source
image area and a full-tile context image. This avoids covering tiny symbols with
ID labels. A preceding whole-image classification experiment correctly rejected
the procedure-room `@`, but its explanation mistook an added red ID for drawing
content; source-based explanations also need inspection. Classification records
refer to the captured SAM response IDs and boxes only and cannot be joined to
new discovery runs by ID alone.

Do not sum tile counts or publish 268 as a fixture count. Coordinate mapping is
available in each result's `pdfPoints`; spatial deduplication and semantic review
are required before a plan inventory. The resolution control succeeded on one
room while context expansion failed, so DPI alone does not explain reliability.

## What the research supports

- [Meta's hosted prompting contract](https://dev.meta.ai/docs/sam/segmenting)
  distinguishes noun-phrase discovery from one-object-per-ID location prompts.
  A supplied box segments that object; it does not ask the hosted endpoint to
  find every matching symbol. Firecrawl returned an unsupported-site 403 for
  this page; Exa fetched its documentation successfully.
- The [SAM 3 paper](https://arxiv.org/html/2511.16719v2) and
  [official source repository](https://github.com/facebookresearch/sam3)
  describe image-exemplar concept prompting: a positive example can request
  all matching instances. That is a promising next experiment for unusual
  electrical symbols. The current hosted API contract used here does not expose
  that exemplar mode. This machine has no NVIDIA GPU available; no local
  weights or additional inference provider were provisioned.
- [SkeySpot / DELP](https://arxiv.org/html/2508.10449v1) studies electrical-symbol
  detection and quantity extraction with trained detectors. It supports the
  workflow's value and documents symbol variability; it does not validate
  off-the-shelf SAM on these sheets.
- [MEP metrics from 2D plans](https://arxiv.org/html/2608.14317) combines lighting
  detection, overlapping tiles and associated text extraction. It motivates
  circuit/type reconciliation after finding objects. Its trained Mask R-CNN
  results are not transferable accuracy estimates for this experiment.
- [CubiCasa5K](https://github.com/CubiCasa/CubiCasa5k) provides annotated room,
  door, wall and object data; [FloorPlanCAD](https://floorplancad.github.io/)
  provides vector symbol annotations. These offer more meaningful future
  held-out evaluations than continuing to tune on the same restroom crops.
- [Kreo's first-party product description](https://www.kreo.net/news-2d-takeoff/auto-measure-3-0-best-ai-model-quantity-takeoff)
  lists object counting, rooms, walls, finishes, doors and windows. These are
  task ideas from a vendor, not proof that its implementation uses SAM or that
  its performance claims apply here.

Further promising uses are fixture-by-circuit coordination, diffuser/return
inventory linked to visible airflow tags, mechanical equipment selection,
door/window schedule reconciliation, and annotation/correction assistance.
Room areas, duct lengths, revision deltas and code clearances require substantially
better geometry and source-specific checks before becoming measurements.

## Reproduce and inspect

Recipes are under [experiments/sam/symbols](../experiments/sam/symbols).
Captured Muse proposals in `candidates.json` are denormalized crop-pixel boxes,
converted from Muse's original 0–1000 coordinates. Original normalized integers
remain in `.local/sam/iteration-3/grounding-<crop>-response.json` and its parsed
`grounding-<crop>.json`. Do not rescale the captured candidate boxes. SAM discovery
recipes need no grounding call. Source PDF filenames match the local fixture pack.
The general guided recipe and held-out guided recipe are disjoint.

In this study, `file` is a repository-relative reference PNG path. Replay renders
from the fixture-relative `pdf`, `page`, rectangle and DPI fields; it does not read
that reference PNG. Actual run-image hashes are saved with each result.

```sh
bun run test:sam --live \
  --fixtures Moke-Hackathon-Drawings \
  --manifest experiments/sam/symbols/crops.json \
  --cases experiments/sam/symbols/holdout-cases.json \
  --output .local/sam/symbol-replay
```

Omit `--live` to render and validate without paid inference. Use `--case ID`
to repeat one case. Other recipe files preserve discovery prompts, larger tiles,
room/revision controls, multi-object grounding and actual corrections. Guided
recipes contain supplied locations, so their output cannot establish discovery
recall. Never overwrite earlier runs to hide failures.

Raw requests, image hashes, responses, result summaries, overlay SVGs and reports
are retained in `.local/sam/iteration-3/`. Exploratory Muse scripts and Exa/Firecrawl
source records are there too. The study does not establish billing totals or
production accuracy.

This expansion completed **85 SAM requests and 18 Muse responses**. One earlier
Muse attempt ended with SIGTERM before a response was saved; its door-grounding
request was repeated explicitly. There is no billing receipt for that attempt.
The local overview is `study.html`; scaled proposals and their per-tile source
observations are in `tile-inventory.json` and `tile-inventory.svg`.
