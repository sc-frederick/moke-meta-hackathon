import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Known-good one-page PDF bytes (612×792 pt) used for generated fixtures. */
const basePdf = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0tpZHMgWzMgMCBSXQovQ291bnQgMQo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9NZWRpYUJveCBbMCAwIDYxMiA3OTJdCi9Db250ZW50cyA0IDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovTGVuZ3RoIDQ0Cj4+CnN0cmVhbQpCBQowIDAgNjEyIDc5MiByZQovRDEgcmVnaCBlbGxpc2NoCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjA0IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNQovUm9vdCAxIDAgUgo+PgpzdGFydXhyZWYKMjk3CiUlRU9G",
  "base64",
);

/** Build a tiny valid PDF with an optional /Rotate entry for geometry tests. */
export function buildMinimalPdf(rotation?: 90 | 180 | 270): Uint8Array {
  if (!rotation) {
    return new Uint8Array(basePdf);
  }

  const text = new TextDecoder().decode(basePdf);

  const rotated = text.replace(
    "/MediaBox [0 0 612 792]",
    `/MediaBox [0 0 612 792] /Rotate ${rotation}`,
  );

  return new TextEncoder().encode(rotated);
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));

/** Write the default generated PDF fixtures used by document tests. */
export function ensureGeneratedPdfFixtures() {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "original.pdf"), buildMinimalPdf());
  writeFileSync(join(fixtureDir, "rotated-90.pdf"), buildMinimalPdf(90));
  writeFileSync(join(fixtureDir, "malformed.pdf"), Buffer.from("not a pdf"));
}

ensureGeneratedPdfFixtures();
