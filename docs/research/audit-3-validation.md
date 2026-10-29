# Audit 3: implementation and native acceptance

> The fresh-workspace recheck in [audit-3-recheck.md](audit-3-recheck.md) supersedes the acceptance
> statements below. It found several of them incomplete on a new install.

The earlier report copied the original problems and proposed fixes, then followed them with passing-test statements. That was insufficient evidence that each visible problem had been fixed. The reopened Windows audit found missing behaviors and fixed those directly. This report distinguishes implementation, observed native behavior and remaining limits.

The original 24 findings remain unchanged in the private source audit. The corrected per-finding report is `.local/audit-3-fixes/report/index.html`; its JSON separates `originalProblem`, `originalSuggestedFix`, `actualChange`, `nativeObservation`, before/after evidence and `remaining`. It has no blanket all-fixed status.

## What the reopened audit changed

Existing imports can now request and apply sheet-name proposals without reimporting or changing confirmation/count coverage. Revision mapping now pairs old/new thumbnails and opens a larger comparison. Long finding text has its own scrolling column beside a fitted source canvas. Coverage has a discipline summary, exception filters, sheet search and bounded detail pages.

Cloud status now carries file-completion byte/file counters and host-owned active/finished tool activity. The composer estimates the entire workspace before Send. Submission has its own state so read-only navigation can continue through upload, while edits remain fenced. Terminal cards collapse transfer details.

The native diagnostic-copy action failed through the renderer clipboard. Electron now loads and copies only the saved safe receipt through the trusted RPC boundary. Both short and long review notes use the escaped formatter. Cancelled historical errors hide the obsolete cancel instruction in the panel, and runtime cleanup preserves an existing known failure instead of replacing it with generic interruption copy.

## Per-finding acceptance

### M3-01: Full-set local reviews stop before usable results

**Status:** Provider rejection resolved; coverage remains incomplete.

**Changed:** Muse Spark Open packet requests retain at most eight recent images, replacing older request pixels with an omission notice while retaining durable source metadata and artifacts. Packet requests use a five-minute deadline. Safe failure receipts classify timeout, abort, HTTP, network and response failures and retain request image/byte counts and HTTP details without raw provider bodies. Uncertain paid attempts remain non-replayable.

**Observed:** Five supplied drawing sets returned findings after the eight-image request limit was enforced. This does not establish full-set completion: Brewery opened 27/29 sheets and recorded 7/1276 passes; Laundry 16/572; Porch 29/396; Civil 31/176. The fire-alarm discipline run recorded 12/12. The reopened native Brewery panel explicitly says Review finished with coverage gaps.

**Native frames:** 0886.png.

**Limits:** Transport admission and usable findings do not establish full-set coverage. A completed run can still have unopened sheets or unreviewed passes; the UI and report now name those coverage gaps rather than forcing additional inference. The rolling image window requires the reviewer to render an omitted source again before relying on its pixels; durable retention does not mean all pages are simultaneously visible to the model.

### M3-02: The error offers Cancel while telling the user to resume

**Status:** Native copy recheck pending.

**Changed:** Stopped packet reviews display the known provider failure, state that saved work is retained and the request may have been charged, and tell the user to cancel before starting a separate review. Cancel preserves the failure explanation and diagnostics. Copy review diagnostics exposes the safe saved receipt, and the composer uses the same cancel-to-unlock guidance. The UI does not automatically resend an uncertain request. The Copy action now asks Electron to load and copy the saved safe receipt, rather than depending on the unavailable renderer clipboard. Cancelled historical failures no longer display an obsolete cancel-to-unlock directive in the panel; the original saved diagnostic is retained.

**Observed:** The saved HTTP400 failure and 1:29 duration survived cancellation. Reopening the native Copy action exposed a renderer clipboard failure; it has been replaced with a trusted Electron action. The final packaged-app clipboard recheck is pending.

**Native frames:** 0195.png, 1145.png.

### M3-03: Cloud says Connected before checking the required provider secret

**Status:** Observed readiness behavior; inference availability remains separate.

**Changed:** Cloud setup reports Connected only after resolving the selected image, checking configured provider secrets for MOKE_API_KEY and verifying the worker identity in a bounded preflight sandbox. Start repeats preflight before preparing or uploading the workspace. Missing image/secret access returns a configuration-specific message instead of waiting for an unacknowledged worker.

