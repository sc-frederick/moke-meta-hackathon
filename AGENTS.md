# moke-meta-hackathon

Use pnpm and Vite+. Run pnpm verify before handing back implementation changes.
Project decisions and source provenance live in .project-kit/manifest.json.

## Effect and coding standards

Read repos/effect/LLMS.md before writing Effect code. The matching source, tests,
and ai-docs are read-only references. Import from installed packages, never repos/.
If references were skipped, run project-kit references after committing changes.

Use the installed coding-standards skill. Parse external input with Effect
Schema. Keep known failures typed, use application services and Layers, and make
runtime ownership and cleanup explicit. Generic and Effect anti-slop rules are
vendored in tools/oxlint/anti-slop; preserve local customizations when updating.

## Svelte and design

Use SvelteKit 3 configuration in vite.config.ts, Svelte 5 runes, and #lib imports.
Use the Svelte coding skills and run their autofixer when editing components.

The initial notes UI is a functional smoke example. Choose visual design during
app design from any entry in sc-frederick/uiverse-templates, the user's private
backup of downloaded Uiverse design systems. Forge and Aether are recent choices.
Run project-kit designs to list the archive and project-kit design <slug> to
import the chosen reference. Preserve its DESIGN.md, assets, and license. Keep
reference source outside public distributions and adapt the selected design to
the application rather than adding a second UI system.

## Runtime boundaries

Use Effect SQL and Effect RPC. Web bindings come from the Alchemy declaration;
keep request resources scoped to the request. Desktop database access stays
outside the renderer, with RPC restricted to the app's trusted top-level frame.

Keep SQLite migrations immutable after application. Desktop migrations run after
a consistent backup and stop visibly on failure. Read docs/data.md before changing
migration or recovery behavior. Read docs/deployment.md before release changes.

Authentication and cloud capabilities are selected per application. Implement
authorization at operation boundaries. Choose desktop updater delivery and access
per project; aecPermitMonitor is a reference to evaluate for R2-hosted updates.

Scaffolding itself does not deploy resources or publish applications. Follow the
user's requested scope when moving from local implementation to external changes.
