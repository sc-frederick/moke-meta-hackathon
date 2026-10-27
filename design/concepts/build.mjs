import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { compile } from "svelte/compiler";
import { build } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));

for (const file of await readdir(directory)) {
  if (!file.endsWith(".svelte")) continue;

  const filename = resolve(directory, file);
  const source = await readFile(filename, "utf8");
  const { warnings } = compile(source, { filename });

  if (warnings.length > 0) {
    for (const warning of warnings) console.error(`${file}: ${warning.message}`);

    process.exitCode = 1;
  }
}

if (process.exitCode !== 1) {
  const result = await build({
    configFile: false,
    plugins: [svelte({ configFile: false, compilerOptions: { css: "injected" } })],
    build: {
      write: false,
      minify: true,
      lib: {
        entry: resolve(directory, "main.ts"),
        name: "MokeConcepts",
        formats: ["iife"],
      },
    },
  });
  const results = Array.isArray(result) ? result : [result];
  const chunks = results.flatMap((entry) => ("output" in entry ? entry.output : []));
  const code = chunks.flatMap((chunk) => (chunk.type === "chunk" ? [chunk.code] : [])).join("\n");

  if (code.length === 0) throw new Error("The concept build produced no JavaScript.");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moke desktop concepts</title>
<style>
:root { color-scheme: light dark; --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --font-mono: ui-monospace, monospace; }
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font-sans); color: var(--foreground, CanvasText); }
button, input, textarea { font: inherit; }
</style>
</head>
<body>
<div id="concepts"></div>
<script>${code.replaceAll("</script", "<\\/script")}</script>
</body>
</html>\n`;

  await writeFile(resolve(directory, "index.html"), html);
  console.log("Built design/concepts/index.html");
}
