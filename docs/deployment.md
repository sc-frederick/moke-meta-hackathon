# Desktop releases

Development uses a loopback Vite server. Release builds package a static SvelteKit
3 application in Electron with the same schema-first Effect RPC contract, carried over MessagePorts to the Electron shell. The preload bridge exposes schema-validated review APIs and narrow shell
chooser operations. The main process authorizes the trusted top-level frame before
connecting it, then forwards calls through the same shared schemas to Bun.

GitHub CI checks and packages Windows, macOS, and Linux builds concurrently on
pull requests, pushes to main, and manual runs of the Verify desktop workflow.
All three jobs can run at once, and a failure on one platform leaves the others
running. New commits cancel superseded CI runs. Each job uploads its installers
as a `desktop-<OS>-<architecture>` artifact, available on the workflow run for seven
days. CI builds Windows NSIS installers, macOS DMG and ZIP files, and Linux
AppImage and Debian packages using each runner's native architecture. Repository
text files use LF line endings on every OS so Windows passes the same format
checks.

Releases run from version tags matching package.json. They publish unsigned
installers and SHA256SUMS to GitHub Releases after all builds succeed. Code signing and notarization are not
configured; the workflow does not require Apple or Windows developer credentials.
Unsigned applications retain the platform's normal installation prompts.

```sh
bun run package:desktop
```

Increment package.json's version, commit the release, then push its matching v tag
when ready to publish. The generator itself never creates release tags.
The initial homepage assumes `sc-frederick/<project-name>`; update package.json to
the actual project URL before release. Linux desktopName and application identity
are generated from the project name.

## Bun backend and build tools

CI installs the exact Bun version from `.bun-version` and uses `bun install
--frozen-lockfile`. Native Bun commands check types, format, run smoke tests, bundle
Electron entrypoints, and compile the backend. SvelteKit keeps its Vite integration,
running on Bun. Oxlint and Electron Builder also run on Bun; the local custom rules
and patched Svelte/Effect component checks remain enabled.

Each installer includes a native `app-backend` executable in `resources/backend`,
outside `app.asar`, a native `pdf-worker`, the matching canvas addon, PDF.js worker/fonts/CMaps/WASM
assets, licenses, and immutable SQL migrations. No system Bun or Node is
required by the packaged app. CI launches the packaged application after building
its installers on each OS, verifying the compiled backend and renderer together.

Electron starts one backend and sends its schema-validated startup configuration
over a private stdin pipe. The backend migrates the database, binds an ephemeral
port on `127.0.0.1`, and returns a versioned, schema-validated readiness message.
The HTTP hop uses framed NDJSON so progress arrives while a subscription remains
open. Effect RPC encodes and decodes every request, success, and known application
failure. A random per-launch bearer credential authorizes Electron; the backend
rejects browser-origin requests. The credential stays in the two processes and
is absent from command-line arguments, renderer capabilities, and logs.

The Bun process owns application services, SQL, migrations, backups, and recovery.
Electron owns windows, menus, dialogs, and the renderer bridge. Closing Electron's
pipe gracefully stops the backend and its scoped server. The compiled runtime's
`--no-orphans` support also terminates it if Electron dies abruptly. Startup
failures stop visibly; an unexpected backend exit prompts the user to reopen the
app. Backend code does not run in Electron's embedded Node runtime.

## Update delivery

Choose the updater and download access for each application. The user often hosts
release files on R2 and presents notices, downloads, and installation inside the
app. Evaluate aecPermitMonitor's implementation before reusing it. The baseline
does not hardcode a bucket, feed, public-download policy, or universal installer.

An updater must select the matching OS/architecture artifact, verify it before
execution, report progress and failure, preserve data, and distinguish download,
installation, and restart. Test its behavior with the actual unsigned artifacts.
Some platform updater paths require signing; use an installer handoff or manual
replacement where automatic installation is unavailable. Do not promise a uniform
silent update path across unsigned Windows, macOS, and Linux distributions.

## Data, configuration, and logs

The Bun backend owns SQLite and application filesystem access. Complete package export and restore provide review recovery. Legacy database
restore is restricted to notes-only data. Read docs/data.md before changing
that lifecycle. Never add database or filesystem capabilities directly to the UI.

Logs are JSON lines in userData/logs, one file per date. Use Effect Redacted for
secrets and avoid logging user data or credentials. Hosted monitoring is optional.
Store persistent credentials through the OS credential facility; never bundle
provider API tokens or store them in renderer localStorage.

Cloud features are optional. Add Cloudflare + Alchemy with development, staging,
and production separation when required. Authentication, sync ownership, offline
behavior, and conflict policy are chosen for the application.

macOS artifacts receive an ad-hoc signature on the runner, which requires no
Apple developer account. They have no Developer ID signature or notarization,
so Gatekeeper can still require an explicit user override. Windows artifacts
have no publisher signature.

## Provider credentials in a packaged launch

Use File > Import provider credential to encrypt a configuration with Electron
safeStorage. Linux `basic_text` storage is refused. Without secure OS storage,
set `MOKE_SESSION_CREDENTIAL_FILE` to an explicitly selected private JSON file
for that launch. On Unix it must have owner-only permissions (for example `chmod 600`).
It contains `provider`, `apiKey`, canonical `baseUrl`, and `model`.
Meta uses `https://api.meta.ai/v1` and `muse-spark-1.3`; Baseten uses
`https://inference.baseten.co/v1` and `meta-models/muse-spark-open-1026`. No fallback
is selected. Packaged builds do not auto-load `.env`. The shell sends the key
over the private backend startup pipe; renderer RPC and packages exclude it.

Set `MOKE_E2E_LIVE=1` only for the explicitly budgeted packaged acceptance test.
It adds a live inspection to the ordinary four-outcome desktop flow.
