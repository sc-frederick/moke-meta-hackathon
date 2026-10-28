# Moke review instructions

`assets/` contains unmodified files from `sc-frederick/skills/moke-review` at
revision `8a0e2648738018631eaa6d24ee0b6ebaa239afb1`. `provenance.json` records
their upstream paths and SHA-256 hashes. Read the original skill repository to
update them; do not edit the upstream repository from this application.

`review-prompt.ts` imports these files with Bun's text loader. They are embedded
in the compiled backend and require no runtime access to a skills checkout.
Version `moke-selected-coordination-v2` combines the master instructions, shared
inspection method, General, and the requested discipline. Fire Alarm, Fire
Sprinkler, Life Safety, and Fire Protection remain separate routes.

The runtime adaptation takes precedence over the full skill's wider workflow.
It uses the existing selected-finding count engine and its PDF/crop/SAM tools.
It cannot browse official sources, verify governing editions or regulatory
claims, complete a permit review, or accept engineering facts. Missing source
material remains Needs input. Model tools propose counts and retain source and
provider provenance; a reviewer must accept facts and confirm coverage before
the application's deterministic count comparison can support a finding.

Report rendering and browser-local completion rules remain in the app/report
layer. The original shared method is preserved here in full, but its Report and
release section is excluded from model instructions. This engine does not
generate a complete HTML permit-review report; the existing offline fixture
worksheet remains a separate report path. Complete packages retain the database,
source artifacts, review history, and execution journals.

Migration 0007 appends the prompt version and frozen request context to execution
runs. Reviewer sends first save a message with the existing command receipt,
then start an inspection bound to that message and conversation. Failed provider
admission reports that the message was saved; it does not resend automatically.
Responses go back to that conversation. Old runs and proposal records remain
readable; a paused run from an earlier prompt cannot resume under new instructions.
Cancel it before explicitly starting a new inspection.

If the provider answers without calling a message tool, the terminal answer is
saved through the same source/fact fence as conversation prose. Long answers are
shortened to fit the message limit; the complete provider receipt remains in the
execution journal. None of these paths accepts facts or changes coverage.
