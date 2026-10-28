# Moke

<!-- impeccable:product-schema 1 -->

## Platform

web

The project packages its Svelte interface in Electron for desktop use.

## Capabilities and Constraints

Use SvelteKit 3 and Svelte 5 from the project kit. The production workbench imports
PDFs, runs bounded selected-count inspections, and preserves evidence and execution
history locally. Bun and Effect own APIs, SQLite, migrations, and the Pi Durable
journal. Electron owns the trusted bridge, file dialogs, and credential storage.

Reviewer messages start inspections using the selected finding, discipline, and
versioned Moke instructions. Models propose counts against original drawing crops;
reviewers accept inputs and confirm coverage. Deterministic checks compare drawn
and scheduled quantities. Code citations remain unverified, and the beta does not
perform complete permit reviews or generate complete permit reports.

## Operating Context

The original interactive desktop UI study established chat as the main work
surface. Project information and findings live in a rounded popover at the top
right, using T3 Code's information menu as the reference. Selecting a finding
opens its source in a right-hand pane while preserving the conversation.
Closing that pane restores the chat's width. The user referenced the existing
result-to-evidence behavior in the `aec_pgrep` codebase.

For AEC industry users, projects are the primary navigation groups. Each project's
conversations remain nested beneath it. Selecting a conversation updates both the
project and conversation in the breadcrumb.

The separate design study contains sample content. The application uses persisted
projects, conversations, findings, and source evidence. Sheet confirmation and
revision correspondence stay explicit. Exported review packages retain the source
artifacts and execution journals needed to recover the work.

## Brand Commitments

The user named OpenCode, T3 Code, and Cloudflare OS as visual references, with
particular emphasis on T3 Code's desktop polish. The latest study adapts the
Nightdesk template after reviewing the live Uiverse catalog. The beta adapts that
selected design with light and dark appearances, compact navigation, and an evidence
panel beside the conversation.
