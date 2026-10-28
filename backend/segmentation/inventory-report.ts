import type { Effect } from "effect";
import type { InventoryFixture, reconcileFixtures } from "./reconciliation.ts";
import type { DrawingCrop } from "./fixtures.ts";

type Counts = Effect.Success<ReturnType<typeof reconcileFixtures>>;

/** One region's original crop and all SAM proposals, embedded in the offline worksheet. */
export type InventoryEvidence = {
  readonly id: string;
  readonly caption: string;
  readonly svg: string;
  readonly boxesSvg: string;
};

function html(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Preserve the original Muse boxes as a separate baseline, without substituting SAM bounds. */
export function proposalSvg(
  fixtures: ReadonlyArray<InventoryFixture>,
  crop: DrawingCrop,
  bytes: Uint8Array,
): string {
  const boxes = fixtures
    .map((fixture) => {
      const box = fixture.proposal;

      return `<g fill="none" stroke="#075b9c" stroke-width="3"><rect x="${box.left}" y="${box.top}" width="${box.right - box.left}" height="${box.bottom - box.top}"/><text x="${box.left}" y="${Math.max(20, box.top - 8)}" fill="#075b9c" stroke="white" stroke-width="3" paint-order="stroke" font-family="sans-serif" font-size="20">${html(fixture.id)}</text></g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width_px}" height="${crop.height_px}" viewBox="0 0 ${crop.width_px} ${crop.height_px}"><image width="${crop.width_px}" height="${crop.height_px}" href="data:image/png;base64,${Buffer.from(bytes).toString("base64")}"/>${boxes}</svg>`;
}

/** Produce a scoped coordination worksheet with reversible reviewer count corrections. */
export function inventoryReport(
  rows: Counts,
  fixtures: ReadonlyArray<InventoryFixture>,
  evidence: ReadonlyArray<InventoryEvidence>,
  schedulePng: Uint8Array,
  revision: string,
): string {
  const totals = rows
    .map(
      (row) =>
        `<tr data-total="${html(row.mark)}" data-scheduled="${row.scheduled ?? ""}" data-unresolved="${row.unresolved ?? ""}" data-covered="${row.proposed === null ? "false" : "true"}"><th>${html(row.mark)}</th><td>${html(row.description)}</td><td>${row.scheduled ?? "Missing"}</td><td data-count>${row.proposed ?? "Not tested"}</td><td data-delta>${row.delta ?? "—"}</td><td data-status>${html(row.status)}</td></tr>`,
    )
    .join("");

  const inventory = fixtures
    .map(
      (fixture) =>
        `<tr><td><input type="checkbox" data-include data-mark="${html(fixture.mark)}" id="include-${html(fixture.id)}" ${fixture.evidence === "available" ? "checked" : "disabled"}/><label for="include-${html(fixture.id)}">Include ${html(fixture.id)}</label></td><td>${html(fixture.mark)}</td><td>${html(fixture.room)}</td><td>${html(fixture.scope)}</td><td><a href="#${html(fixture.crop)}">${html(fixture.crop)}</a></td><td>${fixture.evidence === "available" ? "Mask available; review pending" : "Needs input: mask unavailable"}</td></tr>`,
    )
    .join("");

  const images = evidence
    .map(
      (region) =>
        `<figure id="${html(region.id)}"><img data-evidence data-boxes-src="data:image/svg+xml;base64,${Buffer.from(region.boxesSvg).toString("base64")}" data-mask-src="data:image/svg+xml;base64,${Buffer.from(region.svg).toString("base64")}" src="data:image/svg+xml;base64,${Buffer.from(region.boxesSvg).toString("base64")}" alt="${html(region.caption)}"/><figcaption>${html(region.caption)}. All proposals are shown, including any excluded inventory rows.</figcaption></figure>`,
    )
    .join("");

  const tasks = rows
    .filter((row) => row.proposed !== null)
    .map(
      (row) =>
        `<p><input type="checkbox" data-completed id="review-${html(row.mark)}"/><label for="review-${html(row.mark)}">Completed: review ${html(row.mark)} evidence and schedule reconciliation</label> <span data-completion-label></span></p>`,
    )
    .join("");

  const key = JSON.stringify(`moke-fixture-reconciliation:${revision}`).replaceAll("<", "\\u003c");
  const reportRevision = JSON.stringify(revision).replaceAll("<", "\\u003c");
  const candidates = JSON.stringify(fixtures).replaceAll("<", "\\u003c");

  return `<!doctype html><html lang="en"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Moke plumbing fixture reconciliation</title><style>body{font:16px/1.5 system-ui,sans-serif;color:#172033;background:#f2f5f8;max-width:1400px;margin:auto;padding:28px}section,figure{background:white;border:1px solid #ccd5df;border-radius:10px;padding:20px;margin:20px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #d8dfe8}img{max-width:100%;height:auto}.regions{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}input{margin-right:8px}label{cursor:pointer}a{color:#075b9c}.scroll{overflow:auto}.note{border-left:4px solid #b45309;padding-left:12px}@media(max-width:850px){.regions{grid-template-columns:1fr}body{padding:12px}}@media print{body{background:white;padding:0}.regions{display:block}figure{break-inside:avoid}input{appearance:auto}}</style><h1>Moke · Plumbing fixture reconciliation</h1><p>Schedule versus ${evidence.length} selected plan regions.</p><p class="note"><strong>Experimental coordination worksheet.</strong> Muse supplies candidate classes and locations; SAM supplies proposed masks. Counts include existing and unclear-scope fixtures. The whole sheet, risers, required quantities, and code compliance have not been reviewed. Matching totals do not confirm fixture identity or a complete inventory.</p><section><h2>Schedule and scoped inventory</h2><div class="scroll"><table><thead><tr><th>Mark</th><th>Fixture</th><th>Schedule quantity</th><th>Included proposals</th><th>Delta</th><th>Coordination status</th></tr></thead><tbody>${totals}</tbody></table></div><p>Only WC and LAV were tested. Other schedule rows remain untested. A differing count calls for inspection, not an automatic drawing-conflict finding.</p></section><section><h2>Review and correct</h2><p>Inspect each mask against the original drawing. Uncheck a mistaken proposal to recalculate its quantity and delta. These controls do not change the source drawings or saved model responses.</p><div class="scroll"><table><thead><tr><th>Count proposal</th><th>Mark from Muse</th><th>Room from Muse</th><th>Scope from Muse</th><th>Evidence</th><th>State</th></tr></thead><tbody>${inventory}</tbody></table></div>${tasks}<p>Completed records your task tracking. It does not verify a finding or establish compliance. Selections are stored only in this browser for this report revision; they do not travel with a copied HTML file.</p><p id="storage-status" role="status"></p><button id="reset" type="button">Reset local review selections</button> <button id="export-review" type="button">Export review decisions</button></section><h2>Plan evidence</h2><button id="toggle-masks" type="button" aria-pressed="false">Show SAM masks</button><p id="evidence-mode">Muse candidate boxes; SAM masks hidden.</p><p>Mask geometry can have holes or partial tanks. Confirm the intended instance and boundary; model confidence is not measured accuracy.</p><div class="regions">${images}</div><section><h2>Schedule evidence</h2><img src="data:image/png;base64,${Buffer.from(schedulePng).toString("base64")}" alt="Supplied plumbing fixture schedule"/><p>The schedule was read separately, without supplying its counts to the plan-grounding requests.</p></section><section><h2>Coverage and source status</h2><p>Checked inputs: ${evidence.length} named plan crops and the supplied fixture schedule crop. WC/LAV count coordination is proposed and pending visual review. Other classes, sheet completeness, exact marks, new/removed scope, architecture, risers, prior comments, and governing requirements need further input. Project identity, jurisdiction, and permit stage were anonymized or excluded.</p><p>No regulatory finding or verified prior-comment closure is reported. Basis: Moke plumbing instructions at sc-frederick/skills revision 8a0e2648738018631eaa6d24ee0b6ebaa239afb1. Report revision: ${html(revision)}.</p></section><script>
const key=${key};
const reportRevision=${reportRevision};
const candidates=${candidates};
const controls=[...document.querySelectorAll('input[data-include],input[data-completed]')];
const original=controls.map(c=>c.checked);
let saved={};
try{saved=JSON.parse(localStorage.getItem(key)||'{}');if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};document.getElementById('storage-status').textContent='Selections saved in this browser for this report revision.';}catch{document.getElementById('storage-status').textContent='Storage unavailable. Selections are temporary.';}
controls.forEach(c=>{if(!c.disabled&&typeof saved[c.id]==='boolean')c.checked=saved[c.id];});
function update(){document.querySelectorAll('[data-total]').forEach(row=>{if(row.dataset.covered!=='true')return;const mark=row.dataset.total;const count=[...document.querySelectorAll('input[data-include]')].filter(c=>c.dataset.mark===mark&&c.checked&&!c.disabled).length;const raw=row.dataset.scheduled;const scheduled=raw===''?null:Number(raw);row.querySelector('[data-count]').textContent=String(count);row.querySelector('[data-delta]').textContent=scheduled===null?'Missing':String(count-scheduled);row.querySelector('[data-status]').textContent=Number(row.dataset.unresolved)>0||scheduled===null?'needs-input':count===scheduled?'counts-agree · review pending':'counts-differ · review pending';});document.querySelectorAll('input[data-completed]').forEach(c=>c.parentElement.querySelector('[data-completion-label]').textContent=c.checked?'Completed':'');}
function persist(){try{localStorage.setItem(key,JSON.stringify(Object.fromEntries(controls.map(c=>[c.id,c.checked]))));document.getElementById('storage-status').textContent='Selections saved in this browser for this report revision.';}catch{document.getElementById('storage-status').textContent='Storage unavailable. Selections are temporary.';}}
controls.forEach(c=>c.addEventListener('change',()=>{update();persist();}));
document.getElementById('reset').addEventListener('click',()=>{controls.forEach((c,i)=>c.checked=original[i]);update();persist();});
document.getElementById('toggle-masks').addEventListener('click',event=>{const button=event.currentTarget;const show=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(show));button.textContent=show?'Show Muse boxes only':'Show SAM masks';document.getElementById('evidence-mode').textContent=show?'Muse candidate; SAM geometry. Compare with the original proposal.':'Muse candidate boxes; SAM masks hidden.';document.querySelectorAll('img[data-evidence]').forEach(img=>img.src=show?img.dataset.maskSrc:img.dataset.boxesSrc);});
document.getElementById('export-review').addEventListener('click',()=>{const decisions=controls.filter(c=>c.hasAttribute('data-include')).map(c=>({id:c.id.slice(8),decision:c.disabled?'unresolved':c.checked?'included':'excluded'}));const completed=controls.filter(c=>c.hasAttribute('data-completed')).map(c=>({id:c.id,completed:c.checked}));const body=JSON.stringify({reportRevision,candidates,decisions,completed,review:'user tracking; no verified finding closure'},null,2);const url=URL.createObjectURL(new Blob([body],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='moke-fixture-review.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
update();
</script></html>`;
}
