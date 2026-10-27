# moke-meta-hackathon

Generated with project-kit: pnpm, Vite+, SvelteKit 3, Effect 4, Effect SQL,
Effect RPC, native TypeScript 7 checking, and vendored anti-slop rules.

## Development

```sh
pnpm install
pnpm effect:setup
pnpm dev
```

The desktop UI is packaged inside Electron. The web UI uses Alchemy's SvelteKit
Worker integration with a stage-isolated D1 database. Check docs/deployment.md
for the applicable environment and credential setup.

## Verification

```sh
pnpm exec playwright install chromium
pnpm verify
project-kit doctor .
```

Tests include real SQLite persistence and one UI/RPC/database smoke flow. The
web smoke flow uses local Miniflare D1 and needs no Cloudflare credentials.
Desktop smoke tests launch Electron and need a graphical session or Xvfb on Linux.
TypeScript 6 supplies APIs used by Svelte tooling; TypeScript 7 performs native
checking. Vite+ runs format, lint, and native checks; svelte-check --tsgo covers
Svelte components. Re-run pnpm effect:setup after dependency installation to
restore Effect diagnostics in the native compiler.

## Project choices

Choose authentication before deployment. The default is undecided. Authenticated
apps must implement and pass test:auth before deployment. Apps intentionally
without login record authentication as none in .project-kit/manifest.json.

Choose visual design later from the private Uiverse archive with project-kit
designs and project-kit design <slug> . . Adapt the selected reference into the
Svelte UI, keeping its source assets and license out of public template releases.

## Maintenance

```sh
project-kit update .
git apply --stat .project-kit/update.patch
project-kit update . --apply
pnpm install
pnpm effect:setup
pnpm verify
```

Updates use the original scaffold as the three-way merge base. Local edits are
preserved and conflicts stop application. Review the diff and commit it. If the
Effect dependency changed, run project-kit references after committing, then
commit the updated subtree provenance. Never edit applied database migrations.
