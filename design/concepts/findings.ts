/** Source-backed sample findings for the desktop interaction study. */
export const findings = [
  {
    id: "conversation",
    title: "Keep chat at the center",
    summary:
      "Project details belong in the header, with the conversation taking the available space.",
    source: "T3 Code",
    filename: "Desktop workspace",
    location: "Reference screenshot and workspace styles",
    kind: "Interface reference",
    detail:
      "The header gives quick access to workspace information. The main area stays focused on the conversation until you choose to open something alongside it.",
    excerpt: ["--chat-content-max-width: 46rem;", "--thread-details-panel-width: 17.5rem;"],
    excerptLabel: "Workspace sizing tokens",
    href: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/index.css",
    sourceLabel: "View reference",
  },
  {
    id: "evidence",
    title: "Open evidence beside the thread",
    summary: "Selecting a result reveals its source without replacing the current conversation.",
    source: "aec_pgrep",
    filename: "app.tsx",
    location: "apps/renderer",
    kind: "Local source",
    detail:
      "The existing result-to-evidence pattern keeps a selected source in its own pane. Choosing a finding opens its context on the right. Closing it returns the space to chat.",
    excerpt: [
      "<EvidencePane",
      "  project={current.project}",
      "  evidence={current.evidence}",
      '  onBack={() => setView("results")}',
      "/>",
    ],
    excerptLabel: "Evidence selection in app.tsx",
    href: "",
    sourceLabel: "Local reference",
  },
  {
    id: "surfaces",
    title: "Keep color tied to status",
    summary: "Graphite surfaces carry the interface. Color calls attention to meaningful state.",
    source: "Nightdesk",
    filename: "system.css",
    location: "Uiverse Design / Nightdesk",
    kind: "Design reference",
    detail:
      "Nightdesk supplies the neutral surface hierarchy and compact controls. Progress, success, and caution get distinct signals. The conversation and navigation stay neutral.",
    excerpt: [
      "--nd-shell: #121212;",
      "--nd-panel: #1b1b1b;",
      "--nd-raised: #262626;",
      "--nd-hairline: #2c2c2c;",
    ],
    excerptLabel: "Nightdesk surface tokens",
    href: "https://uiverse.io/design/systems/nightdesk",
    sourceLabel: "View design system",
  },
] as const;

/** One of the fixed findings used in the visual study. */
export type Finding = (typeof findings)[number];
