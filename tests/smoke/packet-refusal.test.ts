import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id, open, response, until } from "../fixtures/packet-review.ts";

test("a request the provider refuses past its budget pauses the review uncharged and resumes explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-packet-refusal-"));
  let sends = 0;

  const session = await open(directory, async () => {
    sends++;

    // A provider wait longer than the 10-minute refusal budget ends the attempt at once.
    return sends === 1
      ? Response.json(
          { error: "Rate limit exceeded" },
          { status: 429, headers: { "retry-after": "900" } },
        )
      : response([], "Continued the review once the provider accepted requests again.");
  });

  try {
    const request = await session.request("Please run a quick QA pass.");
    const started = await session.run(session.packets.start(request));
    const paused = await until(session, started.id, "paused");
    expect(sends).toBe(1);
    expect(paused.admittedCalls).toBe(1);
    expect(paused.error).toContain("HTTP 429");
    expect(paused.error).toContain("Nothing was generated or charged");
    expect(paused.error).not.toContain("may have been charged");
    expect(paused.providerFailure).toMatchObject({
      category: "http",
      httpStatus: 429,
      detail: "rate_limit",
    });

    // No attempt is left unresolved, so nothing blocks an explicit resume.
    const unresolved = await session.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ task_id: Schema.Int })),
        )(
          yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${started.id} AND status='uncertain'`,
        );
      }),
    );

    expect(unresolved).toEqual([]);

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: paused.version,
        action: "resume",
        commandId: id(),
      }),
    );

    // The scripted reviewer answers without finishing, so the resumed review ends incomplete.
    const resumed = await until(session, started.id, "failed");
    expect(sends).toBe(2);
    expect(resumed.admittedCalls).toBe(2);
    expect(resumed.summary).toContain("once the provider accepted requests again");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
