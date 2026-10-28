# Beta validation

Validated October 28, 2026 against the integrated beta branch. The live run used
`a628508ae`; UI corrections were verified on `7b4c429e7`. The application scope is
selected drawn-to-schedule count coordination, as described in the
[implementation record](beta-implementation.md).

## Automated proof

- `DISPLAY=:0 bun run verify`: 176 tests, 1,205 assertions, type and Svelte checks,
  lint, formatting, all builds, and both Electron flows passed.
- `bun run build:concepts` passed.
- `bun --bun electron-builder --publish never --linux dir` and
  `DISPLAY=:0 bun run test:packaged` passed, including both packaged desktop flows.
- All fourteen embedded prompt assets matched their recorded SHA-256 hashes.
- The Svelte autofixer reported no issues. The design detector reported no findings.

Astra removed unused notes scaffolding, dead exports and wrappers, a redundant
rotation test, and twenty-five upstream SDK conformance cases. The cleanup alone
removed 356 net lines. Application-owned SQLite facade tests, original-PDF pixel
and transform tests, real Pi execution, RPC, interruption, and recovery tests remain.
All twenty-one original lint warnings were eliminated. Immutable migrations and
legacy notes data were preserved.

Bun 1.4.4 was already the current stable release. The app keeps that exact pin,
Bun's formatter and checker, `svelte-check --tsgo`, and Effect SQL. Backend cleanup
uses native hashing, HTML escaping, and bounded file reads where appropriate;
Electron retains its Node runtime boundary.

## Live desktop proof

GPT-6.1 Terra with xhigh reasoning and priority service drove the packaged app
through Electron Playwright on display `:0`, using isolated authored PDF fixtures.
The requested CUA driver was unavailable. This is Electron interaction and
screenshot evidence, not CUA verification.

A custom Electrical request sent through the composer completed in seven Meta
Muse calls and zero SAM calls, within the twelve-call limit. It proposed two
drawn Type A luminaires against three scheduled in Room 101. The reply returned
to the requesting conversation. Proposals retained the prompt version, skills
revision, source version, run, and reviewer-message identity, and stayed proposed
until the reviewer explicitly accepted them.

Terra verified the supported mismatch, false alarm and correction, unchanged
independent control, project/conversation switching with drafts, source-panel
Escape behavior, complete-package export, and reopen persistence. No renderer
errors were recorded. The focused recheck also monitored main-process stderr,
which contained only Electron debugger shutdown text.

Terra found two defects, both corrected and rechecked:

| Finding                                      | Correction and observed result                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call-limit selector blank                    | Number-valued Svelte binding displays and retains 4, 8, and 12 across settings close/reopen. A configured parent run also verified matching composer text for every choice.                  |
| Accepted proposals still awaiting acceptance | Pending proposals exclude versions already superseded by accepted inputs. Room 101 retains its supported issue, accepted counts, evaluation history, and both original proposals in storage. |

The final configured check made no new inference calls: before and after it,
the isolated database held one run, seven model attempts, and zero SAM attempts.
Temporary session credentials were private, excluded from artifacts, and removed
after testing. Test applications were closed.

The parent inspected dark and light captures at 1440×900 and 1100×733, plus the
findings interaction at 390×844. Source images were loaded before final capture.
The [desktop capture](screenshots/beta-workbench.png) and
[narrow findings capture](screenshots/beta-mobile-findings.png) use authored
synthetic project data.

## Limits

Governing-code verification, a complete permit review/report, and Modal handoff
remain outside this beta. Baseten crop acceptance remains unverified. Actual
image-token usage and cost remain unknown. Platform CI and council review are
recorded in the pull request before merge.
