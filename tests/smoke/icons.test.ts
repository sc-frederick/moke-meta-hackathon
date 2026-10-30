import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { reviewIconPaths } from "#lib/review/icons.ts";

test("workbench icons use official Tabler outline paths", async () => {
  for (const [name, paths] of Object.entries(reviewIconPaths)) {
    const svg = await readFile(
      new URL(`../../node_modules/@tabler/icons/icons/outline/${name}.svg`, import.meta.url),
      "utf8",
    );

    const official = Array.from(svg.matchAll(/<path d="([^"]+)"/g), (match) => match[1] ?? "");
    const ours: ReadonlyArray<string> = paths;
    expect({ name, paths: official }).toEqual({ name, paths: [...ours] });
  }
});
