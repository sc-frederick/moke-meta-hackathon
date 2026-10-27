# Chat and findings

Mode: Operate. The conversation occupies the main window. A compact header menu
holds workspace context and findings. Choosing a finding reveals its source on
the right. The chat, draft, and scroll position survive selection and closing.

## Reference and material

The study adapts [Nightdesk](https://uiverse.io/design/systems/nightdesk), inspected
on 2026-10-27 alongside Caliper in the live Uiverse catalog.

Nightdesk's neutral surface ladder and compact controls fit a desktop chat tool.
Caliper was also considered; its instrument and gauge vocabulary is less relevant
to conversations and source reading.

Use Nightdesk's shell, panel, raised, and hairline tokens. Color indicates status.
The light appearance is a companion adaptation of the same neutral hierarchy.
Increase small text contrast relative to the reference. Keep the existing system
UI font and Tabler outline icons throughout this study. These adaptations retain
the native desktop character of the user's T3 Code reference. The rounded
popover follows the supplied screenshot and supersedes the template's flat panel
treatment for this specific overlay.

`project-kit design nightdesk .` imported the licensed archive. The original
DESIGN.md, CSS, HTML, and license remain intact in the ignored
`design/reference/nightdesk/` directory. `design/selection.json` records the
archive revision. Reference source is not included in public distributions.

## Behavior

- Conversations are nested under collapsible project folders on the left. The
  selected project appears in the breadcrumb and findings menu. New conversations
  belong to that project. Navigation can be hidden on wide windows.
- The top-right trigger opens a native top-layer popover with the project name
  and the three sample findings.
- Selecting a finding dismisses the popover and opens that source on the right.
  Source provenance, excerpt, and explanation stay together.
- On narrower desktop widths, opening a source hides the conversation sidebar
  to protect the chat's reading width. On phones, the source is a dismissible
  side sheet.
- Outside click and Escape dismiss the native popover. Escape closes search or
  the selected source when the popover is closed. Closing the source restores
  focus to its header trigger.
- Dark and light appearances share the same interaction. The theme toggle lives
  in the header; there are no separate mockup controls or explanatory captions.
- Search filters findings and source names. Ctrl/Cmd K opens search; Ctrl/Cmd N
  starts a new local conversation. Sample messages stay in memory.

## Typography and spacing

The header follows the supplied T3 Code screenshot: project icon and name,
slash, and current conversation on one baseline. Navigation and menu labels use
13px type; chat text uses 15px with a 1.75 line height. Source titles use 18px,
source prose uses 13px, and code uses 12px. Narrow layouts truncate navigation
labels instead of reducing their font size.

The popover has 16px outer padding, 12px row padding, and rows at least 48px high.
It sits 18px below its trigger. A single project row and divider group the
findings; source names remain available through tooltips and the source panel.
Remove repeated context labels, synthetic timestamps, date dividers, status
captions, helper footers, and explanatory subheadings from the interface.

Project folders are meaningful navigation, not decorative subheadings. Preserve
the project-to-conversation hierarchy for AEC users. Riverside office and Maple
residence are illustrative project names used to show multiple groups.

The source panel borrows the selection-to-evidence interaction from the
`aec_pgrep` codebase's `apps/renderer/app.tsx` and
`apps/renderer/components/evidence-pane.tsx`. No backend or renderer code is
imported from that application.

## Build and review

Open `index.html` directly. The standalone artifact is built from Svelte 5 and
needs no server or network requests. App routes and runtime services are unchanged.

Rebuild with `bun run build:concepts`. Check the study with `bun run check:concepts`
and run the Svelte autofixer on changed components.
