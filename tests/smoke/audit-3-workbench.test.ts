import { expect, test } from "bun:test";
import { Effect, Schema, Semaphore } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ReviewSourceUrl } from "#lib/review/source-url.ts";
import { validateReviewPackage } from "../../backend/review/packages.ts";

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

test("invalid package preflight reports the missing manifest before maintenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-invalid-package-"));

  try {
    const error = await Effect.runPromise(
      validateReviewPackage(
        {
          dataDirectory: join(directory, "live"),
          migrationDirectory: resolve("migrations"),
          queries: Semaphore.makeUnsafe(1),
          quiesce: Effect.die("must not quiesce on preflight"),
        },
        directory,
      ).pipe(Effect.flip),
    );

    expect(error.reason).toBe("incomplete");
    expect(error.message).toContain("manifest is missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
