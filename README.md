# Moke

A desktop workbench for engineering drawing review, built for the Meta AI
Developer Hackathon.

Moke is being built to help engineers inspect drawing-review findings, correct
the evidence behind them, and recheck the affected conclusions when a drawing
changes. Each finding should lead back to the source sheet, the observations,
and the calculation that supports it.

## The review workflow

The planned workflow keeps the engineer involved at each step:

1. **Review a drawing set.** Keep the original PDFs in a local project and select
   the sheets and engineering check to review.
2. **Take a closer look.** Meta Muse identifies missing evidence and requests
   detailed crops rendered from the original PDF. SAM proposes object boundaries
   where segmentation helps.
3. **Inspect a finding.** Follow it to the source region, accepted facts, and
   explicit check inputs. Missing or unreadable evidence leaves a check unresolved.
4. **Correct the interpretation.** Update an accepted fact and recompute the
   dependent checks, including withdrawing a false alarm when warranted.
5. **Recheck a revision.** Mark affected results as stale, inspect the new
   evidence, and retain the history and unrelated results.

The initial target is one engineering rule applied to a small drawing set:
a supported issue, a corrected false alarm, and a revision recheck. The rule
and SAM's contribution will be selected through experiments on representative
drawings. Engineering applicability, measurements, and conclusions remain
subject to reviewer verification.

## Current status

**Early development.** The desktop foundation and an interactive UI study are
in place. The drawing-review workflow above is not implemented yet.

- **Working foundation:** Electron desktop shell, bundled Bun backend, local
  SQLite with backup and restore, schema-validated Effect RPC, and desktop tests.
- **UI study:** project-based conversations, a findings menu, and a source panel
  using sample content. The running app still opens the notes smoke example.
- **CLI experiments:** original-PDF crops, coordinate mapping, Muse/SAM inspection
  tools, fixture reconciliation, and saved evidence with correction reports.
- **Planned:** desktop integration of those tools, engineering checks and revision
  rechecks, durable review execution, and cloud handoff.

Provider configuration and manual API checks are available. The app itself does
not call Meta or Baseten yet.

## Review architecture

The selected architecture keeps projects and review execution local by default,
with an explicit **Continue in cloud** action planned for long reviews:

| Part                       | Responsibility                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Electron and SvelteKit     | Desktop workbench, project navigation, findings, and source inspection                          |
| Bun and Effect             | Application services, shared contracts, SQLite, evidence, calculations, and dependency tracking |
| Pi Durable, planned        | Persist the agent's execution state behind an Effect application service                        |
| Meta Muse and SAM, planned | Choose useful inspection actions, interpret drawing evidence, and propose geometry              |
| Modal Sandbox, planned     | Continue the same versioned review engine from a checkpoint after an explicit handoff           |

Local execution still uses hosted inference: selected drawing evidence is sent
to Meta or Baseten. The planned cloud handoff also transfers the source material
needed to continue the review. Neither path implies fully offline inference.

See the [review runtime decision](docs/review-runtime.md) for ownership, recovery,
and handoff requirements, and the [docs index](docs/README.md) for the supporting
design and setup notes.

## Development

Add the Meta and Baseten hackathon keys to the root `.env` file. For a fresh
checkout, copy `.env.example` to `.env` first. See [Inference setup](docs/inference.md)
for the key names and [Model reference](docs/models.md) for the full Meta catalog
and Baseten's required hackathon model ID. The [docs index](docs/README.md) links
the rest of the project documentation.

Install the Bun version in `.bun-version`, then run:

```sh
bun install
bun run dev
```

Bun runs the development tools and the application backend. Electron owns the
windows, menus, dialogs, and trusted renderer bridge. Its embedded Node runtime
forwards typed application requests to Bun. The renderer has no database or Bun
access. The packaged app includes a standalone Bun executable; users do not
install Bun or Node.

## Desktop UI study

Open [the interactive study](design/concepts/index.html) directly in a browser.
It previews the approved project-based chat navigation, findings menu, and source
panel using sample content. The current app entry remains the notes smoke example.
See [the design notes](design/concepts/DESIGN.md) for the interaction and reference.
Screenshots show the [findings menu](design/concepts/preview.png) and
[source panel](design/concepts/preview-source.png).

```sh
bun run build:concepts
bun run check:concepts
```

The study is self-contained. Its Svelte source is checked by `bun run check`, and
CI rebuilds the standalone HTML on all supported desktop platforms.

