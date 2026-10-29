import type { PacketReview } from "../../src/lib/review/packet.ts";
import { reviewDisciplines } from "../../src/lib/review/execution.ts";
import { Match } from "effect";
import { packetCoverageProgress } from "../../src/lib/review/packet-coverage.ts";

const escape = (value: string | number) =>
  String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const discipline = (id: string) => reviewDisciplines.find((entry) => entry.id === id)?.label ?? id;
const paragraph = (value: string) => `<p class="prose">${escape(value || "Not recorded.")}</p>`;

const list = (values: ReadonlyArray<string>, empty: string) =>
  values.length
    ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>`
    : paragraph(empty);

const statusLabel = (value: string) => value.replaceAll("_", " ");
const badge = (value: string) => `<span class="badge">${escape(statusLabel(value))}</span>`;

function sourceLink(value: string) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" || url.username || url.password) return escape(value);

    return `<a href="${escape(url.href)}" rel="noopener noreferrer" target="_blank">${escape(value)}</a>`;
  } catch {
    return escape(value);
  }
}

function completion(id: string, instance: string, completed: boolean) {
  const inputId = `completed-${instance}-${id}`;

  return `<div class="completion"><input id="${escape(inputId)}" type="checkbox" aria-label="Completed: ${escape(id)}" data-completion-id="${escape(id)}"${completed ? " checked" : ""}><label for="${escape(inputId)}">Completed<span class="sr-only">: ${escape(id)}</span></label><span class="completion-state" data-completion-label="${escape(id)}">${completed ? "Completed" : "Not completed"}</span></div>`;
}

const passes = [
  ["completeness", "Document completeness"],
  ["requirements", "Code and agency requirements"],
  ["coordination", "Plan, calculation and detail coordination"],
  ["prior_comments", "Prior-comment closure"],
] as const;

const imageUri = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Render a standalone, escaped review report with offline evidence and user completion tracking. */
export function renderPacketReport(
  review: PacketReview,
  evidence: ReadonlyMap<string, string>,
): string {
  const sheetLabel = (id: string) =>
    review.sheets.find((sheet) => sheet.id === id)?.label ?? `Unknown sheet ${id}`;

  const scope = Match.value(review.scope).pipe(
    Match.tagsExhaustive({
      WholeSet: () => "Whole drawing set",
      Discipline: (selected) => `${discipline(selected.discipline)} review`,
    }),
  );

  const severityOrder = { Critical: 0, Major: 1, Minor: 2 };

  const findings = review.findings.toSorted(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      discipline(left.discipline).localeCompare(discipline(right.discipline)) ||
      left.id.localeCompare(right.id),
  );

  const coverageProgress = packetCoverageProgress(review);

  const gaps = coverageProgress.gaps.map((gap) => {
    const pass = passes.find(([id]) => id === gap.pass)?.[1] ?? gap.pass;

    const reason =
      gap.reason === "needs_reason" ? "Not applicable needs a reason" : statusLabel(gap.reason);

    return `${sheetLabel(gap.sheetId)}: ${discipline(gap.discipline)} · ${pass} (${reason})`;
  });

  const unresolvedCitations = review.citations.filter(
    (citation) => citation.status !== "verified",
  ).length;

  const complete =
    review.finished &&
    review.state === "completed" &&
    coverageProgress.complete &&
    review.missingInputs.length === 0 &&
    !findings.some((finding) => finding.status === "Needs input") &&
    unresolvedCitations === 0;

  const reviewState = complete
    ? "Requested review recorded"
    : review.finished
      ? "Review has unresolved coverage or inputs"
      : "Review in progress or incomplete";

  const storageKey = `moke:packet-report:${review.projectId}:${review.id}:v${review.version}`;

  const evidenceImage = (id: string, caption: string) => {
    const uri = evidence.get(id);

    return uri !== undefined && imageUri.test(uri)
      ? `<figure><img src="${escape(uri)}" alt="${escape(caption)}"><figcaption>${escape(caption)} · Evidence ${escape(id)}</figcaption></figure>`
      : `<p class="missing-evidence">Evidence ${escape(id)} is unavailable in this report. ${escape(caption)}</p>`;
  };

  const coverageRows = review.sheets
    .map(
      (sheet) =>
        `<tr><th scope="row">${escape(sheet.label)}<small>${escape(sheet.documentName)} · PDF page ${sheet.pageIndex + 1}<br>Source ${escape(sheet.sha256)}<br>${review.inspectedSheetIds.includes(sheet.id) ? "Source image opened" : "Source image not opened"}</small></th>${passes
          .map(([pass]) => {
            const rows = coverageProgress.ledger.filter(
              (entry) => entry.sheetId === sheet.id && entry.pass === pass,
            );

            return `<td>${rows
              .map((entry) => {
                const gap = coverageProgress.gaps.find(
                  (item) =>
                    item.sheetId === entry.sheetId &&
                    item.discipline === entry.discipline &&
                    item.pass === entry.pass,
                );

                const note = Match.value(gap?.reason).pipe(
                  Match.when("missing", () => "No coverage entry recorded."),
                  Match.when("needs_reason", () => "Not applicable requires an explicit reason."),
                  Match.orElse(() => entry.note),
                );

                return `<div class="coverage-entry">${badge(entry.status)}<strong>${escape(discipline(entry.discipline))}</strong>${paragraph(note)}</div>`;
              })
              .join("")}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");

  const evidenceManifest = findings.flatMap((finding) =>
    finding.evidenceIds.length
      ? finding.evidenceIds.map(
          (id) =>
            `<tr><td>${escape(finding.id)}</td><td>Embedded evidence ${escape(id)}</td><td>${escape(finding.locations.map((location) => `${sheetLabel(location.sheetId)}: ${location.detail}`).join("; "))}</td><td>${escape(finding.evidenceNote || finding.observed)}${evidence.has(id) && imageUri.test(evidence.get(id) ?? "") ? "" : " — image unavailable"}</td></tr>`,
        )
      : [
          `<tr><td>${escape(finding.id)}</td><td>No image attached</td><td>${escape(finding.locations.map((location) => `${sheetLabel(location.sheetId)}: ${location.detail}`).join("; ") || "No location recorded")}</td><td>${escape(finding.evidenceNote || "No reason for missing image evidence was recorded.")}</td></tr>`,
        ],
  );

  const priorEvidence = review.priorComments.flatMap((comment) =>
    comment.evidenceIds.map(
      (id) =>
        `<tr><td>Prior comment ${escape(comment.id)}</td><td>Embedded evidence ${escape(id)}</td><td>${escape(comment.changedSources || "Location not recorded")}</td><td>${escape(comment.comment)}${evidence.has(id) && imageUri.test(evidence.get(id) ?? "") ? "" : " — image unavailable"}</td></tr>`,
    ),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'none'"><title>${escape(review.projectName)} — Moke drawing review</title>
<style>${styles}</style></head><body><main data-storage-key="${escape(storageKey)}">
<header><p class="eyebrow">Moke · Drawing review</p><h1>${escape(review.projectName)}</h1><p class="scope">${escape(scope)}</p><div class="review-state">${escape(reviewState)}</div><dl class="metadata"><div><dt>Review</dt><dd>${escape(review.id)} · revision ${review.version}</dd></div><div><dt>Requested</dt><dd>${escape(new Date(review.startedAt).toISOString())}</dd></div><div><dt>Last recorded</dt><dd>${escape(new Date(review.changedAt).toISOString())}</dd></div><div><dt>Execution</dt><dd>${escape(review.state)} · ${review.admittedCalls} calls${review.maxCalls === null ? "" : ` / ${review.maxCalls} requested limit`}</dd></div></dl></header>
<section aria-labelledby="summary"><h2 id="summary">Review summary</h2>${paragraph(review.summary || "No review summary has been recorded.")}${review.error ? `<p class="callout">${escape(review.error)}</p>` : ""}<p>This report records the requested scope and evidence below. User completion tracking is separate from finding status, engineering acceptance and reviewer-verified prior-comment closure.</p><h3>Request</h3>${paragraph(review.request)}<h3>Missing inputs</h3>${list(review.missingInputs, "No missing inputs were recorded.")}${gaps.length ? `<h3>Coverage requiring follow-up</h3>${list(gaps, "")}` : ""}<p>${review.citations.length === 0 ? "No governing citations were recorded; regulatory conclusions remain unverified." : `${unresolvedCitations} of ${review.citations.length} citations remain unverified or incorrect.`}</p></section>
<section aria-labelledby="configuration"><h2 id="configuration">Project configuration and governing sources</h2>${
    Object.keys(review.projectConfiguration).length
      ? `<dl class="configuration">${Object.entries(review.projectConfiguration)
          .map(
            ([key, value]) =>
              `<div><dt>${escape(key)}</dt><dd>${escape(value || "Needs input")}</dd></div>`,
          )
          .join("")}</dl>`
      : paragraph("Project configuration and governing editions need input.")
  }</section>
<section aria-labelledby="findings"><h2 id="findings">Findings</h2><p id="completion-storage" role="status">Completion choices are saved in this browser for this project and report revision. They do not travel with a copied HTML file.</p><noscript><p>JavaScript is unavailable. Checkboxes remain usable, but choices are temporary and repeated checkboxes do not synchronize.</p></noscript>${findings.length ? `<table class="finding-summary"><thead><tr><th>Issue</th><th>Discipline / severity</th><th>Finding status</th><th>User tracking</th></tr></thead><tbody>${findings.map((finding) => `<tr><td><a href="#finding-${escape(finding.id)}">${escape(finding.title)}</a><small>${escape(finding.id)}</small></td><td>${escape(discipline(finding.discipline))}<br>${badge(finding.severity)}</td><td>${escape(finding.status)}</td><td>${completion(`finding:${finding.id}`, "summary", finding.completed)}</td></tr>`).join("")}</tbody></table>` : paragraph("No findings have been recorded. This alone does not establish that the drawing set is free of issues.")}
${findings
  .map(
    (finding) =>
      `<article class="finding" id="finding-${escape(finding.id)}"><p class="eyebrow">${escape(discipline(finding.discipline))} · ${escape(finding.severity)} · ${escape(finding.classification)}</p><h3>${escape(finding.title)}</h3><p class="issue-id">Issue ${escape(finding.id)} · Finding status: <strong>${escape(finding.status)}</strong></p>${completion(`finding:${finding.id}`, "detail", finding.completed)}<h4>Location</h4>${list(
        finding.locations.map(
          (location) =>
            `${sheetLabel(location.sheetId)}: ${location.detail}${location.region === null ? "" : ` (PDF points x=${location.region.x}, y=${location.region.y}, width=${location.region.width}, height=${location.region.height})`}`,
        ),
        "No source location was recorded.",
      )}<h4>Observed condition</h4>${paragraph(finding.observed)}<h4>Specific correction or missing input</h4>${paragraph(finding.correction)}<h4>Source and calculation references</h4>${list([...finding.citationIds.map((id) => `Citation ${id}`), ...finding.calculationIds.map((id) => `Calculation ${id}`), ...(finding.priorCommentId === null ? [] : [`Prior comment ${finding.priorCommentId}`])], finding.classification === "Drawing conflict" ? "Drawing coordination; see source locations and evidence." : "No supporting citation or calculation was recorded.")}<h4>Focused evidence</h4>${finding.evidenceIds.map((id) => evidenceImage(id, finding.evidenceNote || finding.observed)).join("") || paragraph(finding.evidenceNote || "No image evidence or explanation was recorded.")}</article>`,
  )
  .join("")}</section>
<section aria-labelledby="coverage"><h2 id="coverage">Document inventory and review coverage</h2><p>Coverage is recorded for every requested sheet, discipline and pass. Whole-set reviews account for all 11 disciplines; excluded work requires an explicit Not applicable reason. Opening a source image does not establish completion of its checks. Missing entries remain unreviewed. Compatible coverage from earlier scopes remains visible but does not settle a different discipline's checks.</p>${review.sheets.length ? `<div class="table-wrap"><table class="coverage"><thead><tr><th>Document / sheet</th>${passes.map(([, title]) => `<th>${title}</th>`).join("")}</tr></thead><tbody>${coverageRows}</tbody></table></div>` : paragraph("No source sheets were recorded for this review.")}</section>
<section aria-labelledby="citations"><h2 id="citations">Governing-source and citation log</h2>${review.sources.length ? review.sources.map((source) => `<article class="record"><h3>${escape(source.title || "Untitled source")}</h3><p>${badge(source.status)} · ${source.official ? "Official source" : "Other source"}</p><p class="url">${sourceLink(source.url)}</p><dl><dt>Source ID</dt><dd>${escape(source.id)}</dd><dt>Retrieved</dt><dd>${escape(source.retrievedAt)}</dd><dt>Content SHA-256</dt><dd>${escape(source.sha256 ?? "Not available")}</dd></dl>${source.status === "unavailable" ? paragraph(source.text || "Source access was unavailable.") : ""}</article>`).join("") : paragraph("No governing sources have been retrieved.")}${review.citations.map((citation) => `<article class="record"><h3>${escape(citation.document || "Governing document needs input")} ${escape(citation.section)}</h3><p>${badge(citation.status)} · Citation ${escape(citation.id)}</p><dl><dt>Jurisdiction</dt><dd>${escape(citation.jurisdiction || "Needs input")}</dd><dt>Edition / date</dt><dd>${escape(citation.edition || "Needs input")}</dd><dt>Retrieved source</dt><dd>${escape(citation.sourceId ?? "Not available")}</dd></dl><h4>Governing text</h4>${citation.quote ? `<blockquote class="prose">${escape(citation.quote)}</blockquote>` : paragraph("No governing text was recorded.")}<h4>Application to the observed condition</h4>${paragraph(citation.application)}${paragraph(citation.note)}</article>`).join("")}</section>
<section aria-labelledby="calculations"><h2 id="calculations">Supporting calculations</h2>${
    review.calculations.length
      ? review.calculations
          .map(
            (calculation) =>
              `<article class="record"><h3>${escape(calculation.title)}</h3><p>Calculation ${escape(calculation.id)}</p><table><thead><tr><th>Input</th><th>Value</th><th>Unit</th></tr></thead><tbody>${Object.entries(
                calculation.inputs,
              )
                .map(
                  ([name, input]) =>
                    `<tr><td>${escape(name)}</td><td>${escape(input.value)}</td><td>${escape(input.unit || "Not specified")}</td></tr>`,
                )
                .join(
                  "",
                )}</tbody></table><p><code>${escape(calculation.expression)}</code></p><p class="result">Result: ${escape(calculation.result)} ${escape(calculation.unit)}</p>${paragraph(calculation.explanation)}</article>`,
          )
          .join("")
      : paragraph("No supporting calculations were recorded.")
  }</section>
<section aria-labelledby="prior"><h2 id="prior">Prior-comment and revision follow-up</h2>${review.priorComments.length ? review.priorComments.map((comment) => `<article class="record"><h3>${escape(comment.agency || "Agency not recorded")} · Comment ${escape(comment.number || comment.id)}</h3><p>${badge(comment.status)} · ${escape(comment.date || "Date not recorded")}</p>${completion(`prior:${comment.id}`, "prior", false)}<p class="issue-id">Prior-comment ID ${escape(comment.id)}. The status above records review closure separately from user completion.</p><h4>Original comment</h4>${paragraph(comment.comment)}<h4>Response</h4>${paragraph(comment.response)}<h4>Changed sources inspected</h4>${paragraph(comment.changedSources)}${comment.evidenceIds.map((id) => evidenceImage(id, `Prior comment ${comment.id}: ${comment.changedSources || comment.comment}`)).join("") || paragraph("No revised-source image evidence was attached.")}</article>`).join("") : paragraph("No prior jurisdiction comments were supplied or recorded. Their absence here does not establish closure of an earlier review.")}</section>
<section aria-labelledby="evidence"><h2 id="evidence">Evidence manifest</h2>${evidenceManifest.length + priorEvidence.length ? `<table><thead><tr><th>Issue ID</th><th>Embedded evidence</th><th>Sheet / location</th><th>Factual caption or missing-evidence reason</th></tr></thead><tbody>${[...evidenceManifest, ...priorEvidence].join("")}</tbody></table>` : paragraph("No issue evidence was recorded.")}</section>
<footer><h2>Review provenance</h2><p>Model ${escape(review.model)} · Provider ${escape(review.provider)}</p><p>Instructions ${escape(review.promptVersion)} · Source revision ${escape(review.instructionRevision)}</p><p>Report ${escape(review.id)} · Project ${escape(review.projectId)} · Conversation ${escape(review.conversationId)}</p><p>Source PDFs and the full durable execution history remain in the complete project package. This offline report embeds the focused evidence supplied at export.</p></footer>
</main><script>${completionScript}</script></body></html>`;
}

const styles = `
:root{font-family:Arial,Helvetica,sans-serif;color:#172b3a;background:#edf1f3;font-size:15px;line-height:1.55;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:32px auto;background:white;padding:48px 56px;box-shadow:0 4px 28px #172b3a12}header{border-bottom:3px solid #173b4b;padding-bottom:24px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.78rem;font-weight:700;color:#476573}h1{font-family:Georgia,serif;font-size:2.5rem;line-height:1.12;margin:12px 0}h2{font-family:Georgia,serif;font-size:1.65rem;line-height:1.2;margin:0 0 18px}h3{font-size:1.1rem;line-height:1.35;margin:20px 0 10px}h4{font-size:.86rem;text-transform:uppercase;letter-spacing:.04em;margin:20px 0 5px}p{margin:8px 0 14px}.scope{font-size:1.2rem;color:#476573}.review-state{border-left:4px solid #b07b25;background:#faf4e8;padding:10px 14px;margin:18px 0}.metadata,.configuration{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 26px}.metadata div,.configuration div{min-width:0}dt{font-weight:700;font-size:.82rem;color:#476573}dd{margin:2px 0 12px;overflow-wrap:anywhere}.metadata dd{font-size:.86rem}section{padding-top:34px;margin-top:28px;border-top:1px solid #d9e1e5}section:first-of-type{border-top:0;margin-top:0}.prose{white-space:pre-wrap;overflow-wrap:anywhere}.callout,.missing-evidence{padding:12px;border:1px solid #d8bd90;background:#fffbf2}.badge{display:inline-block;border:1px solid #ccd7dc;border-radius:4px;padding:2px 7px;font-size:.78rem;font-weight:700;text-transform:capitalize;background:#f1f5f6;white-space:normal}a{color:#14566e;text-decoration:underline;text-underline-offset:2px}table{border-collapse:collapse;width:100%;margin:14px 0 22px;font-size:.86rem}th,td{border-bottom:1px solid #d9e1e5;text-align:left;vertical-align:top;padding:10px 9px;overflow-wrap:anywhere}thead th{background:#edf3f5;border-top:1px solid #ccd7dc}small{display:block;color:#526874;font-weight:400;font-size:.75rem;margin-top:5px;overflow-wrap:anywhere}.coverage{table-layout:fixed}.coverage th:first-child{width:23%}.coverage-entry+ .coverage-entry{margin-top:12px}.coverage-entry strong{display:block;font-size:.78rem;margin-top:4px}.coverage-entry p{font-size:.78rem;margin:4px 0}.finding{padding:22px 0 30px;border-top:2px solid #173b4b;margin-top:26px}.finding h3{font-family:Georgia,serif;font-size:1.4rem;margin-top:7px}.issue-id{font-size:.78rem;color:#526874;overflow-wrap:anywhere}.completion{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:10px 0;font-size:.85rem}.completion input{width:18px;height:18px;margin:0;accent-color:#15596b}.completion input:focus-visible{outline:3px solid #277c9a;outline-offset:3px}.completion label{cursor:pointer}.completion-state{font-size:.76rem;color:#526874;border-left:1px solid #cbd7dc;padding-left:7px}.completion-state[data-completed="true"]{font-weight:700;color:#235a41}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.record{border-left:3px solid #d9e1e5;padding:0 0 2px 18px;margin:24px 0}.record dl{display:grid;grid-template-columns:130px 1fr;gap:0 15px}.record dd{font-size:.85rem}.url{font-size:.85rem;overflow-wrap:anywhere}blockquote{margin:12px 0;padding:10px 14px;background:#f4f6f7;border-left:3px solid #859da9}code{font-family:Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.result{font-weight:700}figure{margin:18px 0}figure img{display:block;width:auto;max-width:100%;max-height:650px;border:1px solid #d9e1e5;background:#fff}figcaption{font-size:.78rem;color:#526874;margin-top:7px;overflow-wrap:anywhere}footer{margin-top:40px;padding-top:24px;border-top:3px solid #173b4b;font-size:.8rem;color:#526874}footer h2{font-family:Arial,Helvetica,sans-serif;font-size:1rem}#completion-storage{font-size:.85rem;background:#edf3f5;padding:12px}#completion-storage[data-temporary="true"]{background:#fff4dc;color:#684b18}ul{padding-left:23px}
@media(max-width:760px){main{margin:0;padding:25px 20px;box-shadow:none}h1{font-size:2rem}.metadata,.configuration{grid-template-columns:1fr}.table-wrap{overflow-x:auto}.coverage{min-width:720px}.finding-summary th,.finding-summary td{padding:7px 4px}.completion-state{border:0;padding:0}.record dl{grid-template-columns:1fr}.record dd{margin-bottom:10px}}
@media print{@page{margin:16mm}html,body{background:white;font-size:10pt}main{max-width:none;margin:0;padding:0;box-shadow:none}h1{font-size:25pt}h2{font-size:17pt}h2,h3,h4{break-after:avoid}section{margin-top:20px;padding-top:22px}.finding,.record,figure{break-inside:avoid}thead{display:table-header-group}tr{break-inside:avoid}.table-wrap{overflow:visible}.coverage{min-width:0;font-size:8pt}.coverage-entry p{font-size:8pt}.coverage-entry strong{font-size:8pt}figure img{max-height:190mm}.completion input{appearance:auto;print-color-adjust:exact}.completion-state{display:inline;color:#172b3a}a{color:inherit}#completion-storage{border:1px solid #d9e1e5;background:none}}
`;

const completionScript = `
(() => {
  const root = document.querySelector('main');
  const key = root && root.dataset.storageKey;
  const controls = Array.from(document.querySelectorAll('input[data-completion-id]'));
  const labels = Array.from(document.querySelectorAll('[data-completion-label]'));
  const notice = document.getElementById('completion-storage');
  const savedMessage = 'Completion choices are saved in this browser for this project and report revision. They do not travel with a copied HTML file.';
  const states = Object.fromEntries(controls.map(input => [input.dataset.completionId, input.checked]));
  const showStorage = temporary => {
    if (!notice) return;
    notice.dataset.temporary = String(temporary);
    notice.textContent = temporary ? 'Completion choices are temporary because browser storage is unavailable. They will not be restored when this report is reopened.' : savedMessage;
  };
  const sync = () => {
    for (const input of controls) input.checked = states[input.dataset.completionId] === true;
    for (const label of labels) {
      const done = states[label.dataset.completionLabel] === true;
      label.dataset.completed = String(done);
      label.textContent = done ? 'Completed' : 'Not completed';
    }
  };
  try {
    const saved = key ? localStorage.getItem(key) : null;
    if (saved) {
      const value = JSON.parse(saved);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const id of Object.keys(states)) if (Object.hasOwn(value, id) && typeof value[id] === 'boolean') states[id] = value[id];
      }
    }
    if (key) localStorage.setItem(key, JSON.stringify(states));
    showStorage(false);
  } catch { showStorage(true); }
  sync();
  for (const input of controls) input.addEventListener('change', () => {
    states[input.dataset.completionId] = input.checked;
    sync();
    try {
      if (!key) throw new Error('No report revision');
      localStorage.setItem(key, JSON.stringify(states));
      showStorage(false);
    } catch { showStorage(true); }
  });
})();
`;
