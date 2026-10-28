# SAM for Moke plumbing coordination

This study applies Moke's [plumbing review instructions](https://github.com/sc-frederick/skills/blob/8a0e2648738018631eaa6d24ee0b6ebaa239afb1/moke-review/references/disciplines/plumbing.md): reconcile fixture marks and quantities, room uses, and existing/new scope across drawings.

## Result

Sample C's P-1 schedule independently reads **6 WC and 6 LAV**. Muse Spark 1.3
located those twelve fixtures in four selected P-2 restroom crops without
receiving the schedule quantities. SAM 3.1 then produced inspectable masks at
all twelve locations on the original colored crops. Some edges and tanks remain
incomplete, and pipes leave holes. Counting instances does not require a perfect
polygon.

| Approach                                                      | Observed result                                           |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| SAM `toilet` / `toilet symbol` on four colored restroom crops | Zero detections                                           |
| Color removal and gray-line thresholding                      | One WC plus a false positive on a door                    |
| Manually supplied tight boxes                                 | Twelve masks at fixture locations                         |
| Muse pixel boxes in one multi-image request                   | Twelve masks, including wrong wall/grab-bar geometry      |
| Muse normalized boxes, one image per request                  | Twelve candidates at real fixtures, followed by SAM masks |

The useful path is **independent schedule extraction → Muse grounding → SAM
evidence → deterministic reconciliation**. Muse supplies proposed class and
location. Twelve masks from twelve supplied boxes are not independent discovery
or semantic verification. The masks give the reviewer object-specific evidence
to inspect and correct.

The regions were selected during development. Whole-sheet coverage, other
schedule classes, measured improvement over Muse boxes alone, and accuracy on
other projects remain untested. The worksheet is a bounded coordination
experiment, not a complete permit review.

## Reproduce

The recipe files contain anonymous coordinates, captured Muse candidates, and
the separately extracted schedule. Source PDFs remain in the ignored local
fixture pack. Frozen candidates make the SAM stage repeatable without another
grounding call. These are development fixtures, not held-out evaluation data.

```sh
bun run test:sam \
  --manifest experiments/sam/plumbing-crops.json \
  --cases experiments/sam/plumbing-cases.json
```

Add `--live` for twelve paid SAM calls. The existing timeout, no-retry policy,
input hashes, raw responses, and PDF transforms apply. Render schedule evidence:

```sh
pdftoppm -f 1 -l 1 -r 144 -x 1584 -y 24 -W 3000 -H 636 \
  -singlefile -png Moke-Hackathon-Drawings/pdfs/sample-c.pdf .local/c-schedule
```

Use the resulting SAM run directory to create the offline worksheet:

```sh
bun run reconcile:fixtures \
  --schedule experiments/sam/plumbing-schedule.json \
  --candidates experiments/sam/plumbing-candidates.json \
  --run /path/to/the/sam-run \
  --schedule-image .local/c-schedule.png \
  --output .local/plumbing-reconciliation.html
```

This step makes no provider calls. It joins each candidate to its exact crop and
box request, verifies input image hashes, and reparses saved responses. Failed
evidence stays `needs-input`; other schedule classes stay `not-tested`.
Differing counts require inspection, rather than becoming confirmed defects.

Cases already marked failed or prepared retain their original crop and remain
`needs-input`. Corrupt or inconsistent evidence in an archive marked successful
stops reconciliation visibly, as does a changed input-image hash.

The self-contained HTML embeds the schedule and combined overlays. Exclude a
proposal to recalculate the count and delta. Completion checkboxes track review
tasks separately from verified findings. Selections stay in that browser and
report revision; evidence hashes isolate revisions. Choose new HTML/JSON paths
to preserve prior reports. The worksheet does not invoke inference or retarget
masks inside the report.

The initial view preserves the original Muse boxes. Toggle SAM masks to compare
the added geometry. Export review decisions to save original proposals,
included/excluded candidates, and completion selections. No human timing study
has been completed, so review-speed improvements remain unmeasured.

## Correcting evidence

Four additional live tests are preserved in
[plumbing-refinement-cases.json](../experiments/sam/plumbing-refinement-cases.json):

- A fresh positive toilet click and negative wall click recovered the private
  restroom fixture after the earlier Muse pixel box selected a wall.
- Keeping the wrong box alongside those clicks still selected wrong geometry.
  Retargeting should discard stale guidance.
- A lavatory point alone selected a small patch with low confidence.
- A lavatory box plus positive and negative points selected the fixture while
  excluding the adjacent `LAV` label more effectively.

```sh
bun run test:sam --live \
  --manifest experiments/sam/plumbing-crops.json \
  --cases experiments/sam/plumbing-refinement-cases.json
```

These are manually supplied corrections, not automatic recovery. Failed attempts
remain alongside successful ones. Earlier residential probes also showed that
`sink symbol` found both sinks where `sink` found none, while other synonyms
misclassified toilets as lavatories.

## Next checks and sources

Compare Muse boxes with SAM masks on identical candidates before claiming time
or accuracy savings. Check held-out rooms, overlapping crop coverage, missed
Muse candidates, visible marks, and new/removed scope. Keep schedule quantities
out of grounding prompts.

Moke source: `sc-frederick/skills` revision
`8a0e2648738018631eaa6d24ee0b6ebaa239afb1`, master instructions, shared method,
and plumbing discipline. API grounding follows Meta's
[normalized coordinate guidance](https://dev.meta.ai/docs/image-understanding#perception-grounding)
and [SAM location prompts](https://dev.meta.ai/docs/sam/segmenting).
Local records, raw responses, and focused evidence are in
`.local/sam/iteration-2/`. This iteration used six Muse calls and 97 SAM calls.
No billing total is established.

## Council-directed experiments

Sol recommended testing imperfect geometry. Four fixtures each received a box
expanded 20% around its center and one shifted horizontally 20% of its width.
All eight masks retained fixture association, but two private-restroom shifts
also absorbed substantial wall geometry. This misses the proposed pilot bar of
seven clean associations out of eight. Four distractor boxes also returned
masks; the WC text itself scored about 0.945. Confidence is not a fixture-type
or acceptance test. The recipe is `plumbing-robustness-cases.json`.

Grok recommended one multi-object prompt per room. Four requests preserved all
twelve IDs and returned the same boxes as twelve single-object manual-box
requests on identical input hashes. Recorded case time totaled 6.77 seconds
versus 14.82 seconds for the earlier single-object run. This is one local
comparison, not a general latency estimate or a billing claim. The recipe is
`plumbing-room-cases.json`; the reconciliation worksheet continues to use the
captured Muse single-object run.

Grok's full-box/point comparison, `plumbing-wc-points-cases.json`, showed why
prompt choice matters. Full checked boxes plus the same positive/negative
points kept the manual toilet boundary within 15 pixels in all three cases.
Points alone clipped the patient and staff toilets and fell just outside the
15-pixel tolerance on the private toilet. Counts may still be usable with those
partial masks; solid equipment footprints need a stricter review.

The single pipe-exclusion probe is in `plumbing-pipe-case.json`. Every council
experiment keeps original colored inputs, object IDs, raw responses, and failed
outcomes. The recommended two-person review-time comparison has not been run.
