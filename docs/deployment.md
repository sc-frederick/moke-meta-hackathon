# Desktop releases

Development uses a loopback Vite server. Release builds package a static SvelteKit
3 application in Electron with the same schema-first Effect RPC contract, carried
over MessagePorts. The preload bridge exposes only the application's RPC endpoint.
The main process authorizes the trusted top-level frame before connecting it.

GitHub CI checks and packages Windows, macOS, and Linux builds. Releases run from
version tags matching package.json. They publish unsigned installers and SHA256SUMS
to GitHub Releases after all builds succeed. Code signing and notarization are not
configured; the workflow does not require Apple or Windows developer credentials.
Unsigned applications retain the platform's normal installation prompts.

```sh
pnpm package:desktop
```

Increment package.json's version, commit the release, then push its matching v tag
when ready to publish. The generator itself never creates release tags.
The initial homepage assumes `sc-frederick/<project-name>`; update package.json to
the actual project URL before release. Linux desktopName and application identity
are generated from the project name.

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

The main process owns SQLite and filesystem access. File > Export database and
File > Restore database provide data recovery. Read docs/data.md before changing
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