**Observed:** Native settings showed Connected after the real image/worker/secret preflight. The audit-only image and both provider-secret names were checked before transfer. This does not prove the credential will succeed: a separate bounded Meta probe returned HTTP404 before any tools ran.

**Native frames:** 0997.png.

**Limits:** Preflight verifies worker compatibility and secret availability, not successful inference with the provider credential or future provider availability.

### M3-04: Reopening shows the wrong project and blocks returning to the live job

**Status:** Reopen observed; upload navigation recheck pending.

**Changed:** At startup an active cloud receipt selects its project and conversation, restores the packet model when available and sets cloud execution location. The receipt identifies project, model and scope. Snapshot reads use SQL replacement exclusion without waiting behind network transfer, allowing read-only navigation while local mutations remain fenced by cloud ownership. The send/upload request has its own submission flag so the sidebar can navigate during that request while mutation controls stay disabled; a late start response does not move the user back to the sending conversation.

**Observed:** The prior live cloud job reopened into its own fire-alarm conversation/model and allowed navigation during return. The reopened audit found the send request still disabled navigation during upload; that UI state is fixed in source and its new native upload check is pending.

**Native frames:** 0515.png, 1132.png.

### M3-05: Review scope leaks across projects

**Status:** Observed fixed in native Windows app.

**Changed:** Conversation switches save and restore scope mode, revision, selected sheets, discipline, model, execution location, call limit, draft and scroll position for that conversation. A fresh conversation defaults to whole-set scope, no selected sheets and automatic discipline instead of inheriting another project's selection. The composer separately names the scoped PDF and sheet count.

**Observed:** Switched from Fire alarm / Selected discipline / Push to cloud to Civil / Whole set / On this computer, then back. Fire alarm and cloud choices were restored only in their own saved conversation; Civil retained Whole set.

**Native frames:** 1180.png, 1188.png.

**Limits:** These conversation view preferences are kept in renderer memory for the session; a general durable preference store across application restarts was not added. Active cloud startup restoration is a separate path.

### M3-06: New count check creates an invisible form below the sheet list

**Status:** Observed fixed in native Windows app.

**Changed:** Opening New count check creates the source-selection form and attaches focus behavior to Check name that scrolls the field into the working viewport and focuses it. The form contains the drawing and schedule selectors rather than requiring another inventory visit to choose them.

**Observed:** Clicked New count check in the long sheet inventory. The Check name form was brought into the visible work area rather than left below the inventory.

**Native frames:** 0230.png.

### M3-07: Generic page names make real drawing sets hard to navigate

**Status:** Observed fixed in native Windows app.

**Changed:** Fresh PDF inspection proposes advisory names from embedded labels or an unambiguous printed identity while preserving original page references. Inventory rows have lazy thumbnails, text search and collapsed count-verification controls. Existing generic labels now have Read sheet names, a current/proposed-name preview and an explicit Apply suggested names action. Applying those proposals preserves custom labels, confirmation and count-check coverage.

**Observed:** On the existing three-sheet fire-alarm import, Read sheet names proposed G-1 and FA-1 and preserved the custom FA-2 label. Apply changed the two generic labels without confirming them; closing and reopening the panel retained them. The before/proposal/after frames show this on an existing import, not only a new fixture.

**Native frames:** 0824.png, 0828.png, 0832.png, 0838.png.

**Limits:** Name extraction uses PDF labels and text heuristics, not OCR or a general title-block recognition model. Ambiguous/scanned pages can remain Page N and require manual naming. Existing labels are not silently rewritten; the user must request and apply proposals. Non-generic custom labels are intentionally excluded from replacement.

### M3-08: Revision mapping blocks a removed sheet and obscures saved matches

**Status:** Removed-sheet flow and previews observed; Added state remains limited.

**Changed:** Revision correspondence supports changed, unchanged, removed and unresolved prior sheets, permits partial decisions and keeps saved associations visible. Byte-identical PDFs propose page-index matches. Mapping rows now pair previous/new page previews with inline decision controls, keep checkbox text beside its checkbox and open a larger paired comparison dialog. Unmatched new pages remain visible as requiring fresh review.