## Check API keys

Keep `MODEL_API_KEY` and `BASETEN_API_KEY` in the root `.env`, which Git ignores.
For a fresh checkout, copy `.env.example` to `.env` and fill in the keys. From the
repository root, run:

```sh
bun run check:api-keys
# Or: bun scripts/check-api-keys.ts
```

Bun loads `.env` automatically. The script sends one small text generation to
Meta and one to Baseten using the configured base URLs and text models. Each
request has a 30-second timeout and may consume API credits. It prints a result
for each provider without printing keys or response bodies, then exits with code
1 if either check fails. Image, audio, and segmentation models are not tested.

The requests follow [Meta's Chat Completions API](https://dev.meta.ai/docs/protocols/chat-completions)
and [Baseten's Model APIs](https://docs.baseten.co/inference/model-apis/overview).

## SAM drawing experiment

Run `bun run test:sam` to prepare PDF crops and requests without inference.
Run `bun run test:sam --live` to test SAM 3.1 on the local drawing fixtures.
See [SAM drawing experiment](docs/segmentation-test.md) for Poppler setup,
case selection, saved evidence, and coordinate conventions.

The [adaptive Meta review](docs/adaptive-meta-review.md) uses Muse tool calls to
compare independent electrical inventories, request PDF zooms and apply fresh
SAM guidance. Prepare it with `bun run test:review-agent`; add `--live` for the
bounded model experiment. See [the broader drawing study](docs/sam-drawing-expansion.md)
for lighting, receptacles, HVAC, doors and observed failure cases.

The [additional-set study](docs/sam-expanded-sets.md) tests the expanded D–J pack
across electrical, fire alarm, structural and civil workflows. Recipes are in
`experiments/sam/expanded/`; the supplied PDFs remain under
`Moke-Hackathon-Drawings/expanded/`.

## Toolchain

| Task                       | Tool                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| Packages and scripts       | Bun, with `bun.lock` and a frozen install in CI                                  |
| Type checking              | Native `bun check`, plus `svelte-check --tsgo` for Svelte and Effect diagnostics |
| Formatting                 | Native `bun fmt`                                                                 |
| Linting                    | Oxlint running on Bun, with the existing generic and Effect rules                |
| Tests                      | `bun:test` plus Playwright's real Electron smoke test                            |
| Desktop and backend builds | Native `bun build`, with a compiled backend executable                           |
| SvelteKit frontend build   | Vite running on Bun                                                              |
| Installers                 | Electron Builder running on Bun                                                  |

Bun 1.4.4's installed binary does not provide the documented native `bun lint`
command. `bun run lint` uses Oxlint and preserves all local rule customizations.
`bun install` runs `effect:setup` automatically to patch the compiler used by
`svelte-check --tsgo`. Re-run `bun run effect:setup` if that compiler is replaced.

## Verification

```sh
bun run verify
bun run package:desktop
bun run test:packaged
```

Use `xvfb-run -a bun run verify` and `xvfb-run -a bun run test:packaged` on headless
Linux. Tests cover real Bun RPC, authentication, persistence, migrations, backups,
restore failures, process shutdown, and the desktop UI across app restarts.
Packaging tests launch the installed-layout app and its compiled Bun backend.
See `docs/deployment.md` for CI and runtime details and `docs/data.md` for recovery.

## Project choices

Choose authentication before deployment. The default is undecided. The private
local backend credential is a process boundary, not end-user authentication.
Authenticated apps must implement and pass `test:auth` before deployment. Apps
intentionally without login record authentication as none in `.project-kit/manifest.json`.

The desktop UI study adapts Nightdesk from the private Uiverse archive. See the
[design notes](design/concepts/DESIGN.md) for the selected reference and license
handling. Keep reference source assets out of public distributions.

## Hackathon provenance

The Moke name and review prompts predate this entry. This repository starts a
fresh application implementation from the project-kit desktop starter; it does
not reuse the earlier Moke application. The drawing-review behavior, evidence
handling, corrections, and revision workflow are the intended new contribution.
The [runtime decision](docs/review-runtime.md) records dependency attribution
and the distinction between the underlying agent harness and Moke's work.

## Maintenance

The project-kit baseline originally used pnpm and Vite+. Review generated updates
before applying them so they preserve this project's Bun toolchain and backend
boundary. Effect reference source and vendored lint rules remain read-only.
Never edit applied database migrations.
