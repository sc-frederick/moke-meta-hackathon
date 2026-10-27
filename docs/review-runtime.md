# Review runtime and cloud handoff

Decision recorded October 27, 2026: use **Pi Durable for agent execution**, behind an Effect application service. Reviews execute locally by default. An explicit **Continue in cloud** action transfers a review to a **Modal Sandbox** running the same versioned engine. Effect continues to own application contracts, project operations, PDF and SAM tools, accepted facts, calculations and dependency invalidation.

This selects the architecture. Pi's Bun integration, provider behavior, storage adapter and packaged handoff still require implementation and validation. The [SDK comparison](research/agent-harness-comparison.md) records the alternatives and independent critique.

## Local and cloud responsibilities

| Component       | Local review                                                         | Review continued in cloud                                                            |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Desktop         | Electron and Svelte workbench, local project and review controls     | Same workbench reconnects to the remote review and imports its accepted results      |
| Review engine   | Bun, Effect services and Pi Durable on the user's machine            | Matching Linux build in a Modal Sandbox                                              |
| Agent journal   | Local persistent Pi storage with one owner                           | Restored journal with one cloud owner and an explicit durable checkpoint destination |
| Source evidence | Original PDFs, selected sheets, crops, transforms and content hashes | Explicitly transferred source package sufficient for subsequent crop requests        |
| Model calls     | Meta Model API or eligible partner inference                         | Same selected model route unless the user explicitly changes it                      |

Local execution describes the engine and project state. The planned Meta/Baseten model calls still send selected evidence to hosted inference. Moving inference weights onto the user's hardware is a separate choice. Modal runs the review engine; moving the engine does not itself require moving model serving.

Cloudflare PiHarness is an alternative considered during research, not the selected cloud path. Modal is the selected provider for this handoff. A local review does not require a running Modal Sandbox or a permanent cloud copy of the project.

## Checkpoint handoff

Transfer application state at a safe boundary rather than migrating live process memory:

1. Stop admitting new work locally and drain the active model/tool operation to a recorded boundary. Reconcile uncertain paid requests before transferring them.
2. Produce a consistent review package: run and handoff IDs, engine/schema/prompt versions, Pi journal, domain checkpoint, accepted-fact versions, provider response IDs, artifact manifests and the required original source sheets. Flush or back up SQLite consistently; do not copy an open database without its WAL state.
3. Upload the package and start the matching Linux engine in a Modal Sandbox. Supply credentials separately through the selected secure cloud configuration; exclude local `.env` files and OS credential data from the package.
4. Record remote acceptance and transfer execution ownership. The local executor remains stopped for that run. Preserve one active owner using an authoritative handoff record and generation checks; copying an owner field into two databases does not provide fencing.
5. Reconnect the workbench to progress and results. The remote engine can continue after the desktop disconnects, subject to its configured lifetime and persistent recovery design. Reviewer corrections go to the current execution owner and invalidate affected fact versions.
6. Import results with source/version checks and stable operation IDs. Returning execution locally requires a corresponding confirmed ownership transfer. A lost connection must not automatically start a second local executor.

Every domain-changing tool needs an idempotent operation ID and stored result so a crash between a domain write and its Pi receipt can be reconciled. Historical findings remain available, while results based on superseded facts cannot become current. Journal and domain checkpoints must describe the same accepted boundary. These are application responsibilities in both execution locations.

The handoff control should identify which source sheets and artifacts leave the device, show the transfer state, and report the actual execution location. Preserve the local project if an upload or startup fails. Do not claim that execution continues in cloud until remote acceptance is durable.

## Modal lifecycle and storage