**Observed:** The native Civil mapping shows compact paired old/new thumbnails and a larger comparison dialog. Saved retained-four/removed-one decisions remained after reopening. A separate persisted Added disposition is still unavailable; unmatched new pages are derived from correspondence.

**Native frames:** 0858.png, 0855.png, 0861.png.

**Limits:** Automatic matching is limited to byte-identical PDFs; retained pages inside a changed PDF are not independently matched by page content. New pages are derived and displayed as new or unmatched; an explicit persisted Added disposition is not implemented.

### M3-09: Reviewing successive sheets requires returning to the inventory

**Status:** Observed fixed in native Windows app.

**Changed:** The source viewer has previous/next sheet controls, current position and a searchable Jump to sheet picker. The workbench carries the zoom factor into the next source render, and Reset view/Fit sheet restores the fitted view.

**Observed:** Moved between original pages using Previous/Next in the source viewer, with the page position and Fit control visible. The searchable sheet picker is available alongside them.

**Native frames:** 0210.png.

**Limits:** Loading a new image resets pan and rotation; only zoom factor is preserved across source loads.

### M3-10: Long finding text pushes the source below the working viewport

**Status:** Observed fixed in native Windows app.

**Changed:** Packet-finding evidence now uses a bounded layout with an independently scrolling issue column and a separate fitted source canvas. Observation/correction and evidence notes are collapsed initially. At narrow widths the issue area is bounded above the canvas rather than allowing long text to push the image below the working area. Source navigation remains with the viewer.

**Observed:** Reopened the same Porch C1 finding. Before the new layout its source began near the bottom of the viewport and was cut off. Afterward the issue stays in a separately scrolling left column and the fitted source crop, toolbar and provenance remain visible on the right.

**Native frames:** 0791.png, 0810.png.

### M3-11: Cloud progress shows calls but not what the reviewer is doing

**Status:** Transfer counters observed; native tool-activity check pending.

**Changed:** Cloud receipts now carry uploaded/downloaded completed bytes and file counts with a progress bar, plus named preparation/transfer/review/result stages. Host-owned tool activity records identify the active or last finished tool and its drawing when applicable; the card separately labels the last recorded drawing opened. It also shows opened-sheet, finding and pass totals, recent activity age, elapsed time, remaining deadline time and Ends by. The configured review duration remains visible in settings.

**Observed:** The real 506.1MiB upload advanced from 50.1MiB/21 files to 148.0MiB/105 files, 256.4MiB/244 files and 297/297 files. The 506.3MiB return showed advancing download counters. The Meta request failed before tools, so it does not verify the new active tool/drawing surface; the explicit Baseten check is pending.

**Native frames:** 1122.png, 1125.png, 1127.png, 1145.png.

**Limits:** Transfer counters advance after each complete file, or after a downloaded file is verified and reused. They do not show partial bytes within a large file, transfer speed or a transfer-specific ETA. Tool/drawing activity describes host tool work; it does not expose what the model is reasoning about between tool calls. Preflight and local package preparation finish before the first persisted cloud job receipt is created. The card's elapsed clock and transfer counters do not cover that earlier work.

### M3-12: Old cloud receipts persist across every project

**Status:** Observed fixed in native Windows app.

**Changed:** Synced or cancelled cloud receipts display only in their owning project/conversation and expose Dismiss. A failed job that still owns the workspace remains globally visible until stopped, alongside active ownership, with project/model/scope context. Disconnect/reconnect copy is suppressed when the receipt no longer locks the workspace.

**Observed:** Dismissed the terminal receipt and moved to Civil. The unrelated cloud card stayed absent. Active ownership stayed visible while browsing a different conversation during the live download.

**Native frames:** 1167.png.

**Limits:** Dismissal is held in component memory rather than persisted; reopening the application can show the owning conversation's terminal receipt again.

### M3-13: Cancelling rewrites the displayed failure duration

**Status:** Failure duration observed; final failure-message recheck pending.

**Changed:** Packet receipts accumulate active running intervals and stop adding elapsed work while paused, failed or cancelled. Cancellation retains the existing error/provider-failure details. Previous reviews now open their saved result/failure panel, with a Back to latest review action, instead of presenting only a timestamp and state. Export cleanup and reopen now preserve an existing known failure when the reconciled state is unchanged, rather than replacing an HTTP failure with generic interruption wording.

