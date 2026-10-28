# PDF packaging (gate 0B)

Primary demo target: **Linux x64**. Packages pin `pdfjs-dist@6.4.299` and `@napi-rs/canvas@1.0.13`.

## Installed layout

After `bun run prepare:pdf-assets`, the backend bundle includes:

| Path                                                  | Role                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `dist/backend/pdf-assets/pdfjs/`                      | `legacy/build/pdf.worker.mjs`, `cmaps/`, `standard_fonts/`      |
| `dist/backend/pdf-assets/native/skia.<platform>.node` | Platform `@napi-rs/canvas` binary                               |
| `dist/backend/pdf-assets/layout.json`                 | Selected native package for `process.platform` / `process.arch` |
| `dist/backend/pdf-assets/licenses.json`               | Bundled license text                                            |
| `dist/backend/pdf-worker`                             | NDJSON worker (import, bounded region render)                   |
| `dist/backend/pdf-packaging-probe`                    | Compiled overview render for packaging checks                   |

Runtime environment for workers:

- `MOKE_PDFJS_ASSETS` → pdfjs tree (no developer `node_modules`)
- `NAPI_RS_NATIVE_LIBRARY_PATH` → absolute path to the staged `.node` file

Platform selection lives in `scripts/prepare-pdf-assets.ts` (`canvasNativePackage` / `canvasNativeFileName`).

## Measured probe evidence

### Preflight scratch (`/tmp/moke-pdf-probe`, 2026-10-27)

- Dependencies: `pdfjs-dist@6.4.299`, `@napi-rs/canvas@1.0.13`
- Dev render (`render-probe.mjs`): page 1 MediaBox view `[0, 0, 612, 792]`; overview **512×372 px**, **112 KB** PNG; 300 DPI crop **2500×1667 px**, **95 KB** PNG
- Packaged asset smoke (`MOKE_PDFJS_ASSETS=/tmp/moke-packaged-layout/pdfjs`, native **37 MB** `skia.linux-x64-gnu.node`): overview **512×372**, stdout `ok 512 372`

### Worktree packaging probe (`bun run probe:pdf-packaging`)

Latest run (generated fixture `tests/fixtures/generated/original.pdf`, temp layout mirroring installed resources, **no** repo `node_modules` on `PATH` for the probe binary):

```json
{
  "exitCode": 0,
  "stdout": "ok 512 663",
  "overviewBytes": 2850,
  "elapsedMs": 130,
  "platform": "linux",
  "arch": "x64"
}
```

Full machine-readable output: `docs/research/pdf-packaging-probe-result.json`.

Compiled artifact sizes (Linux x64, Bun 1.4.4 compile):

- `dist/backend/pdf-worker` — bundled worker (~147 MB class, same order as preflight `pdf-render-bin`)
- `dist/backend/pdf-packaging-probe` — minimal overview probe (~147 MB)

Electron Builder copies `app-backend`, `pdf-worker`, and `pdf-assets` under `resources/backend/` (`electron-builder.json`).

## Application API (backend)

Exported from `backend/documents/index.ts`:

- `Documents` (`Context.Service`) with `Documents.layer(config)`
- `DocumentsConfig`: `{ dataDirectory, workerCommand, assetsDirectory, nativeLibraryPath }`
- `importPdf(source)` → `ImportedPdf`
- `render(originalSha256, sheet, region, dpi)` → `RenderedPdf`
- `read(sha256, mediaType, offset, limit)` → `{ base64, totalBytes }`
- Shared errors: `DocumentError`, `ReviewStorageError` in `#lib/review/contracts.ts` (unchanged)

Parent wiring should set `workerCommand` to the packaged `pdf-worker` binary and asset paths under the installed `resources/backend/pdf-assets` directory.

## Tests

`tests/documents.test.ts` covers import/hash storage, rotation round-trip (≤1 px), malformed PDF rejection, pixel-limit rejection (`userUnit` 2 full page @ 300 DPI), chunked read, and interruptible import (worker delay hook).
