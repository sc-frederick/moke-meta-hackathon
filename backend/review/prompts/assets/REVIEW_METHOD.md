# Shared review method

Apply this method with the assigned discipline file. Review the actual drawings and governing requirements. A checklist is a search guide, not a substitute for reading the adopted code.

## Establish governing sources

- Determine the code editions and amendments that govern the permit at its submission stage. Check the adopted Florida Building Code volumes, supplements and local amendments; Florida Fire Prevention Code and local amendments; the jurisdiction's land development code; and applicable utility, stormwater, transportation, accessibility, floodplain, approved-development and permit conditions. A newer published edition does not automatically govern an existing permit.
- Start with the [Florida Building Commission code resources](https://www.floridabuilding.org/fbc/Links_to_Code_Resources.html), [ICC Digital Codes for Florida](https://codes.iccsafe.org/codes/united-states/florida), the [Florida State Fire Marshal](https://www.myfloridacfo.com/division/sfm/bfp/florida-fire-prevention-code), [NFPA LiNK](https://link.nfpa.org), and the reviewing jurisdiction's official code and permit pages. Use the adopted Florida-specific text and amendments; a model-code summary or search snippet is insufficient. Use official agency manuals and approvals for their own scope.
- Search the applicable provisions for the design features shown, including requirements the drawings do not cite. For each proposed regulatory finding, browse the governing text and record jurisdiction, document, edition/date, exact section, URL, applicable condition, and measured plan fact. Check exceptions and definitions before reporting a violation. Classify each item as `Code`, `Permit condition`, `Agency request`, `Drawing conflict`, or `Recommendation`.
- Check every code citation printed on assigned sheets for edition, section existence, applied meaning, and Florida/local amendments. Log each as `verified`, `incorrect`, or `unverified`, with sheet location and reason. If a source requires login, request access, retry, then leave affected checks `unverified` if access remains unavailable. Do not invent a section, value, agency position or approval.

## Inspect and compare

- Run four passes: document completeness; applicable code and agency requirements; plan, calculation and detail coordination; and prior-comment closure. Render every assigned sheet as an image and inspect at a legible scale. Read all schedules, title blocks, legends, notes, callouts and each lettered or numbered detail. OCR or extracted text alone is insufficient. Retain only focused issue crops after review.
- Compare title block and index for project name/address, sheet number/title, scale, revision and date. Resolve every sheet/detail reference; check detail label, title, scale or NTS, dimensions, values and actual project fit. Flag blanks, placeholders, illegible data, wrong-project text and stale boilerplate.
- Reconcile areas, height, occupancy/use, construction type, code editions, room names, equipment tags, loads, elevations, and service points across assigned plans, calculations, forms and other available disciplines. Cite both locations for conflicts.
- Test every applicable discipline check and record its coverage as `Checked`, `Issue`, `Not applicable` with reason, or `Needs input` with the missing source. If absent or illegible material prevents a conclusion, say so. Record a missing document as a confirmed issue only after verifying it is required at this permit stage.
- For numerical checks, use repeatable arithmetic. Show inputs, units, method, result and governing limit; recheck unit conversions. Do not reuse a historical job's threshold. When design is delegated or deferred, identify the required design criteria, interfaces, responsible party and authority-approved submission stage.

## Findings and evidence

Give one issue per defect and a stable ID. Each finding must include: discipline; severity (`Critical` for demonstrated life-safety or permit-blocking problems, `Major` for missing/conflicting design needed to review or build, `Minor` for other correctable issues); status (`Confirmed` or `Needs input`); sheet/detail or report page; observed condition and values; source classification and exact citation or `drawing coordination`; calculation if used; specific correction; evidence path; and related prior comment. Surface plausible risks with incomplete evidence as `Needs input`, never as a confirmed violation. Avoid generic actions such as "verify compliance."

Save a focused, legible image crop for each drawing finding, named with its issue ID. Include a location marker and enough context to assess it. For a missing item, show the full region checked. For a cross-sheet conflict, capture both sides. If an image cannot support a finding, state why in the evidence manifest. Do not send full sheets, raw OCR, copied code pages or base64 images between reviewers.

For resubmittals, track every jurisdiction comment with agency, date, number, response, changed sheet/report/form and status: `Open`, `Partly resolved`, `Resolved`, or `Superseded`. Read the revised deliverable; a response letter alone does not close the item. Highlight repeated comments.

## Report and release

Return findings, coverage, citation log, prior-comment status and an evidence manifest (`issue ID | relative path | sheet/location | factual caption`). The lead reviewer merges duplicates and checks each issue ID, source, evidence path and cross-discipline conflict.

Deliver one self-contained HTML report with project configuration and governing-source status, sheet/document coverage, findings by discipline and severity, prior-comment status, missing inputs and focused evidence. Put CSS and JavaScript inline and embed evidence as local data URIs so the report opens offline. Include the comment completion controls below. Before release, confirm that every applicable scope was routed, every citation has a status, every issue has evidence or a reason, and the HTML and images open correctly.

### Comment completion controls

- Give every actionable review comment or finding a native HTML checkbox labeled `Completed`. Associate the label with the checkbox, include the issue ID in its accessible name, and support mouse and keyboard use. Start unchecked unless restoring a user's saved selection for that report revision.
- Key each checkbox to the comment's stable issue ID. When the same comment appears in a summary and a detailed finding, keep its completion state synchronized. Give prior jurisdiction comments their own stable IDs when they are separate action items.
- Let the user check a comment when its correction is completed and uncheck it to reopen the task. Show a visible `Completed` indication without hiding the comment, correction, citation or evidence. Keep this user tracking state separate from finding status and reviewer-verified prior-comment closure.
- Save selections in browser `localStorage`, using a key unique to the project and report revision, and restore them on reopening when storage is available. Handle unavailable storage without breaking the checkboxes. Explain in the report that saved selections belong to that browser and report revision and do not travel with a copied HTML file. If saving fails, show that selections are temporary.
- Preserve the current checked or unchecked state and completion label in print and PDF output. Keep the comment text and evidence legible in either state.
- Before release, test checking and unchecking, keyboard operation, synchronization of repeated comments, reload persistence, unavailable-storage behavior, and print output. Confirm that selections from another project or report revision cannot mark this report's comments completed.
