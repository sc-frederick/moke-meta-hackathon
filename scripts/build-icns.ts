/**
 * Pack PNG renders of the macOS icon into an ICNS file.
 *
 * Electron Builder's PNG-to-ICNS converter hangs under Bun, so the macOS build
 * uses the prebuilt `desktop/icons/icon.icns`. Usage:
 * `bun scripts/build-icns.ts <directory of 16.png … 1024.png> <output.icns>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ICNS PNG entry types and their pixel sizes, as written by Apple's iconutil. */
const entries = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
] as const;

/** Prefix data with a four-character type and its big-endian length, header included. */
function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(data.length + 8, 4);

  return Buffer.concat([header, data]);
}

const [directory, output] = process.argv.slice(2);

if (directory === undefined || output === undefined)
  throw new Error("Usage: bun scripts/build-icns.ts <png directory> <output.icns>");

const body = Buffer.concat(
  entries.map(([type, size]) => chunk(type, readFileSync(join(directory, `${size}.png`)))),
);

writeFileSync(output, chunk("icns", body));
