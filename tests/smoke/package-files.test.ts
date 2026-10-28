import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegularFile } from "../../backend/review/package-files.ts";

test("package reads without O_NOFOLLOW retain regular-file identity and reject links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-package-file-"));

  try {
    const source = join(directory, "source");
    await writeFile(source, "original bytes");
    const handle = await openRegularFile(source, 0);

    try {
      expect(await handle.readFile("utf8")).toBe("original bytes");
    } finally {
      await handle.close();
    }

    const link = join(directory, "link");
    await symlink(source, link, "file");
    const linked = await openRegularFile(link, 0).catch((cause: unknown) => cause);
    expect(linked).toMatchObject({ message: expect.stringContaining("symbolic link") });
    await mkdir(join(directory, "folder"));

    const folder = await openRegularFile(join(directory, "folder"), 0).catch(
      (cause: unknown) => cause,
    );

    expect(folder).toMatchObject({ message: expect.stringContaining("regular file") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
