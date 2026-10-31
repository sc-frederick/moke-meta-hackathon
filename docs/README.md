# Project documentation

Start with [Moke's README](../README.md) for the product, workflow, and screenshots.

## Setup and development

- [Development and testing](development.md): commands, smoke/Electron suites, and screenshot refresh.
- [Inference setup](inference.md): provider keys, canonical routes, and manual API checks.
- [Cloud reviews](cloud-reviews.md): Push to cloud, operator setup, sandbox lifetimes, and recovery limits.
- [Model reference](models.md): the Meta catalog and the Baseten hackathon endpoint.
- [Desktop builds and releases](deployment.md): packaging, CI, credentials, and runtime boundaries.
- [Data and recovery](data.md): SQLite migrations, consistent backups, complete packages, and restore behavior.
- [Demonstration fixture](fixtures/hero-case.md): supported issue, correction, unchanged control, and revision recheck.
- [Workbench design](../design/DESIGN.md): the Forge design system, its desktop adaptations, and asset licenses.

## Architecture and validation

- [Beta workflow](research/beta-implementation.md): conversations, sheet setup, reviewer acceptance, and product boundaries.
- [Beta validation](research/beta-validation.md): recorded desktop and packaged checks, screenshots, fixes, and limits.
- [Core validation](research/core-validation.md): recorded Meta/SAM receipts, recovery checks, and limits.
- [Review runtime](review-runtime.md): local ownership, Pi Durable, hosted inference, and cloud review scope.
- [Pi execution](research/pi-runtime.md): journals, request admission, controls, and crash recovery.
- [Review packages](research/review-packages.md): complete export/restore and interrupted replacement recovery.
- [SAM integration](research/sam-integration.md): image geometry, intent ledger, source fences, and proposals.
- [PDF packaging](research/pdf-packaging.md): renderer assets and historical packaging measurements.
- [Baseten rate limits and caching](research/baseten-rate-limits.md): measured key limits, 429 shape, session affinity and the request pacer.

## Drawing experiments

These studies record bounded development experiments. Captured model results are
not a benchmark for unseen drawings. Reproducing live requests requires provider
access and the separately supplied drawing pack.

- [SAM drawing experiment](segmentation-test.md): crop rendering, prompts, overlays, and coordinates.
- [Plumbing coordination](plumbing-segmentation.md): count experiments, corrections, and the offline worksheet.
- [SAM beyond plumbing](sam-drawing-expansion.md): electrical, lighting, HVAC, doors, and observed limits.
- [Adaptive Meta review](adaptive-meta-review.md): independent inventories, targeted zooms, and fresh SAM guidance.
- [Additional discipline sets](sam-expanded-sets.md): electrical, fire alarm, structural, and civil probes.

## Planning and provenance

These documents retain the decisions and source research behind the implementation.
For current behavior, use the setup, architecture, and validation documents above.

- [Product scope](../PRODUCT.md)
- [Core implementation plan](core-implementation-plan.md)
- [Implementation source research](research/core-implementation-sources.md)
- [Core council findings](research/core-council.md)
- [Agent harness comparison](research/agent-harness-comparison.md)
- [Hackathon bonuses](hackathon-bonuses.md)
- [Firm memory](firm-memory-plan.md): finding decisions, the firm checklist and
  jurisdiction leads are implemented; the full memory system is deferred. With
  [agent memory research](research/memory-sota-notes.md) and
  [AEC firm knowledge research](research/aec-firm-knowledge-notes.md)
- [Hackathon product audit](research/hackathon-product-audit.md): requirements and revision gaps as of October 30
- [Project choices and dependency provenance](../.project-kit/manifest.json)
- [Review prompt provenance](../backend/review/prompts/README.md)
