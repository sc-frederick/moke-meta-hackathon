# Development and testing

Use the exact Bun version in `../.bun-version`. Install with
`bun install --frozen-lockfile`; the postinstall step patches the compiler used
by `svelte-check --tsgo` for Effect diagnostics.

## Commands

| Command                    | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `bun run dev`              | Build the Electron/Bun entrypoints and launch the app with Vite           |
| `bun run check`            | TypeScript, Svelte/Effect diagnostics, design study, lint, and formatting |
| `bun run format`           | Apply Bun formatting                                                      |
| `bun run test`             | Run application smoke tests                                               |
| `bun run build`            | Build the static UI, Electron shell, Bun backend, PDF worker, and assets  |
| `bun run test:e2e`         | Drive the built Electron app through Playwright                           |
| `bun run verify`           | Run checks, smoke tests, builds, and Electron flows                       |
| `bun run package:desktop`  | Build installers without publishing                                       |
| `bun run test:packaged`    | Run the desktop flows against exactly one packaged executable             |
| `bun run test:screenshots` | Refresh the screenshots linked from the README                            |

Linux Electron tests require an X display. Use `DISPLAY=:0` with an existing
desktop or `xvfb-run -a` on a headless host. Windows and macOS use their native
desktop sessions. CI checks and packages all three platforms.

The toolchain uses Bun for installs, scripts, formatting, tests, and builds.
SvelteKit 3 runs Vite on Bun. Oxlint retains the vendored rules in
`tools/oxlint/anti-slop`; they and the Effect references under `repos/` are not
application source. Preserve their licenses and provenance when updating them.

## Test policy

Prefer end-to-end flows and smoke tests of observable behavior. Exercise real
application entrypoints and local resources. Do not export implementation helpers
just to test them, assert private call sequences, or repeat dependency conformance
tests. Keep regression coverage for data loss, process authorization, paid-request
deduplication, and recovery.

| Suite                                                                                                                         | What it proves                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/review.spec.ts`                                                                                                    | PDF import, accepted counts, a corrected false alarm, independent control, revisions, source images, package export, and reopen persistence in Electron |
| `tests/e2e/reconciliation.spec.ts`                                                                                            | Offline worksheet corrections, completion, export, persistence, and revision isolation                                                                  |
| `tests/smoke/backend.test.ts`, `review.test.ts`                                                                               | Real Bun process, authenticated RPC, origins, shutdown/crashes, evidence, corrections, and revisions                                                    |
| `tests/smoke/documents.test.ts`                                                                                               | Original-PDF pixels, rotations, page boxes, hashes, bounds, chunks, and worker cancellation                                                             |
| `tests/smoke/review-execution.test.ts`, `review-conversation.test.ts`, `review-fences.test.ts`, `review-segmentation.test.ts` | Real Pi/SDK/SQLite execution with controlled provider transport, saved conversation replies, source/version fences, budgets, and crash recovery         |
| `tests/smoke/database-files.test.ts`, `review-packages.test.ts`, `package-files.test.ts`, `credential-files.test.ts`          | Real file/database backups, rejected restores, interrupted replacement, file identity, and private credential files                                     |
| Remaining `tests/smoke/` suites                                                                                               | Experiment workflows, local HTTP provider adapters, CLI artifacts, and tracked recipe preflight                                                         |

Normal tests require no provider keys or private drawing pack. Provider adapters
use local HTTP endpoints or injected transports. Poppler-dependent experiments
skip when `pdftoppm` is unavailable; production PDF-worker tests still run.
Vendored lint tests are outside Bun's application test root.

Run one smoke suite with `bun test ./tests/smoke/review.test.ts`. Electron tests
need `bun run build` first. The Playwright `desktop` project runs the regular
suite; the `screenshots` project repeats the review flow and writes documentation
images. The packaged command requires exactly one application under `release/`,
so remove obsolete build output before repackaging.

Live checks are opt-in and may spend API credits. See [inference setup](inference.md)
and the [recorded validation](research/core-validation.md). A passing offline
suite establishes application behavior with controlled responses, not current
provider availability or model accuracy.

## Screenshot refresh

```sh
bun run build
bun run test:screenshots
# Headless Linux: xvfb-run -a bun run test:screenshots
```

The Electron flow creates its own two-sheet PDFs and browser profile in a
temporary data directory.
It captures the real workbench at 1440 × 1000 in dark and light appearances,
a corrected finding, and a revision recheck. Screenshots go to `docs/screenshots/`.
No model inspection starts. The test refuses screenshot mode with live inference
enabled, checks renderer errors, and removes its temporary project after closing.

The captures include the [dark workbench](screenshots/workbench.png),
[light workbench](screenshots/workbench-light.png), [correction history](screenshots/correction.png),
and [revision history](screenshots/revision.png).

Inspect the generated PNGs before committing them. Keep historical live-validation
screenshots under `docs/research/screenshots/` with the original evidence notes.

## Design study and experiments

The selected Nightdesk study is retained for design provenance. Rebuild its
standalone HTML with `bun run build:concepts` and check it with
`bun run check:concepts`. Reference source stays under the ignored
`design/reference/` directory and outside application distributions.

SAM and adaptive-review commands are separate research tools. Their recipes and
captured results live under `experiments/`; generated runs and private PDFs are
ignored. See [the experiment documentation](README.md#drawing-experiments).
