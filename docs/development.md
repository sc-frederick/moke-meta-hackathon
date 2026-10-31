# Development and testing

Use the exact Bun version in `../.bun-version`. Install with
`bun install --frozen-lockfile`; the postinstall step patches the compiler used
by `svelte-check --tsgo` for Effect diagnostics.

## Commands

| Command                    | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `bun run dev`              | Build Electron, the PDF worker and assets; run Vite and Bun from source  |
| `bun run check`            | TypeScript and Svelte/Effect diagnostics, lint, and formatting           |
| `bun run format`           | Apply Bun formatting                                                     |
| `bun run test`             | Run application smoke tests                                              |
| `bun run build`            | Build the static UI, Electron shell, Bun backend, PDF worker, and assets |
| `bun run test:e2e`         | Drive the built Electron app through Playwright                          |
| `bun run verify`           | Run checks, smoke tests, builds, and Electron flows                      |
| `bun run package:desktop`  | Build installers without publishing                                      |
| `bun run test:packaged`    | Run the desktop flows against exactly one packaged executable            |
| `bun run test:screenshots` | Refresh the screenshots linked from the README                           |

Local Electron tests run only on Linux, through `scripts/isolated-desktop.ts`.
It never uses an existing desktop. It needs unprivileged user namespaces for
`unshare --user --map-root-user --mount --net --ipc --pid`, plus `mount`, `ip`,
`Xvfb` and `xdpyinfo`. Inside private user, mount, network, PID and IPC
namespaces it starts its own Xvfb on `:99`, strips inherited display, D-Bus and
audio variables, and refuses to run while the desktop display `:0` is reachable.
Set `MOKE_XVFB_BINARY` when `Xvfb` is not on `PATH`. Setting `DISPLAY` or wrapping
the command in `xvfb-run` has no effect: the runner discards inherited display
variables, and the Playwright fixtures refuse runs that bypass it. The fixed
display's lock is `/tmp/.X99-lock`, so run one desktop suite per host at a time.
On macOS or Windows the command fails before Electron starts. Native desktop sessions are used only on disposable
GitHub-hosted runners (`GITHUB_ACTIONS=true` and
`RUNNER_ENVIRONMENT=github-hosted`). CI checks and packages all three platforms.

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
Vendored lint tests are outside Bun's application test root. After changing a
local rule customization, run `bun run test:lint-rule-cli`. It drives the
repository's Oxlint through Bun with the spacing rule: bad input fails, `--fix`
writes the expected files, and a second pass is stable. The other vendored rule
tests use the upstream runner and are not part of this repository's commands.

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
```

The screenshot run uses the same private Linux display runner as `test:e2e`.

The Electron flow creates its own two-sheet PDFs and browser profile in a
temporary data directory.
It captures the real workbench at 1440 × 1000, a corrected finding, and a
revision recheck. Screenshots go to `docs/screenshots/`.
No model inspection starts. The test refuses screenshot mode with live inference
enabled, checks renderer errors, and removes its temporary project after closing.

The captures include the [workbench](screenshots/workbench.png),
[correction history](screenshots/correction.png), and
[revision history](screenshots/revision.png).

Inspect the generated PNGs before committing them. Keep historical live-validation
screenshots under `docs/research/screenshots/` with the original evidence notes.

## Design and experiments

The workbench uses the Forge design system described in
[the design notes](../design/DESIGN.md). Run `project-kit design forge .` to
restore its licensed reference under the ignored `design/reference/` directory.
Reference source stays outside application distributions.

SAM and adaptive-review commands are separate research tools. Their recipes and
captured results live under `experiments/`; generated runs and private PDFs are
ignored. See [the experiment documentation](README.md#drawing-experiments).
