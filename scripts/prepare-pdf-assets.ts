/**
 * Stage pdfjs-dist assets and the platform @napi-rs/canvas native library beside the backend build.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the optional native package for the current OS and CPU. */
export function canvasNativePackage(platform = process.platform, arch = process.arch): string {
  if (platform === "linux" && arch === "x64") return "@napi-rs/canvas-linux-x64-gnu";

  if (platform === "linux" && arch === "arm64") return "@napi-rs/canvas-linux-arm64-gnu";

  if (platform === "darwin" && arch === "arm64") return "@napi-rs/canvas-darwin-arm64";

  if (platform === "darwin" && arch === "x64") return "@napi-rs/canvas-darwin-x64";

  if (platform === "win32" && arch === "x64") return "@napi-rs/canvas-win32-x64-msvc";

  if (platform === "win32" && arch === "arm64") return "@napi-rs/canvas-win32-arm64-msvc";
  throw new Error(`Unsupported platform for @napi-rs/canvas: ${platform}-${arch}`);
}

/** Filename written under `native/` for the selected platform binary. */
export function canvasNativeFileName(platform = process.platform, arch = process.arch): string {
  const pkg = canvasNativePackage(platform, arch).replace("@napi-rs/canvas-", "");

  return `skia.${pkg}.node`;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * PDF.js files the PDF worker loads at runtime, relative to the package root. The main module
 * is compiled into the worker executable. CMaps, standard fonts and WASM image decoders keep
 * their license files; source maps, minified duplicates and the web viewer are not staged.
 */
export const pdfjsRuntimeAssets = [
  "legacy/build/pdf.worker.mjs",
  "cmaps",
  "standard_fonts",
  "wasm",
] as const;

/** Copy the PDF.js runtime allowlist and native canvas binaries into `dist/backend/pdf-assets`. */
export function preparePdfAssets(outputRoot = join(root, "dist/backend/pdf-assets")) {
  const pdfjsSource = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const nativePackage = canvasNativePackage();

  const nativeSourceDir = dirname(
    fileURLToPath(import.meta.resolve(`${nativePackage}/package.json`)),
  );

  const nativeBasename = nativePackage.replace("@napi-rs/canvas-", "");
  const nativeFile = readFileSync(join(nativeSourceDir, `skia.${nativeBasename}.node`));

  mkdirSync(join(outputRoot, "native"), { recursive: true });
  // Replace the whole tree so files from an earlier, broader staging cannot ship.
  rmSync(join(outputRoot, "pdfjs"), { recursive: true, force: true });
  mkdirSync(join(outputRoot, "pdfjs"), { recursive: true });
  const canvasSource = join(root, "node_modules/@napi-rs/canvas");
  const canvasModule = join(outputRoot, "modules/@napi-rs/canvas");
  mkdirSync(canvasModule, { recursive: true });

  // PDF.js calls createRequire at runtime for its globals and auxiliary canvases.
  for (const file of [
    "index.js",
    "js-binding.js",
    "geometry.js",
    "load-image.js",
    "node-canvas.js",
    "package.json",
  ]) {
    cpSync(join(canvasSource, file), join(canvasModule, file));
  }

  if (existsSync(join(nativeSourceDir, "icudtl.dat"))) {
    cpSync(join(nativeSourceDir, "icudtl.dat"), join(outputRoot, "native/icudtl.dat"));
  }

  for (const asset of pdfjsRuntimeAssets) {
    cpSync(join(pdfjsSource, asset), join(outputRoot, "pdfjs", asset), { recursive: true });
  }

  const nativeName = canvasNativeFileName();
  writeFileSync(join(outputRoot, "native", nativeName), nativeFile);

  const licenses = {
    pdfjs: readFileSync(join(pdfjsSource, "LICENSE"), "utf8"),
    canvas: readFileSync(join(root, "node_modules/@napi-rs/canvas/LICENSE"), "utf8"),
  };

  writeFileSync(join(outputRoot, "licenses.json"), JSON.stringify(licenses, null, 2));
  writeFileSync(
    join(outputRoot, "layout.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nativePackage,
        nativeFile: nativeName,
        pdfjsRoot: "pdfjs",
      },
      null,
      2,
    ),
  );

  return outputRoot;
}

if (import.meta.main) {
  console.log("Prepared PDF assets at", preparePdfAssets());
}
