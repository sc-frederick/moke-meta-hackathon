# Moke

<!-- impeccable:product-schema 1 -->

## Platform

web

The project packages its Svelte interface in Electron for desktop use.

## Capabilities and Constraints

Use SvelteKit 3 and Svelte 5 from the project kit. The production workbench imports
PDFs, reviews findings, and preserves evidence and execution history locally.

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

The research conversation and findings in that study are sample content. The
prototype does not call a model or connect to application services.

## Brand Commitments

The user named OpenCode, T3 Code, and Cloudflare OS as visual references, with
particular emphasis on T3 Code's desktop polish. The latest study adapts the
Nightdesk template after reviewing the live Uiverse catalog. The final product
theme remains subject to review.