**Observed:** The native cancelled HTTP400 review retained its 1:29 active duration. A new cloud probe revealed that export cleanup replaced its specific HTTP404 explanation with generic interruption text; the host reconciliation rule now preserves the known failure. The saved providerFailure receipt retained the HTTP404 details.

**Native frames:** 0195.png, 1132.png.

**Limits:** The UI does not present waiting time or a separate cancellation duration; its duration is active work. Older receipts without interval fields use their available legacy timestamps.

### M3-14: A notification survives into an unrelated empty project

**Status:** Observed context clearing in native Windows app.

**Changed:** Project/conversation transitions and source closure clear transient notices and selected source/finding context. A queued-follow-up or selected-region notice therefore does not continue as the status of an unrelated conversation.

**Observed:** After a status-refresh notice and a stopped review, opening another conversation/project removed the old transient notice rather than displaying it as that context’s current status.

**Native frames:** 1082.png, 1093.png, 1167.png.

### M3-15: Expanded coverage becomes a wall of repeated status rows

**Status:** Observed fixed in native Windows app.

**Changed:** The coverage panel explains the requested sheet × discipline × pass denominator and shows aggregate status counts by discipline. Detailed records default to Needs attention, with status/discipline filters and sheet search before opening a sheet. Only one sheet's records open at a time and detail pages contain at most 20 rows. Earlier-scope records are opt-in, requested totals do not change with filtering, and Not applicable stays separate from checked work. Completed reviews with unopened sheets or unsettled coverage explicitly say Review finished with coverage gaps; exports give actual opened/recorded/unopened/unreviewed counts before the narrative summary.

**Observed:** Opened the real Brewery result: the denominator remains 1276, the discipline filter reduced matching details to 116 Civil records, sheet search narrowed the list, and Next records moved through a sheet in pages of at most 20. Unreviewed work stays explicit and Not applicable has a separate column. The headline now names the coverage gap.

**Native frames:** 0886.png, 0918.png, 0921.png.

**Limits:** This change makes existing coverage navigable; it does not perform the unreviewed passes or validate the engineering correctness of self-recorded statuses. The standalone export retains its full static coverage table and follow-up list; the workbench's interactive filters and pagination do not apply to that export.

### M3-16: The direct Sheets entry disappears in a smaller desktop window

**Status:** Core navigation observed; compact receipt recheck pending.

**Changed:** Compact layouts retain a direct Sheets control and an active-project label. A More menu keeps New count check and Import PDF available when secondary top-bar controls are hidden. Synced/cancelled cloud receipts can be dismissed and are scoped to their owning conversation. Terminal cloud cards now show a compact status/context summary; transfer and review details require explicit expansion.

**Observed:** At a native900×900 window, the active project and Sheets remained visible. More exposed Import PDF and New count check. Terminal receipt details are now collapsed in source; its packaged compact view recheck is pending.

**Native frames:** 0969.png, 0972.png.

### M3-17: Windows shortcuts and singular counts use the wrong copy

**Status:** Native shortcut observed; short-note recheck pending.

**Changed:** Windows uses Ctrl K and Mac uses the command symbol. Counts use the appropriate singular/plural form. Both short summaries and full notes now render supported headings, bullets, bold and inline code through escaped Svelte text.

**Observed:** The Windows sidebar shows Ctrl K. Native single-call receipts show 1 review call. Short-note formatting was still missing in the earlier implementation; it now uses the escaped formatter and is awaiting the final native package check.

**Native frames:** 1145.png.

**Limits:** ReviewText supports a small safe formatting subset rather than all Markdown.

### M3-18: The completed cloud review calls supplied calculations and matrix missing

**Status:** Observed corrected fire-alarm result; semantic limits remain.

**Changed:** Review instructions require a content inventory, printed sheet identity, targeted detail inspection and a distinction between present-but-inadequate and absent calculations/matrices. Recognized absence claims must include absenceCheck data; the host rejects them unless every frozen source page was inspected in the current run, a cited location received a detail inspection and no contradicting evidence is declared. Recorded coverage is presented as an audit trail rather than a correctness certificate.

