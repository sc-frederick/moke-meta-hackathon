import type { Region } from "#lib/review/contracts.ts";

/** Text positions from PDF.js, kept separate from confirmed engineering labels. */
export interface SheetText {
  /** Extracted text in its original reading order. */
  readonly text: string;
  /** PDF text origin. */
  readonly x: number;
  /** PDF text origin. */
  readonly y: number;
}

/** Prefer an embedded label or an unambiguous printed title-block identity; never confirms it. */
export function suggestedSheetLabel(
  pageIndex: number,
  embeddedLabel: string | null,
  text: ReadonlyArray<SheetText>,
  box: Region,
): string {
  const page = `Page ${pageIndex + 1}`;

  if (embeddedLabel?.trim() && !/^\d+$/.test(embeddedLabel.trim()))
    return `${embeddedLabel.trim().slice(0, 130)} · ${page}`;

  const candidates = new Map<string, string>();

  for (const item of text) {
    const value = item.text.trim();

    const titled = /^([A-Z]{1,3}(?:[-.]\d{1,3}|\d{2,3})(?:\.\d{1,2})?)\s*\|\s*(.{3,110})$/.exec(
      value,
    );

    if (titled?.[1] && titled[2]) {
      const code = titled[1];

      if (!candidates.has(code)) candidates.set(code, `${code} · ${titled[2].trim()}`);
      continue;
    }

    const inTitleBlock = item.x >= box.x + box.width * 0.75 && item.y <= box.y + box.height * 0.3;

    if (inTitleBlock && /^[A-Z]{1,3}(?:[-.]\d{1,3}|\d{2,3})(?:\.\d{1,2})?$/.test(value))
      candidates.set(value, candidates.get(value) ?? value);
  }

  const proposed = candidates.size === 1 ? candidates.values().next().value : undefined;

  return proposed ? `${proposed.slice(0, 140)} · ${page}` : page;
}
