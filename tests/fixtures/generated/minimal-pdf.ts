/** Build an original vector PDF with repeated pages and byte-correct cross references. */
export function buildMinimalPdf(
  rotation: 0 | 90 | 180 | 270 = 0,
  width = 612,
  height = 792,
  userUnit = 1,
  pageCount = 1,
): Uint8Array {
  const content = `0.5 w 24 24 200 160 re S\n${width > 612 ? `4 w 60 60 ${width - 120} ${height - 120} re S\n60 ${height / 2} m ${width - 60} ${height / 2} l S\n${width / 2} 60 m ${width / 2} ${height - 60} l S\n` : ""}`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /UserUnit ${userUnit} /Rotate ${rotation} /Contents ${pageCount + 3} 0 R >>`,
    ),
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}
