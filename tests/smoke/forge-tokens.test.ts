import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const folders = [
  new URL("../../src/lib/review/components/", import.meta.url),
  new URL("../../src/routes/", import.meta.url),
];

// Returns each <button …> opening tag, skipping `>` inside Svelte expressions and quotes.
function buttonTags(markup: string) {
  const tags: Array<string> = [];

  for (const match of markup.matchAll(/<button(?=[\s>])/g)) {
    let depth = 0;
    let quote = "";

    for (let index = match.index; index < markup.length; index++) {
      const character = markup[index];

      if (quote) quote = character === quote ? "" : quote;
      else if (character === "{") depth++;
      else if (character === "}") depth--;
      else if (depth > 0 && (character === '"' || character === "'" || character === "`"))
        quote = character;
      else if (depth === 0 && character === '"') quote = character;
      else if (depth === 0 && character === ">") {
        tags.push(markup.slice(match.index, index + 1));
        break;
      }
    }
  }

  return tags;
}

// Colors come from src/lib/forge.css and every button carries a styled class.
test("workbench components use Forge tokens and shared controls", async () => {
  const problems: Array<string> = [];

  for (const folder of folders)
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".svelte")) continue;
      const source = await readFile(new URL(name, folder), "utf8");
      const styleStart = source.indexOf("<style>");
      const markup = styleStart === -1 ? source : source.slice(0, styleStart);
      const style = styleStart === -1 ? "" : source.slice(styleStart);

      if (source.includes("--nd-")) problems.push(`${name}: retired --nd- token`);

      if (/class="(ghost|primary)"/.test(source)) problems.push(`${name}: retired button class`);

      if (/#[0-9a-f]{3,8}\b/i.test(style)) problems.push(`${name}: raw hex color`);

      for (const tag of buttonTags(markup))
        if (!/\sclass[=\s{]/.test(tag)) problems.push(`${name}: unstyled ${tag.slice(0, 60)}`);
    }

  expect(problems).toEqual([]);
});
