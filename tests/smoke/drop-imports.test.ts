import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDropImports } from "../../desktop/drop-imports.ts";
import { id, open, response } from "../fixtures/packet-review.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";

test("a drop claim rejects fresh-command reuse and preserves same-command receipts across response loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-drop-claim-"));
  const api = await open(directory, async () => response());

  try {
    const source = join(directory, "Revision.pdf");
    await writeFile(source, createHeroPdf("B"));
    const drops = createDropImports();
    const token = drops.stage(source);

    if (!token) throw new Error("Missing drop token");

    const request = {
      projectId: api.projectId,
      expectedVersion: (await api.snapshot()).project?.version ?? -1,
      commandId: id(),
      dropToken: token,
      revisionLabel: "Rev 1",
    };

    const [first, duplicate] = await Promise.all([
      api.run(drops.claim(request, token)),
      api.run(drops.claim(request, token)),
    ]);

    const other = await api.run(Effect.exit(drops.claim({ ...request, commandId: id() }, token)));
    expect(String(other)).toContain("another import request");
    const imported = await api.importPdf({ ...request, source: first.source, name: "Rev 1" });
    // Simulate losing the backend response before the shell caches it: replay the original command.
    const replayed = await api.importPdf({ ...request, source: duplicate.source, name: "Rev 1" });
    expect(replayed).toEqual(imported);
    duplicate.complete(replayed);
    await rm(source);
    const recovered = await api.run(drops.claim(request, token));
    expect(recovered.receipt).toEqual(imported);
    const state = await api.snapshot();
    expect(state.revisions).toHaveLength(2);
    expect(
      String(
        await api.run(
          Effect.exit(
            drops.claim(
              { ...request, commandId: id(), expectedVersion: state.project?.version ?? -1 },
              token,
            ),
          ),
        ),
      ),
    ).toContain("another import request");
    expect(
      String(
        await api.run(Effect.exit(drops.claim({ ...request, revisionLabel: "Changed" }, token))),
      ),
    ).toContain("another import request");
  } finally {
    await api.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
