import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ReviewSourceUrl } from "#lib/review/source-url.ts";

test("governing source links allow HTTPS and reject executable schemes and credentials", () => {
  const accepts = Schema.is(ReviewSourceUrl);
  expect(accepts("https://codes.iccsafe.org/content/FBC2023P1")).toBe(true);

  for (const url of [
    "file:///C:/Windows/system32/cmd.exe",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "http://example.com",
    "invalid",
  ])
    expect(accepts(url)).toBe(false);
});
