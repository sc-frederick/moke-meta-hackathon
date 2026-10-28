import { expect, test } from "bun:test";
import { Redacted } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialError, readProviderConfiguration } from "../desktop/credential-files.ts";

test("explicit session credentials reject shared Unix permissions and accept a private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-credential-permissions-"));
  const source = join(directory, "session.json");

  try {
    await writeFile(
      source,
      JSON.stringify({
        provider: "meta",
        apiKey: "test-key-never-dispatched",
        baseUrl: "https://api.meta.ai/v1",
        model: "muse-spark-1.3",
      }),
      { mode: 0o600 },
    );
    expect(Redacted.value((await readProviderConfiguration(source, true)).apiKey)).toBe(
      "test-key-never-dispatched",
    );

    if (process.platform !== "win32") {
      for (const mode of [0o644, 0o640]) {
        await chmod(source, mode);

        const failure = await readProviderConfiguration(source, true).catch(
          (cause: unknown) => cause,
        );

        expect(failure).toBeInstanceOf(CredentialError);
        expect(failure).toMatchObject({
          message: expect.stringContaining("readable only by its owner"),
        });
      }
    }

    await writeFile(
      source,
      JSON.stringify({
        provider: "meta",
        apiKey: "test-key-never-dispatched",
        baseUrl: "https://example.invalid",
        model: "muse-spark-1.3",
      }),
    );
    const failure = await readProviderConfiguration(source).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CredentialError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("invalid for the supported provider route"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
