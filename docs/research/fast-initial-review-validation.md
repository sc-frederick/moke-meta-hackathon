# Fast initial review: live validation

Measured 2026-10-30 on branch `feat/fast-initial-review`, against the plan in
[fast-initial-review.md](fast-initial-review.md). Every run used Muse Spark 1.3 at
`xhigh` reasoning with Meta web search, started from the **Initial Review** button
(`initial-review-v1`) in a fresh workspace. Costs use Meta's list prices ($1.25 input,
$0.15 cached input, $4.25 output per million tokens); the keys were on free credits.
Cached share is `cacheRead / (input + cacheRead)` over every completed model call.

## Results

| Run                                    | Sheets | Review time | Calls | Findings | Passes recorded | Cached share |   Cost |
| -------------------------------------- | -----: | ----------- | ----: | -------: | --------------- | -----------: | -----: |
| Brewery, Windows app, on this computer |     29 | 14.3 min    |   519 |       86 | 1,276 / 1,276   |        91.2% | $11.47 |
| Brewery, cloud                         |     29 | 15.4 min¹   |   575 |       90 | 1,246 / 1,276   |        94.9% | $10.42 |
| Civil, Windows app, on this computer   |      5 | 6.2 min     |   100 |       26 | 220 / 220       |        94.1% |  $1.76 |
| Civil, cloud                           |      5 | 7.3 min¹    |   105 |       24 | 220 / 220       |        94.4% |  $1.92 |

¹ Click to results ready in the cloud. Civil synced back 18 s later. Four of the 29
Brewery sheet reviewers stopped on HTTP 502 (see Limits), so that review ended as
uncertain with their gaps recorded.

The earlier parallel Brewery run took 43.4 minutes for 941 calls and $16.55
([parallel-sheet-review.md](parallel-sheet-review.md)). Without caching, the local
Brewery run's prompt tokens would have cost $47.47 instead of $11.47. Every run cleared
the 90% cached-share target. Per sheet reviewer on the local Brewery run, the share
ranged from 74.5% to 95.6% (median 87.2%); the long coordinator conversation lifts the
review total. The review card shows the share ("519 provider calls · 91% of prompt
tokens cached"), and **Copy review diagnostics** reports it per sheet.

## Where cloud time goes (Brewery)

| Stage                               | Before (Audit 3)               | Now                                          |
| ----------------------------------- | ------------------------------ | -------------------------------------------- |
| Source sync                         | at Send                        | 13 files, 22.5 MB, cached ~16 s after import |
| Click to dispatch                   | ~5 min (506 MiB at 1.8 MiB/s)  | 5 s; 262 KB uploaded, 13 files reused        |
| First findings on the cloud card    | at the end                     | 3.6 min after the click (Civil: 1.8 min)     |
| Review                              | 43.4 min                       | 15.4 min                                     |
| Result download (380 MB, 435 files) | 5 min 34 s, one file at a time | 60.3 s, eight at a time²                     |

² Re-downloaded from the same result snapshot with local reuse disabled, so every
byte crossed the network. The live run predates the parallel download.

Most of the result is the sheet reviewers' journals and the crops they rendered, which
are new in each review. Source files and earlier renders come from the local workspace.

## Meta Files API

The local Brewery run uploaded 383 delivered images (98.7 MiB) to Meta's Files API,
each once, with a 24-hour expiry, and sent `file_id` references afterwards. Requests no
longer resend every retained image as base64 on each turn.

## Fixed during validation

- **Meta `model_not_found`.** The first cloud Brewery review stopped on its first
  request: Meta answered HTTP 404 `model_not_found` for Muse Spark 1.3. Probes showed it
  happens intermittently for the key stored in the Modal secret (2 of 12 requests through
  Modal, 1 of 8 locally) whatever the request fields; the desktop's key returned 0 of 8.
  Nothing is generated, so the adapter now resends it like a 429, reading at most 16 KiB
  of the error body.
- **Result download.** Downloading one file at a time took 5.6 minutes; see above.
- **Initial Review placement.** The button now checks cloud setup when it appears,
  re-checks before it starts, and shows where the review runs.

## Limits

- **HTTP 502 stops a sheet reviewer.** In the cloud Brewery run, four sheet reviewers
  each received HTTP 502 within about 50 ms (4 of 575 calls). A 502 is not treated as a
  refusal before generation, so it is not resent; those sheets kept their gaps. The
  local runs saw none.
- **Windows cloud reviews on this machine.** Cloudflare WARP's resolver times out on
  Modal's worker hosts (`*.w.modal.host`), so every file and exec call from the Windows
  app fails before a review starts; WSL resolves them. The cloud runs therefore ran the
  Linux desktop app through WSLg on the same machine and uplink.
- **Cloud check after launch.** Two cloud attempts showed "on this computer" because
  the quiet cloud check failed at that moment; the next attempt passed in about 3 s.
  Switching **Execution location** to Cloud re-checks.
- Single runs, not repeated measurements. Findings were not reviewed for accuracy.

## Evidence

Full-screen recordings (2560×1600) and screenshots are kept outside the repository in
`Downloads/Moke-fast-review-2026-10-30` on the test machine: `02` Brewery on Windows,
`04` Brewery in the cloud, `05` Civil on Windows, `08` Civil in the cloud. Run timelines
and samples are in the ignored `.local/fast-review/`.
