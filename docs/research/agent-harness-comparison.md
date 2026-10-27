# Agent SDK options for Moke

Research date: October 27, 2026. Status: comparative recommendation; no runtime or dependency change.

Decision update: the selected direction is Pi Durable with local execution by default and explicit handoff to Modal Sandboxes. See [Review runtime and cloud handoff](../review-runtime.md) for the architecture, verified hackathon requirements and scoring priorities. Cloudflare PiHarness remains a researched alternative.

Moke needs a local agent runtime for lengthy drawing reviews: inspect selected PDF crops, request additional evidence through SAM, run deterministic checks, accept reviewer corrections, and recover after interruption. Electron owns the desktop interface and trusted bridge; the compiled Bun backend owns application services and SQLite. The project currently pins Effect 4.0.4 and Bun 1.4.4.

For the hackathon, **Pi Durable behind an Effect application service is the preferred candidate**. It already supplies the agent lifecycle and its recovery policy. **Effect AI plus Effect Workflow is the strongest native alternative**, but assembling the conversation loop, durable work admission, recovery policy, context management and progress projection is more work than adding provider Layers. The choice remains conditional on a small recovery and packaging experiment with Moke's actual provider routes.

## What the SDK must own

Three responsibilities need separate evaluation:

1. Model access: images, tool schemas, streaming, structured output, reasoning continuity, and provider-specific request options.
2. Agent execution: conversation history, repeated model/tool turns, limits, cancellation, context management, and visible progress.
3. Durable execution: persisted work identity, completed results, recovery of unfinished tasks, human waits, and replay policy.

A persisted transcript alone does not make an interrupted tool safe to execute again. A durable workflow cannot determine whether a paid provider call succeeded if the process died before recording its response ID. The harness also cannot replace Moke's source hashes, coordinate transforms, accepted-fact versions, dependency invalidation, or deterministic engineering checks.

## Comparison

The fit judgments below are architectural assessments, not measured performance results.

| Option                                  | Existing model and agent features                                                                        | Persistent execution                                                                              | Integration cost for Moke                                                                                              | Assessment                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Effect AI and Workflow                  | `LanguageModel`, `Chat`, `Tool`, `Toolkit`, Effect Schema and provider Layers                            | `Workflow`, `Activity`, `DurableDeferred`; SQL-backed `ClusterWorkflowEngine` with `SingleRunner` | Application loop plus durable admission, recovery policy, context limits and activity design                           | Strongest native alternative; substantial harness assembly remains                            |
| Pi Durable                              | Complete agent turns, tool tasks, queued inputs, retries, compaction, streams, usage and extensibility   | Committed transcripts and task state; SQLite, JSONL and custom storage                            | Chord/Effect lifecycle bridge, TypeBox/Schema boundary, Bun storage facade, domain-state reconciliation                | Preferred hackathon candidate; experimental API is the main concern                           |
| LangGraph JS                            | Explicit graph execution, conditional routing, interrupts and state inspection; model access is separate | Checkpointers, including SQLite; `sync` durability stores checkpoints before the next step        | Introduces graph state and a second runtime model; native storage packaging and actual provider routes need validation | Strong candidate when branching and human intervention dominate                               |
| Mastra durable agents                   | Agents, tools, harness features, memory, observability and workflows                                     | Native durable-agent recovery is opt-in; libSQL can use local files                               | A broader framework and storage system; embedded startup/recovery integration remains application work                 | Credible broader alternative, especially if its harness features save substantial UI work     |
| AI SDK `ToolLoopAgent`                  | Provider abstraction, tool loop, stop conditions and structured output                                   | In memory without another execution layer                                                         | Straightforward inference integration; durable execution still needs a separate choice                                 | Useful model/loop library, insufficient by itself for the intended recovery contract          |
| AI SDK `WorkflowAgent` and Workflow SDK | Durable agent loop and persistent approvals                                                              | Workflow steps and a configured World; local and community Turso/libSQL Worlds exist              | Build transforms, generated queue/webhook handlers, World configuration and compiled-backend packaging                 | Viable with Bun, but adds build/runtime integration to this starter                           |
| Cloudflare Agents with PiHarness        | Pi Durable harness hosted in a Durable Object                                                            | Durable Object SQLite and alarm-driven wake-up                                                    | Requires a hosted execution component and a protocol for accessing local drawing evidence                              | Attractive for later remote execution or reviews that must continue after desktop exit        |
| Restate with an agent SDK               | SDK integrations plus journaled model and tool steps                                                     | Restate Server coordinates durable service handlers                                               | Adds a separate server/service lifecycle                                                                               | Strong server-side durability option; less suitable for the current desktop-only architecture |

