/**
 * Gate 0B probe: render from an installed-layout directory without developer node_modules.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { buildMinimalPdf } from "../tests/fixtures/generated/minimal-pdf.ts";

const root = resolve(import.meta.dir, "..");
const assetsRoot = join(root, "dist/backend/pdf-assets");

const layout = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ nativeFile: Schema.String })),
)(readFileSync(join(assetsRoot, "layout.json"), "utf8"));

const layoutDir = mkdtempSync(join(tmpdir(), "moke-pdf-packaged-"));

mkdirSync(join(layoutDir, "native"), { recursive: true });

mkdirSync(join(layoutDir, "pdfjs"), { recursive: true });

cpSync(join(assetsRoot, "pdfjs"), join(layoutDir, "pdfjs"), { recursive: true });

cpSync(join(assetsRoot, "native", layout.nativeFile), join(layoutDir, "native", layout.nativeFile));

const probeBinary = join(root, "dist/backend/pdf-packaging-probe");
const pdfFixture = process.argv[2] ?? join(layoutDir, "original.pdf");

if (process.argv[2] === undefined) writeFileSync(pdfFixture, buildMinimalPdf());

const outDir = join(layoutDir, "out");

mkdirSync(outDir, { recursive: true });

const started = performance.now();

const child = Bun.spawn({
  cmd: [probeBinary, pdfFixture, outDir],
  env: {
    ...process.env,
    MOKE_PDFJS_ASSETS: join(layoutDir, "pdfjs"),
    NAPI_RS_NATIVE_LIBRARY_PATH: join(layoutDir, "native", layout.nativeFile),
  },
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

const overviewPath = join(outDir, "overview.png");

const result = {
  layoutDir,
  probeBinary,
  exitCode,
  stdout: stdout.trim(),
  stderr: stderr.trim(),
  overviewBytes: Bun.file(overviewPath).size,
  elapsedMs: Math.round(performance.now() - started),
  platform: process.platform,
  arch: process.arch,
};

writeFileSync(
  join(root, "docs/research/pdf-packaging-probe-result.json"),
  JSON.stringify(result, null, 2),
);

console.log(JSON.stringify(result, null, 2));

if (exitCode !== 0 || result.overviewBytes <= 0) {
  process.exit(exitCode ?? 1);
}

rmSync(layoutDir, { recursive: true, force: true });
