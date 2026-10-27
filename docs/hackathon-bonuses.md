# Hackathon bonus priorities

Checked October 27, 2026 against the [participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) in the authenticated browser and the [Official Rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver).

Prioritize **Best Agentic Use-Case** and preserve a genuine **Meta open-weight review mode**. Reuse the finished demo for the viral and community opportunities. Do not add unrelated creative features to pursue another category. The main-track first-place entry remains the priority: impact 30%, Meta tooling 25%, execution 20%, and demo 25%.

The guide lists five bonuses totaling $50,000. The Official Rules reserve discretion over their categories, allocations and awards. The listed amounts are opportunities, not expected revenue; the reviewed material does not establish that multiple bonus wins can be combined.

## Opportunity assessment

| Bonus in the current guide            | Amount  | Fit for Moke                                                  | Decision and evidence needed                                                                                                                                                                                                                         |
| ------------------------------------- | ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best Agentic Use-Case                 | $5,000  | Strongest product fit                                         | Target directly. Show Muse deciding what evidence is missing, requesting a crop/SAM operation, interpreting the result and completing a useful check. Preserve actual tool receipts and the changed outcome.                                         |
| Best Build on Meta Open Weight Models | $10,000 | Strong if the model performs useful review work               | Retain an evaluated Muse Spark Open mode. The guide names Spark Open or Glimmer, served on own hardware or partner inference, and calls for verification of eligible model use.                                                                      |
| Most Viral Project                    | $20,000 | Distribution opportunity with little additional product scope | Prepare a concise public demo post for X after the working submission is stable. Submit its post link through the hackathon platform. The guide counts likes, reposts and comments through November 8 EOD; it does not specify the timezone for EOD. |
| Community Vote                        | $10,000 | Distribution and usability opportunity                        | Make the public gallery entry, video, sample and setup easy to understand. The guide limits voting to one per verified account and lists November 16 for the winner announcement.                                                                    |
| Best Creative Build                   | $5,000  | Weak fit with the current engineering scope                   | Do not pursue as a separate workstream. It rewards an original creative project using Muse Image or Muse Wonder. Using Wonder for reasoning alone does not establish that Moke meets the creative-project criterion.                                 |

These categories and judging descriptions come from the guide's bonus-prize section. The guide says open-weight and creative projects are flagged during judging; it gives an explicit post-link action for the viral award. Check the final submission fields and organizer announcements for any additional bonus-selection action. Do not assume that an SDK or infrastructure provider automatically enters a category.

## Best Agentic Use-Case

The bonus evaluates autonomy, effectiveness in completing a meaningful task and practical usefulness. Moke's proposed inspection loop provides a direct demonstration:

1. Muse finds that a candidate finding lacks a required fact.
2. Muse chooses a specific source region or evidence operation.
3. Moke validates the request and renders a crop directly from the original PDF.
4. SAM supplies candidate geometry where useful; the tool preserves source coordinates and evidence provenance.
5. The accepted facts drive a deterministic check. Moke produces a supported finding or a specific unresolved condition.
6. A reviewer correction or new revision changes the affected outcome while unrelated results remain intact.

The Meta model must make a meaningful inspection decision. A fixed sequence that invokes SAM and asks Muse to summarize the output would give weaker evidence for the award. Pi Durable supplies execution infrastructure; the new contribution is Moke's review behavior and evidence system. Record the actual sequence, prompt/model versions, timings and results for the demo and evaluation.

## Best Build on Meta Open Weight Models

The current configured partner route is Baseten's `meta-models/muse-spark-open-1026`. Keep that organizer-specific identifier explicit. Modal Endpoints or own-hardware inference are alternatives, but migrating the inference provider is not required to run the review engine in a Modal Sandbox. [Model setup](models.md), [inference setup](inference.md).

An eligible model should complete an end-to-end review case, making real inspection/tool decisions and producing a source-linked result. Keep provider/model identities, request and usage records, prompt versions, fixture hashes and the corresponding evidence artifacts. These records support the infrastructure partner's model-use verification described in the guide.

Compare Spark Open with the hosted Muse route on the same representative cases, using correct findings, unsupported claims, elapsed time and actual cost. Retain Spark Open as a supported mode only if it completes useful work reliably enough to demonstrate. A token greeting, an unused model toggle or a nominal call is not a credible open-weight build. SAM alone does not meet the named model requirement, and Pi/Modal usage does not replace it.

Do not weaken the main-track demo to chase this bonus. If the open-weight path cannot meet the evidence gate in time, document the limitation and present the strongest working Meta-powered review. Preserve the optional adapter boundary so this decision does not require a second product architecture.

## Launch preparation

Prepare one clear engineering story and reuse its evidence for the three-minute submission video, gallery entry and a shorter social clip. Lead with the drawing problem, show the actual finding, correction and revision recheck, and identify the Meta model's inspection decisions. Include the cloud handoff only when it is working and useful to the story.

For the viral category, plan an X post and submission of its URL through the portal. For community voting, provide clear setup instructions and a sample with appropriate sharing rights. Follow the platform's participation and voting rules. This documentation task does not publish social posts or submit an entry.

## Decisions carried into implementation

- Pi Durable owns the agent lifecycle; Effect owns application services, contracts and engineering state.
- Reviews execute locally by default. An explicit Continue in cloud action transfers a checkpoint to Modal Sandboxes with one active execution owner.
- Hosted inference and execution location remain independent choices. A local review may call Meta or Baseten; a Modal review may use those same endpoints.
- Best Agentic Use-Case is the primary bonus target. A genuine evaluated Spark Open review mode preserves consideration for the open-weight award.
- Viral and community work reuse the main demo. Creative-build work stays outside the planned scope.
- Keep Meta models central, original work identifiable, the repository public, and dependency/asset rights documented.

The [runtime decision](review-runtime.md) defines the local/cloud boundaries and validation gates. The [SDK comparison](research/agent-harness-comparison.md) records the alternatives and independent critique. The selected architecture and these source links are also recorded in `.project-kit/manifest.json`.