**Observed:** The repeated local and completed Baseten cloud fire-alarm reviews recognized the supplied battery/NAC tables and matrix rather than calling them absent. The saved cloud output reads the 8.90 Ah requirement and distinguishes incomplete/existing-system verification from absence. This is evidence for that supplied case, not a general guarantee of engineering correctness.

**Native frames:** 0552.png.

**Limits:** The gate checks host inspection records and the model's declared source-search/contradiction evidence. It does not independently determine whether a table is adequate or whether a location's descriptive label matches its pixels. Absence-claim detection uses a phrase pattern; this is not a general semantic verifier for every paraphrase of a missing-content claim.

### M3-19: There is no visible action to export the completed review report

**Status:** Observed fixed in native Windows app.

**Changed:** Saved packet-review panels expose Export review report beside the review actions. The trusted desktop chooser saves a standalone HTML report using the existing application export path, including scope/provenance, source and citation status, actual coverage, structured findings and embedded available evidence. Complete-workspace backup remains a separate action.

**Observed:** Used Export review report and the native Save dialog to save a9,771,955-byte standalone HTML file with embedded fire-alarm evidence. It is linked below and remains distinct from complete-workspace backup.

**Native frames:** 0552.png.

### M3-20: Normal cloud preparation surfaces an internal maintenance error

**Status:** Download navigation observed; upload recheck pending.

**Changed:** Read-only snapshots no longer use write admission or wait behind the network maintenance semaphore. They share the SQL exclusion needed for replacement and pending-recovery checks instead. Cloud preparation/sync can continue while snapshot refresh and project navigation read local data, so ordinary observer reads do not surface the write-maintenance error.

**Observed:** During the new live download, opened another saved conversation and inspected its failure while transfer counters continued advancing. The internal maintenance error did not appear. The upload sidebar issue was separately found and is awaiting its new native check.

**Native frames:** 1132.png, 1145.png.

### M3-21: Pause repeatedly fails with a stale-progress error and no Refresh action

**Status:** Observed fixed in native Windows app.

**Changed:** The backend accepts compatible idempotent pause/cancel controls across older progress versions. On a remaining control conflict the workbench fetches the current receipt and retries pause/cancel once only if that action is still compatible. A visible Refresh review action fetches the latest receipt directly. Resume and uncertain paid inference remain outside this control-command retry path.

**Observed:** Started a live local review and clicked Pause while it was running. The panel changed to Review paused; Refresh retained that state. Cancel then changed it to Review cancelled without resending inference.

**Native frames:** 1074.png, 1082.png.

### M3-22: An invalid package folder asks for recovery instead of explaining validation

**Status:** Observed fixed in native Windows app.

**Changed:** The restore chooser validates the selected package before asking to replace local projects. Missing/invalid manifests return a specific invalid-package explanation, say that the workspace has not changed and direct the user to choose another folder. Recovery wording is reserved for a restore operation that reports interruption after replacement work begins.

**Observed:** Selected the exported-report folder through the native restore chooser. The app said the folder is not a valid review package, identified its unexpected directory, directed another selection and said the workspace had not changed. No replacement confirmation appeared.

**Native frames:** 0966.png, 0969.png.

### M3-23: Governing sources hide the URL and have no open action

**Status:** Observed fixed in native Windows app.

**Changed:** Expanded governing-source records show the exact URL and retrieval time, an Open source in browser action for permitted HTTPS URLs and a Saved retrieved text disclosure. The trusted shell validates the external URL and opens it through the desktop. Source availability remains separate from each citation's substantive verification status.

**Observed:** Expanded the saved source text and inspected the exact URL and retrieval time. Clicked Open source in browser; the native browser loaded the matching Florida Building Code resource URL. Only the opened tab was then closed. Browser chrome is excluded from this report.

**Native frames:** 0948.png.

### M3-24: Over-limit Send to cloud silently saves the request and leaves an old synced receipt

**Status:** Capacity/feedback observed; project-only transfer unavailable.

**Changed:** Cloud packages have a bounded 1 GiB/5,000-file allowance and measured-size errors. Selecting cloud refreshes a read-only workspace estimate; a pre-send panel shows estimated MiB, files, project count and limits with Recheck size. Send is disabled while the estimate is missing or over limit. Final preparation still enforces exact package bounds. Start failures remain visible after snapshot refresh, while unrelated old terminal receipts are hidden by project/conversation scoping.

