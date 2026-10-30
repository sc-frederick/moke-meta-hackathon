import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const folders = [
  new URL("../../src/lib/review/components/", import.meta.url),
  new URL("../../src/routes/", import.meta.url),
];

// Colors come from src/lib/forge.css so every surface stays on the Forge palette.
test("workbench components use Forge tokens and shared controls", async () => {
  const problems: Array<string> = [];

  for (const folder of folders)
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".svelte")) continue;
      const source = await readFile(new URL(name, folder), "utf8");
      const style = source.includes("<style>") ? source.slice(source.indexOf("<style>")) : "";

      if (source.includes("--nd-")) problems.push(`${name}: retired --nd- token`);

      if (/class="(ghost|primary)"/.test(source)) problems.push(`${name}: retired button class`);

      if (/#[0-9a-f]{3,8}\b/i.test(style)) problems.push(`${name}: raw hex color`);
    }

  expect(problems).toEqual([]);
});
