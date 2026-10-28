# Moke

Moke is a desktop workbench for reviewing engineering drawings, built for the
Meta AI Developer Hackathon. Import a PDF, inspect a finding against its source,
and correct the evidence when a model misreads it. When a drawing changes, recheck
the affected findings while keeping the earlier results.

![Moke's desktop workbench with source evidence, accepted counts, and findings navigation](docs/screenshots/workbench.png)

## The review workflow

1. **Import and confirm sheets.** Original PDFs stay in the local project. Confirm
   sheet identities before using them as evidence.
2. **Choose a coordination check.** Select the drawn and scheduled sources, the
   object type and scope, and the discipline. Ask Moke to inspect that check with
   an explicit model-call limit.
3. **Inspect the evidence.** Meta Muse can request detailed crops from the original
   PDF. SAM can propose object boundaries. Every observation remains a proposal
   until the reviewer accepts it.
4. **Accept or correct counts.** Compare reviewer-accepted quantities with
   `schedule-count-v1`. Missing evidence leaves the check unresolved. Corrections
   retain the original finding and its calculation history.
5. **Recheck a revision.** Associate replacement sheets, confirm what changed,
   and review fresh evidence. Unrelated results retain their history.

![A revised drawing resolves the original count mismatch while retaining earlier checks](docs/screenshots/revision.png)

The current beta supports drawn-to-schedule quantity coordination. It does not
verify governing codes or produce a complete permit review. Model proposals and
SAM masks do not establish engineering completeness or physical dimensions.
The [two-sheet demonstration](docs/fixtures/hero-case.md) includes a supported
issue, a corrected false alarm, an unchanged control, and a revision recheck.

## How it works

| Process            | Owns                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| SvelteKit renderer | Projects, conversations, findings, and source inspection                                       |
| Electron           | Windows, menus, file dialogs, protected credentials, and the trusted renderer bridge           |
| Bun backend        | Effect application services, SQLite, PDF workers, evidence, calculations, and review execution |

Effect Schema contracts validate process messages. The renderer uses Effect RPC
over authorized Electron MessagePorts; Electron forwards application requests to
Bun over authenticated loopback HTTP. Database access and provider credentials
stay outside the renderer.

Pi Durable journals review execution. A separate pre-send ledger records model
requests, so interrupted requests with unknown outcomes require acknowledgement
before a new run. Reviews have bounded budgets and pause/cancel controls.
Complete packages export and restore databases, original PDFs, rendered evidence,
and execution journals together.

Projects run locally, but inference uses hosted Meta or Baseten APIs and sends
selected drawing evidence to the provider. Modal checkpoint handoff remains
planned. See [the runtime decision](docs/review-runtime.md) and
[data and recovery](docs/data.md).

## Development

Install the Bun version pinned in [.bun-version](.bun-version), then run:

```sh
bun install --frozen-lockfile
bun run dev
```

You can import drawings, accept counts, and evaluate checks without provider keys.
For model inspections, copy [.env.example](.env.example) to `.env` and set
`MODEL_API_KEY`. Set `MOKE_PROVIDER=baseten` and `BASETEN_API_KEY` to use Baseten.
Restart the app after changing configuration. See [inference setup](docs/inference.md)
for credentials and the limits of each route.

Bun runs tools and the application backend. The packaged app includes the Bun
executable, PDF renderer, and native assets; users do not install Bun or Node.
Build installers with `bun run package:desktop`. See [desktop builds and releases](docs/deployment.md).

## Verification

```sh
bun run verify          # checks, smoke tests, builds, and Electron end-to-end tests
bun run test:packaged   # after packaging, repeat the desktop flow against the packaged executable
bun run test:screenshots
```

Tests use real local databases, RPC, PDF workers, and Electron. Hosted-provider
boundaries use local transports; normal verification requires no keys and makes
no paid requests. Headless Linux needs an X display, for example
`xvfb-run -a bun run verify`. Install Poppler for the optional experiment smoke
tests; they skip explicitly when `pdftoppm` is unavailable.

Screenshots come from the same Electron workflow using authored synthetic PDFs,
without inference. [Development and testing](docs/development.md) explains the
suite layout, screenshot refresh, and toolchain.

## Repository layout

```text
src/          SvelteKit workbench and shared Effect Schema/RPC contracts
desktop/     Electron shell, preload, and backend connection
backend/      Application services, PDF workers, inference, and review storage
migrations/   Immutable SQLite migrations
tests/       Smoke tests, Electron end-to-end flows, and synthetic fixtures
scripts/      Development, build, packaged checks, and opt-in model experiments
docs/        Setup, architecture, screenshots, and validation evidence
design/       Selected Nightdesk design provenance and the original UI study
experiments/  SAM recipes, captured proposals, and research evidence
```

The [documentation index](docs/README.md) separates setup and architecture from
hackathon research and drawing experiments. The original [UI study](design/concepts/DESIGN.md)
records the Nightdesk reference and third-party asset attribution.

## Hackathon provenance

The Moke name and review prompts predate this entry. This repository implements
a fresh application from the project-kit desktop starter, with drawing evidence,
corrections, and revision tracking built for the hackathon. It does not reuse the
earlier Moke application. Prompt and dependency provenance live in
[the project manifest](.project-kit/manifest.json) and
[the review prompt sources](backend/review/prompts/README.md).
