# Parallel sheet review on Meta: live results

Measured 2026-10-29 on branch `feat/parallel-sheet-review`. Each run imported one supplied PDF into a
fresh workspace and ran a whole-set review on Muse Spark 1.3 (`xhigh` reasoning, Meta web search)
with no call budget. The runner lives in the ignored `.local/parallel-review/live.ts`. Costs use
Meta's list prices ($1.25 input, $0.15 cached input, $4.25 output per million tokens); the key was
on free credits.

## Results

| Set                                         | Sheets | Time      | Checks recorded | Settled | Findings | Calls |   Cost |
| ------------------------------------------- | -----: | --------- | --------------: | ------: | -------: | ----: | -----: |
| Civil grading (project-04)                  |      5 | 9.0 min   |       220 / 220 |     211 |       29 |   115 |  $1.98 |
| Brewery (project-01), 16 at a time          |     29 | 43.4 min  |   1,276 / 1,276 |   1,249 |       69 |   941 | $16.55 |
| Brewery, one conversation (Audit 3 recheck) |     29 | 33.6 min¹ |     220 / 1,276 |       — |        — |     — |      — |

¹ Muse Spark Open on Baseten; the review stopped before finishing.

Brewery token use was 4.1M uncached input, 58.1M cached input and 0.63M output, about 1.5M tokens a
minute against Meta's 4M limit. No request was refused.

## Where the time went (Brewery)

- Setup 1.4 minutes, sheet stage 36 minutes, coordination 5.5 minutes.
- Median sheet reviewer 8.9 minutes; 90th percentile 23.5; slowest S-1 at 32 minutes and 82 turns.
- Median turn (model plus tools) 19 seconds; 90th percentile 38 seconds.
- Thirteen sheets queued behind the 16-sheet limit for up to 12 minutes. Starting all sheets at once
  would have saved about 4 minutes, because S-1 started immediately and still set the end of the
  sheet stage.

Turn count, not concurrency, sets the length of the sheet stage. After this run, Meta concurrency
became 32 and sheet reviewers are asked to batch crops, coverage and findings into fewer turns.
Neither change has been measured yet. Lowering sheet reviewers from `xhigh` to `high` reasoning
would shorten turns but is unmeasured.

## Review quality

The coordinator recorded cross-sheet conflicts with locations on both sheets. Brewery examples:
electrical service E-1 400 A three-phase against E-3 25 kVA single-phase; building footprint B-5
86×91 against G-1 and S-2 90×85; water heater model P-1 against P-3; LS-1 occupant table summing to
7,484 SF against the stated 7,650 SF. Civil examples: a detail index mismatch between C-2 and C-4,
and a 5% against 2% slope conflict between C-2 and C-3. Each sheet reviewer left 8 to 11 key facts.

In the civil run the coordinator repeated some sheet findings as new cross-sheet findings. The
coordinator prompt now asks it to update the existing finding by ID; in the Brewery run it updated
one finding that way. Duplicates were not counted systematically.

## Limits

These are single runs, not repeated measurements. Settled counts include Not applicable with a
reason; 27 Brewery checks remain Needs input. The findings were not checked against the drawings
for accuracy beyond the examples above.
