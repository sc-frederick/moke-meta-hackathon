import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { sep } from "node:path";
import { PackageError } from "#lib/review/packages.ts";

const invalidFile = () =>
  new PackageError({
    reason: "corrupt",
    message: "A package file is a symbolic link, changed identity, or is not a regular file.",
  });

/** Open one regular-file identity even where O_NOFOLLOW is unavailable (Windows). */
export async function openRegularFile(path: string, noFollowFlag = constants.O_NOFOLLOW ?? 0) {
  const before = await lstat(path, { bigint: true });

  if (before.isSymbolicLink() || !before.isFile()) throw invalidFile();
  const handle = await open(path, constants.O_RDONLY | noFollowFlag);

  try {
    const [opened, after] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);

    if (noFollowFlag === 0 && (before.ino === 0n || opened.ino === 0n || after.ino === 0n))
      throw new PackageError({
        reason: "unavailable",
        message: "This filesystem cannot verify package file identity.",
      });

    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino
    )
      throw invalidFile();

    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

/** Normalize only OS-generated relative paths; untrusted manifest paths are validated separately. */
export const portablePackagePath = (path: string, separator = sep) =>
  path.split(separator).join("/");
