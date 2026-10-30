# Workbench design

MOKE uses [Forge](https://design.uiverse.io), an industrial dark design system
from Uiverse Design. `design/selection.json` pins it from
`sc-frederick/uiverse-templates`. `project-kit design forge .` imports the
licensed pack, with its DESIGN.md, CSS, HTML, screenshots and license intact,
into the ignored `design/reference/forge/` directory. The pack's license allows
adapted application use. It forbids republishing or repackaging the pack, so the
reference source stays out of the repository and application distributions.

## What the app takes from Forge

`src/lib/forge.css` holds the tokens and base styles, loaded once by the root
layout. Components use the tokens directly; there is no second UI system.

- **Color.** Ink `#0B0B0C` canvas, Graphite `#131315` panels, Slate `#1B1B1E`
  wells and hover fills, Filament `#26262A` hairlines. Ember `#F65A1A` marks
  primary actions, focus, the active tab, the current conversation and expanded
  header menus. Spark `#FF7A38` is its hover. Error `#E2403A` and success
  `#4FB477` are the only status colors.
- **Type.** Space Grotesk for headings, Inter for interface text and JetBrains
  Mono for numbers, counts, durations, field labels, tabs and status pills.
  Variable WOFF2 files come from the Fontsource packages and ship inside the app
  under the SIL Open Font License 1.1. The renderer makes no font requests.
- **Shape.** 4px radius for buttons, inputs and panels, 2px for pills and
  checkboxes, 8px for dialogs, menus and popovers. Borders are 1px hairlines.
  Only menus, popovers and dialogs use the floating shadow.
- **Controls.** Buttons are uppercase Inter at 11px: Ember primary, hairline
  secondary and ghost, 32px tall in toolbars and rows and 40px in dialogs.
  Inputs are 40px Slate wells that take an Ember edge and halo on focus; the
  selects inside sheet rows use the 32px button height so each row lines up. Checkboxes use Forge's clipped tick. Tabs use mono labels with a 2px
  Ember underline.
- **Icons.** Tabler outline icons only, at a 1.6 stroke (1.8 on Ember buttons).
  `src/lib/review/icons.ts` copies the official paths, and
  `tests/smoke/icons.test.ts` fails if any path drifts from `@tabler/icons`.
  Disclosure rows and select menus draw the Tabler chevron in CSS instead of the
  platform triangle. See `TABLER-LICENSE`.

## Desktop adaptations

- Forge is dark only, so the workbench has no light appearance.
- Interface chrome is not selectable. Prose, findings, sources and form fields
  remain selectable, and selected text uses Forge's Ember highlight.
- Focus rings appear only for keyboard focus: a 1px Ember edge with the Forge
  halo, kept alongside the Ember bar on current items. Mouse clicks do not leave
  rings behind.
- Disabled primary buttons turn neutral; a faded Ember fill reads as brown.
- Native window chrome follows the dark theme, and scrollbars drop their arrow
  buttons.
- The brand mark follows Forge's mono letter in an Ember square.
- Header actions that would crowd the breadcrumb become icon buttons below
  1180px wide.