Modal documents Sandboxes that continue running after a client detaches, configurable lifetimes up to 24 hours, filesystem snapshots, and mounted Volumes. Configure a review-appropriate lifetime; the documented default is only five minutes. Checkpoint before expiry and retain enough external state to launch a replacement Sandbox. [Sandbox lifecycle](https://modal.com/docs/guide/sandboxes), [snapshots](https://modal.com/docs/guide/sandbox-snapshots).

A Pi commit to a Sandbox filesystem is not automatically a recoverable checkpoint after the Sandbox itself is lost. The storage integration must define when a checkpoint has reached durable storage outside that Sandbox. Until verified, distinguish process-restart recovery from Sandbox-loss recovery.

Use a single owner for the active SQLite database. Persist consistent closed or backed-up checkpoint files with explicit acknowledgement. Modal Volumes have commit/reload semantics and document last-writer-wins behavior for conflicting file modifications; they do not provide distributed file locking. Do not use a shared live SQLite file as the ownership protocol. Snapshots have retention limits, so retention must be configured for the review rather than assumed indefinite. [Volume consistency](https://modal.com/docs/guide/volumes), [snapshot retention](https://modal.com/docs/guide/sandbox-snapshots).

## Hackathon eligibility

The current [Official Rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) explicitly permit open-source components when licenses are followed and the submission builds on the underlying product. Pi Durable's [package manifest](https://github.com/earendil-works/pi/blob/main/packages/durable/package.json) declares MIT. Keep applicable notices, identify Pi as a dependency, and clearly distinguish Moke's new engineering workflow from the underlying harness.

The [participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details), re-read in the authenticated browser on October 27, requires meaningful Meta-model use and explicitly lists Modal resources including Sandboxes. The [public event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) also lists Modal as a partner. The reviewed rules do not require an exclusively Meta-owned SDK or infrastructure stack, and do not specify a scoring deduction for Pi or Modal. This supports the proposed combination; it does not guarantee any judging score.

Keep the repository public, distinguish the reused Moke name and review prompts from new event work, use source drawings and assets with appropriate rights, and make the submitted three-minute demo show the new implementation. Do not present Pi's existing harness features as original Moke work. The original contribution is the drawing-review application, evidence handling, corrections, revision behavior and portable review execution.

## Competing for first place

The Official Rules and current guide assign 30% to impact, 25% to Meta AI tooling, 20% to technical depth and execution, and 25% to the demo. The following is the proposed evidence for those criteria, not a prediction of awarded points.

| Criterion                | Evidence to demonstrate                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact, 30%              | A practitioner-relevant finding, the verification effort it saves, a corrected false alarm and a useful revision recheck                    |
| Meta tooling, 25%        | Muse selects a missing fact and inspection action, requests a precise PDF crop, uses SAM evidence, and changes the supported outcome        |
| Technical execution, 20% | Accurate source transforms, typed tool results, fact-version invalidation, honest uncertainty, recovery and one-owner local/cloud handoff   |
| Demo, 25%                | Actual recorded model/tool activity, legible evidence, polished narration, a working live interaction and truthful elapsed-time transitions |

Keep Meta models responsible for meaningful perception and inspection decisions. Keep calculations explicit and testable. A deterministic script that merely displays a model summary would provide weaker evidence for the Meta-tooling and agentic criteria.

Prioritize Best Agentic Use-Case and retain a genuine evaluated Spark Open review mode for the open-weight category. Reuse the main demo for the viral and community opportunities; creative-build features remain outside the planned scope. The [bonus assessment](hackathon-bonuses.md) records all five categories, amounts, eligibility evidence and launch actions, subject to the organizer discretion in the Official Rules.

Prioritize the main track over adding nominal integrations for bonus categories. Build the complete local review and start collecting real footage early. Keep the engine portable from the start, then add one narrow checkpoint handoff. The cloud scene earns its place by showing a useful review survive a desktop disconnect and reopen with the same evidence, rather than by adding infrastructure logos to the demo.

## Validation gates

- Complete a real Muse image-and-tool round and SAM operation through the selected providers, preserving reasoning continuity and response identities where supported.
- Kill the compiled Bun engine around model submission, response persistence, tool execution and domain-result acknowledgement; reconcile uncertain calls and prevent duplicate findings.
- Transfer a checkpoint to the Linux Sandbox engine and prove that the local executor cannot continue the transferred run.
- Disconnect and reopen the desktop, then verify the remote review and source-linked results.
- Destroy the Sandbox and recover from the last acknowledged external checkpoint, with any possible lost progress stated precisely.
- Apply a reviewer correction or new PDF revision and verify that stale remote output cannot overwrite current facts.

No resources were provisioned and no paid model probes were run while recording this decision.