Sources: [Effect AI](https://effect.website/docs/v4/api/effect/ai/LanguageModel), [Effect SingleRunner](https://effect.website/docs/v4/api/effect/cluster/SingleRunner), [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), [LangGraph checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [Mastra durable agents](https://mastra.ai/docs/harness/durable-agents), [AI SDK agents](https://ai-sdk.dev/docs/agents/building-agents), [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent), [Cloudflare Pi](https://developers.cloudflare.com/agents/harnesses/pi/), [Restate durable agents](https://docs.restate.dev/ai/patterns/durable-agents).

## Effect already provides substantial infrastructure

The vendored reference at Effect revision `e17ecdbe902aa7108f775c8ab9c0ddf9f38801ab`, recorded in `.project-kit/manifest.json`, contains the following APIs in Effect 4.0.4:

- `effect/ai`: `LanguageModel`, `Chat`, `Tool` and `Toolkit`, with Schema-based tool parameters and results.
- `@effect/ai-openai-compat`: a dedicated Chat Completions and embeddings integration with configurable `apiUrl`. This is the relevant initial adapter for OpenAI-compatible chat routes.
- `@effect/ai-openai`: the OpenAI-specific provider, including Responses-oriented functionality. Compatibility with Meta's particular Responses implementation must be tested rather than inferred from a matching endpoint name.
- `effect/workflow`: `Workflow`, `Activity`, `DurableDeferred`, `DurableClock` and `WorkflowEngine`.
- `effect/cluster`: `ClusterWorkflowEngine` and `SingleRunner`, allowing SQL-backed workflows in one embedded process. A distributed deployment is not required.

Effect's own chat example implements repeated model/tool turns with a short explicit loop. Tool execution and chat history are provided; application policy decides when to stop. `Chat` persistence saves conversation history, while `Workflow` and activities supply the execution journal. A memory-only engine does not satisfy crash recovery.

The short loop is not the total integration cost. Moke would also need durable input admission, retries and uncertain-attempt policy, interrupted-tool behavior, context limits, and a recoverable progress view. `SingleRunner` brings SQL-backed cluster mailboxes and a long-lived runtime. The current application opens scoped SQL connections per operation and serializes backup/restore through one semaphore. Integrating a persistent workflow runner requires an explicit ownership design; it is not a drop-in addition to the current database Layer.

For Moke, each model request and each evidence operation should have its own durable identity. Keep model generation separate from tool execution when those need distinct recovery boundaries. `LanguageModel` exposes `disableToolCallResolution` for this separation. Wrapping an entire multi-call review in one activity would replay too much unfinished work.

Activity results are memoized after completion. An unfinished or suspended activity can run again, so external calls and domain writes still need reconciliation or idempotency. AI and workflow modules are marked unstable: pin versions and use the matching reference source. This is a native solution, not a promise of a turnkey durable agent product.

Sources: [Effect Chat](https://effect.website/docs/v4/api/effect/ai/Chat), [Toolkit](https://effect.website/docs/v4/api/effect/ai/Toolkit), [OpenAI-compatible provider](https://effect.website/docs/v4/api/ai-openai-compat), [ClusterWorkflowEngine](https://effect.website/docs/v4/api/effect/cluster/ClusterWorkflowEngine). Matching local references: `repos/effect/ai-docs/src/71_ai/30_chat.ts`, `packages/effect/src/workflow/Activity.ts`, `packages/effect/src/cluster/SingleRunner.ts`, and `packages/ai/openai-compat/src/OpenAiClient.ts` under `repos/effect`.

## Pi Durable is a serious alternative

Pi Durable is separate from the Pi coding-agent SDK. It is intended for general agentic applications and already owns the conversation/tool lifecycle that Moke would otherwise assemble. Its README explicitly marks the API experimental. The fetched main-branch package manifest reports version 1.4.0; that does not establish the version currently published to the package registry.

Its durable task model is particularly relevant: input admission, model generation and tool execution are persisted as distinct work. A repeated input `requestId` returns the same submission. On restart, completed committed results remain available; interrupted model requests can be retried. An interrupted tool reruns only when declared `replay: "safe"`; otherwise the model receives an interruption result. A safe declaration still requires the tool to implement safe behavior.

The portable SQLite core can run on Bun with an asynchronous `SqliteDatabase` facade. The documented ready-made local adapter is for Node; a Bun integration must implement and verify the facade or use another supported storage path. Storage requires a single owning process. The Node SQLite adapter uses WAL with `synchronous = NORMAL`, so process-crash recovery and power-loss durability are different guarantees.

Pi AI already includes separate Meta and Baseten providers. The Meta factory uses Responses and reads `META_API_KEY`; Moke currently uses `MODEL_API_KEY`, so the integration must map credentials explicitly. Baseten uses Chat Completions and `BASETEN_API_KEY`. The organizer-specific `meta-models/muse-spark-open-1026` model must remain explicit even if a catalog uses a different default.

Pi uses Chord Context for cancellation/telemetry and TypeBox for tool schemas. Effect would still own Moke's service lifecycle, domain operations, errors and validation. One adapter must translate between the two systems. Do not run an Effect durable agent loop and a Pi durable loop over the same work: choose one execution owner.

Pi storage also changes resource ownership. Prefer a dedicated harness database initially, with one owner, rather than bypassing Moke's existing recovery serialization on `app.sqlite`. Domain updates and harness receipts then span two stores: every mutating tool needs a stable operation ID and idempotent result lookup so a crash between those writes cannot duplicate an accepted fact or finding. Project export/restore must include a consistent harness snapshot and stop or quiesce the owner before replacement. Separating databases simplifies connection ownership; it does not provide cross-database atomicity.

Keep PDF rendering and image coordinates in Moke's application pipeline. Pi's optional coding-tool image reader has its own resizing rules and is not the intended entry point for engineering crops. Pi's hooks can block a tool, but the checked Cloudflare integration documents no built-in approval/permission workflow; persistent reviewer decisions remain explicit application state.

Sources: [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), [author's introduction](https://earendil.com/posts/pi-durable/), [Pi AI](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md), [Meta factory](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/meta.ts), [Baseten factory](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/baseten.ts), [package manifest](https://github.com/earendil-works/pi/blob/main/packages/durable/package.json).

## Important qualifications for other options

LangGraph's persistent checkpointer and its durability mode are separate settings. For preserving each completed boundary before the next step, use `sync`, not `exit`. SQLite is documented for local workflows; Moke's compiled Bun distribution still needs an actual driver and packaging test. Graph checkpoints do not automatically version accepted drawing facts or invalidate downstream engineering results.

Mastra now documents a dedicated durable-agent facility, beyond ordinary workflow suspend/resume. Default `recovery.durableAgents: 'off'` skips normal per-step running checkpoints. Automatic recovery requires `recovery.durableAgents: 'auto'` and the corresponding startup path. Its docs explicitly warn that recovery can reissue paid model calls and tools, and that a delegated subagent can replay as a whole. Local libSQL is supported, but an embedded host must own recovery and shutdown.

The current AI SDK durable class is `WorkflowAgent` from `@ai-sdk/workflow`, replacing `DurableAgent`. It requires Workflow 5. There is a documented Bun integration with generated handlers and an SWC transform, and the Worlds catalog lists an embedded Turso/libSQL backend. It is therefore inaccurate to describe it as Vercel-only or incompatible with Bun. Its integration footprint is simply larger than adding an ordinary model SDK to the current compiled backend.

The current first-party Local World documentation also describes file-backed workflow state and startup re-enqueue of active runs, enabled by default through `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS`. Interrupted inline steps are released and retried according to their retry limits. The host assumes one active owner for the data directory. This corrects the critic's claim that Local World's queue cannot recover after restart. The Local World is positioned for development; these recovery features alone do not establish suitability for a packaged production desktop app. [Local World configuration and recovery](https://workflow-sdk.dev/worlds/local)

Cloudflare's `PiHarness` is a separate deployment option for Pi Durable. Its documented limits include no built-in tool approval step, snapshot-based event reconnect, and a 15-minute alarm invocation limit that can interrupt a single very long streaming model call. The desktop application would need to serve selected local evidence to hosted work. This option becomes more useful if review execution must continue while the desktop is closed.

Sources: [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Mastra durable recovery](https://mastra.ai/docs/harness/durable-agents#crash-recovery), [Mastra local libSQL](https://mastra.ai/integrations/databases/libsql), [WorkflowAgent migration](https://ai-sdk.dev/docs/agents/workflow-agent), [Bun integration](https://workflow-sdk.dev/docs/how-it-works/framework-integrations), [Worlds catalog](https://workflow-sdk.dev/worlds), [Cloudflare Pi limits](https://developers.cloudflare.com/agents/harnesses/pi/).

## Recommended decision and proof

Use **Pi Durable as the first candidate to validate for the hackathon**. Keep Effect as the application runtime and expose the harness through an application-owned service. This buys an existing recovery-aware agent lifecycle while retaining the selected SQL, RPC, Schema and domain services. Effect AI plus Workflow remains the alternative if Pi's Bun facade, provider behavior or lifecycle bridge proves more costly than the native assembly. Both have unstable APIs; architectural consistency alone is not evidence of lower delivery effort.

Pi owns model turns, conversation context, tool scheduling, task retries and its journal. Effect owns project authorization, PDF rendering, SAM operations, accepted facts, rule calculations and dependency invalidation. The harness sees narrow tools such as render region, segment region and run check. A SAM call remains a dedicated provider operation inside a tool; neither a generic Chat Completions adapter nor Pi's Muse provider should be assumed to implement SAM's response format. The UI consumes Moke's typed progress and result contracts.

For a longer-lived product, keep that boundary while the review behavior becomes clear. Reconsider a native Effect harness if concrete maintenance experience shows the Chord, TypeBox and experimental API costs exceed the native implementation cost. The subsequent runtime decision selects Modal Sandboxes for explicit cloud handoff; Cloudflare PiHarness remains an alternative, not a second cloud runtime.

The deciding experiment should use the same narrow operation on each serious candidate: ask Muse to inspect an overview, request a crop, call a fake deterministic evidence tool, then produce a typed result. First use a controllable local provider for crash injection; then verify a small real image-and-tool round against Meta and Baseten with explicit model IDs. Provider compatibility must include tool results, structured output, reasoning continuity, cancellation and response-ID handling, not just a successful text greeting.

Kill and reopen at these boundaries: before model submission, after submission before receipt persistence, after a committed model tool call, during a tool, and after its domain write before the harness receipt. A reviewer correction must create a new fact version, stop stale output from becoming current, and recheck only dependent work. Verify the compiled Bun executable on the target desktop platform.

Pass criteria: completed paid work is not deliberately repeated; uncertain paid attempts are visible and reconciled before retry; committed findings are unique; interrupted operations obey their replay policy; cancellation reaches owned work; original evidence transforms survive; reopening persisted state requires no hosted orchestration service. Subsequent model calls still require provider access. Local execution resumes when the backend is running again. Continuing while the app is closed requires a separately selected daemon or hosted runtime.

## Independent critique

Grok 4.6 independently reviewed the comparison and the matching Effect source. The findings and their disposition follow.

Accepted findings:

- The draft understated the work remaining after composing Effect AI and Workflow. Existing components do not by themselves provide Pi's complete durable agent lifecycle. This changed the hackathon recommendation to Pi first.
- SQL ownership is an integration concern for both candidates. A persistent harness must cooperate with the current scoped queries, backup and restore behavior. A separate journal still needs reconciliation with domain writes.
- Provider choice must be per operation. Muse reasoning, Baseten's hackathon route and SAM segmentation must each be verified; a working text greeting does not establish compatibility.
- A framework's durable features need their actual startup and persistence configuration. Mastra's recovery default and Workflow SDK's required transforms materially affect integration.

Rejected or narrowed findings:

- Grok said Local World cannot recover an in-memory queue. The current first-party page explicitly documents startup recovery of active runs and abandoned inline steps. The report retains WorkflowAgent as viable and judges its build/runtime cost separately.
- Lack of a turnkey Effect agent does not imply lack of durable resume primitives. Effect Workflow does provide resume, activities and durable waits; the missing piece is an assembled agent lifecycle.
- Pi's Node SQLite settings do not establish the power-loss behavior of a future custom Bun facade. The facade's settings and transaction behavior must be specified and tested.

The critic proposed a day per candidate. For the hackathon, begin with a bounded Pi integration experiment and use native Effect as a fallback candidate, rather than spending two full days benchmarking frameworks before producing review evidence. This sequencing is a delivery judgment, not a measured estimate.

## Research scope

Discovery used Exa and page retrieval used Firecrawl through Executor. Substantive claims rely on first-party documentation and the project's matching Effect source. No inference SDK was installed, no paid model probe was run, and no performance ranking was measured. Remaining uncertainty concerns provider conformance, cross-platform compiled Bun packaging, crash behavior in Moke's actual integration, and the adoption cost of each runtime.
