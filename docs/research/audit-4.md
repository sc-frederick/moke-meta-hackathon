# Audit 4

Read-only audit of main at `68deb4910` on 2026-10-31 by three gpt-6-astra
auditors on xhigh. Each wrote one ledger:

- [Inference and review harness](audit-4-harness.md): H-01 to H-12.
- [Platform, desktop and scripts](audit-4-platform.md): P-01 to P-15.
- [Renderer and tests](audit-4-renderer-tests.md): R-01 to R-08, T-01 to T-05.

## Decisions

- **H-12, automatic SAM zoom on every finding:** kept. PR #21 made per-finding
  zooms the intended behavior. H-03 still isolates a failed zoom to its sheet.
- **R-01, R-03, R-08:** fixed as the ledger recommends. They restore existing
  ownership rules and change no intended behavior.
- **R-02, draft text:** the composer stays editable, and text typed while a send
  is pending is kept.
- **P-14, one-minute cloud timeout:** the impossible setting now fails before
  any allocation or upload, with a specific message. The setting's range is
  unchanged until the user decides between a longer minimum and a full minute
  of review after setup.
- **P-15, terminal cloud package retention:** not changed. It needs a retention
  policy from the user.

## Work split

Fixes were implemented by Claude Opus 5.5 in separate worktrees, grouped so no
two implementers edited the same source file:

| Owner                                      | Findings                                       |
| ------------------------------------------ | ---------------------------------------------- |
| Packet service                             | H-01, H-02, H-03, H-04, H-11                   |
| Provider and pacing                        | H-07, H-08, H-09, H-10, T-05 (provider tests)  |
| Review operations, store and documents     | H-05, H-06, R-03, P-01, P-02, T-02             |
| Renderer                                   | R-01, R-02, R-04, R-05, R-06, R-07, R-08, T-03 |
| Platform                                   | P-03 to P-14                                   |
| Test organization, after the others merged | T-01, T-04, T-05 (active-duration tests)       |
