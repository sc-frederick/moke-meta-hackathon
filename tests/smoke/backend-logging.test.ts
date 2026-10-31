import { expect, test } from "bun:test";
import { Effect, Redacted, Schema } from "effect";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendConfig, BackendReady } from "#lib/backend-rpc.ts";
import { writeCloudState } from "../../backend/cloud/files.ts";
import { cloudRecord, countRequest } from "../fixtures/cloud-records.ts";

const logText = async (directory: string) => {
  const files = await readdir(directory).catch(() => []);
  const texts = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));

  return texts.join("");
};

test("startup and background warnings reach the log file while stdout carries only readiness", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "moke-backend-logging-"));
  const logs = join(dataDirectory, "logs");

  // A recorded cloud owner without a cloud connection makes the reconciliation fiber, forked
  // while the application layer is built, warn offline.
  await Effect.runPromise(
    writeCloudState(join(`${await realpath(dataDirectory)}.cloud`, "state.json"), [
      cloudRecord(countRequest(), "running", 1),
    ]),
  );

  const child = Bun.spawn([process.execPath, "--no-orphans", resolve("backend/main.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  let stdout = "";
  const decoder = new TextDecoder();

  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += decoder.decode(chunk, { stream: true });
  })();

  try {
    const config = new BackendConfig({
      dataDirectory,
      migrationDirectory: resolve("migrations"),
      token: Redacted.make("t".repeat(32)),
    });

    await child.stdin.write(JSON.stringify(Schema.encodeSync(BackendConfig)(config)) + "\n");
    await child.stdin.flush();

    const deadline = Date.now() + 60_000;

    while (!(stdout.includes("\n") && (await logText(logs)).includes("cloud_sync_deferred"))) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`Backend did not log the deferred sync. Stdout: ${stdout}`);
      await Bun.sleep(50);
    }

    await child.stdin.end();
    await child.exited;
    await reading;

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(BackendReady))(lines[0]).runtime).toBe(
      "bun",
    );

    const entries = (await logText(logs))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line));

    expect(JSON.stringify(entries)).toContain("cloud_sync_deferred");
    expect(JSON.stringify(entries)).not.toContain("t".repeat(32));
  } finally {
    child.kill();
    await child.exited;
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(`${dataDirectory}.cloud`, { recursive: true, force: true });
  }
}, 120_000);