**Observed:** Before Send, the native composer displayed the whole-workspace scope, estimated504.5MiB,295files,7projects and limits. A later506.1MiB package actually uploaded and its506.3MiB return imported. Whole-workspace transfer remains mandatory; project-only transfer and an in-app reduction tool are not implemented.

**Native frames:** 1093.png, 1127.png, 1151.png.

**Limits:** Transfer still includes every project and its history. Project-only transfer, an in-app package reduction tool and a workspace-selection/creation flow were not added; over-limit guidance tells the user to export a backup and use a smaller workspace. The read-only estimate is not the final serialized package size and can become stale as the workspace changes. Exact preparation can still reject a package that exceeds the bound.

## Review completeness and provider evidence

The nine-image Baseten request reproduced HTTP400; eight images succeeded. The adapter retains the latest eight request images while durable metadata and artifacts retain all source history, and uses a five-minute request deadline. Uncertain paid requests are not replayed automatically. This resolves that reproduced provider rejection; it does not establish complete engineering coverage.

| Live local set        | Opened / supplied | Recorded passes | Findings | Calls |
| --------------------- | ----------------: | --------------: | -------: | ----: |
| Brewery               |           27 / 29 |       7 / 1,276 |       11 |    39 |
| Laundry               |           13 / 13 |        16 / 572 |       11 |    34 |
| Porch                 |             9 / 9 |        29 / 396 |       10 |    19 |
| Civil latest revision |             4 / 4 |        31 / 176 |       11 |    37 |
| Fire alarm discipline |             3 / 3 |         12 / 12 |        8 |    25 |

The completed Baseten fire-alarm cloud run returned seven findings and 12/12 passes in 30 calls. It recognized the supplied 8.90 Ah battery requirement, NAC tables and matrix. The native report export saved 9,771,955 bytes with embedded evidence. Larger results still have substantial coverage gaps; the workbench and exported headline now state the actual gap before the narrative.

A separate bounded reopened-cloud probe used the new conversation’s default Meta model and returned HTTP404 after 171 ms, before any tool execution. Its 506.1 MiB upload and 506.3 MiB / 298-file return demonstrate real transfer counters and result recovery, not a completed review or active-tool acceptance. The returned safe provider-failure receipt retained the HTTP status. That probe exposed the cleanup-message overwrite fixed above.

## Research, cost and proof limits

Research used Exa through Executor and primary sources. See [provider evidence](audit-3-review-reliability.md) and [Modal configuration](audit-3-cloud.md). The isolated audit image uses 4 CPU / 8 GiB hard caps, approximately $0.76/hour at the researched Sandbox rates, four times the former worker. Provider inference is separate. No production image tag or operator configuration was changed.

[Electron’s clipboard documentation](https://www.electronjs.org/docs/latest/api/clipboard), retrieved through Exa/Executor during the reopened audit, documents the asynchronous desktop clipboard methods and deprecated direct renderer access. The implementation awaits the trusted main-process write; it exposes no arbitrary clipboard reader or provider configuration to the renderer.

Workspace transfer remains atomic whole-workspace replacement. Project-only transfer and an in-app reduction tool are not implemented; the native composer now shows that scope, size and limits before Send. Transferring a project subset through the existing whole-workspace replacement protocol would risk dropping unrelated data. This limitation is explicit rather than counted as an implemented scope feature.

Transfer counters advance after each completed file or verified reused download. They are not within-file byte streaming, transfer throughput or a transfer-specific ETA. Host activity is the actual tool/stage/drawing record, not a claim about hidden model reasoning.

Automated verification and Sol review supplement the recorded native behaviors; they do not close a visual finding by themselves. The earlier six-round approval covers the previously submitted change. The reopened behavior diff requires a separate focused review before shipping. Final verification/review status is recorded at closeout.

All Windows observations used the isolated packaged audit app with Cua Driver 0.38.0, fresh accessibility snapshots and native file dialogs. The original workspace and original recordings remain preserved. Private raw evidence is under `.local/audit-3-fixes` and Windows Downloads `Moke-audit-3-fixes-2026-10-29`.
