# moke-meta-hackathon

Electron desktop shell with a bundled Bun backend, SvelteKit 3, Effect 4,
Effect SQL, and shared schema-validated Effect RPC contracts.

## Development

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

Choose visual design from the private Uiverse archive with `project-kit designs`
and `project-kit design <slug> .`. Keep reference source assets and licenses out
of public distributions.

## Maintenance

The project-kit baseline originally used pnpm and Vite+. Review generated updates
before applying them so they preserve this project's Bun toolchain and backend
boundary. Effect reference source and vendored lint rules remain read-only.
Never edit applied database migrations.
