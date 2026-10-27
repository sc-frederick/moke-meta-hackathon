<script lang="ts">
  import { onMount, tick } from "svelte";
  import Icon from "./ConceptIcon.svelte";
  import { findings, type Finding } from "./findings.ts";

  const projects = [
    {
      id: "hackathon",
      name: "Moke hackathon",
      fullName: "moke-meta-hackathon",
      monogram: "M",
      threads: ["Explore the references", "Search the workspace", "Compare the results"],
    },
    {
      id: "riverside",
      name: "Riverside office",
      fullName: "Riverside office",
      monogram: "R",
      threads: ["Drawing review", "Connection details"],
    },
    {
      id: "maple",
      name: "Maple residence",
      fullName: "Maple residence",
      monogram: "M",
      threads: ["Permit review", "Open questions"],
    },
  ] as const;
  type Project = (typeof projects)[number];

  let theme = $state<"dark" | "light">("dark");
  let sidebarOpen = $state(true);
  let mobileNavigationOpen = $state(false);
  let popoverOpen = $state(false);
  let selectedFinding = $state<Finding | null>(null);
  let activeProject = $state.raw<Project>(projects[0]);
  let expandedProjects = $state.raw<ReadonlyArray<Project["id"]>>(["hackathon", "riverside"]);
  let thread = $state("Explore the references");
  let isNew = $state(false);
  let draft = $state("");
  let exchanges = $state<ReadonlyArray<{ id: number; message: string }>>([]);
  let findQuery = $state("");
  let searchOpen = $state(false);
  let sourceTab = $state<"evidence" | "details">("evidence");
  let findingsButton: HTMLButtonElement | undefined;
  let findingsBubble: HTMLElement | undefined;
  let chatViewport: HTMLDivElement | undefined;
  let composerInput: HTMLTextAreaElement | undefined;
  let nextMessageId = 1;

  let visibleFindings = $derived(
    findings.filter((finding) =>
      `${finding.title} ${finding.source}`.toLowerCase().includes(findQuery.toLowerCase()),
    ),
  );

  function positionFindings() {
    const anchor = findingsButton;
    const bubble = findingsBubble;
    if (!anchor || !bubble) return;

    const rect = anchor.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(rect.bottom + 18, window.innerHeight - 160));
    bubble.style.width = `${width}px`;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.maxHeight = `${Math.max(140, window.innerHeight - top - 12)}px`;
  }

  function showFindings() {
    positionFindings();
    findingsBubble?.showPopover();
  }
  function closeFindings() {
    findingsBubble?.hidePopover();
  }

  function openFinding(finding: Finding) {
    selectedFinding = finding;
    sourceTab = "evidence";
    closeFindings();
    searchOpen = false;
    mobileNavigationOpen = false;
  }

  function closeSource() {
    selectedFinding = null;
    findingsButton?.focus({ preventScroll: true });
  }

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 600px)").matches) {
      mobileNavigationOpen = !mobileNavigationOpen;
    } else {
      sidebarOpen = !sidebarOpen;
    }
    closeFindings();
  }

  function newConversation() {
    if (!expandedProjects.includes(activeProject.id)) {
      expandedProjects = [...expandedProjects, activeProject.id];
    }
    thread = "New conversation";
    isNew = true;
    exchanges = [];
    selectedFinding = null;
    draft = "";
    mobileNavigationOpen = false;
    closeFindings();
    composerInput?.focus({ preventScroll: true });
  }

  function toggleProject(id: Project["id"]) {
    expandedProjects = expandedProjects.includes(id)
      ? expandedProjects.filter((projectId) => projectId !== id)
      : [...expandedProjects, id];
  }

  function chooseThread(project: Project, name: string) {
    mobileNavigationOpen = false;
    closeFindings();
    if (activeProject.id === project.id && thread === name) return;

    activeProject = project;
    thread = name;
    isNew = false;
    exchanges = [];
    selectedFinding = null;
    draft = "";
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;

    exchanges = [...exchanges, { id: nextMessageId++, message }];
    draft = "";
    await tick();
    if (chatViewport) chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  function handleKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      closeFindings();
      searchOpen = !searchOpen;
      findQuery = "";
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      newConversation();
    }
    if (event.key === "Escape") {
      searchOpen = false;
      mobileNavigationOpen = false;
      if (!popoverOpen && selectedFinding) closeSource();
    }
  }

  onMount(() => {
    showFindings();
    return closeFindings;
  });
</script>

<svelte:window onkeydown={handleKey} onresize={positionFindings} onscroll={positionFindings} />

{#snippet mark(size = 20)}
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true"
    ><path
      d="M5 22V7l9 9 9-9v15"
      stroke="currentColor"
      stroke-width="3.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg
  >
{/snippet}

{#snippet findingRows(items: ReadonlyArray<Finding>)}
  {#each items as finding (finding.id)}
    <button
      class="finding-row"
      class:selected={selectedFinding?.id === finding.id}
      onclick={() => openFinding(finding)}
      title={finding.source}
    >
      <Icon name="file-text" size={16} /><span>{finding.title}</span><Icon
        name="chevron-right"
        size={14}
      />
    </button>
  {/each}
{/snippet}

<div class="study">
  <div
    class="desktop"
    data-theme={theme}
    class:sidebar-closed={!sidebarOpen}
    class:source-open={selectedFinding !== null}
    class:mobile-navigation-open={mobileNavigationOpen}
  >
    <header class="window-bar">
      <div class="brand-slot">
        <button class="icon-button" aria-label="Toggle conversation sidebar" onclick={toggleSidebar}
          ><Icon name="layout-sidebar" size={17} /></button
        ><span class="brand-name">Moke</span>
      </div>
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <span class="project-crumb"
          ><span class="project-monogram" aria-hidden="true">{activeProject.monogram}</span><span
            >{activeProject.fullName}</span
          ></span
        >
        <span class="breadcrumb-divider" aria-hidden="true">/</span><strong aria-current="page"
          >{thread}</strong
        >
      </nav>
      <div class="window-actions">
        <button
          class="theme-picker"
          onclick={() => {
            theme = theme === "dark" ? "light" : "dark";
          }}
          aria-label={theme === "dark" ? "Use light appearance" : "Use dark appearance"}
          >{theme === "dark" ? "Light" : "Dark"}</button
        >
        <button
          bind:this={findingsButton}
          class="findings-trigger"
          class:expanded={popoverOpen}
          aria-label="Open findings"
          aria-expanded={popoverOpen}
          popovertarget="workspace-findings"
          onclick={positionFindings}
          ><Icon name="layout-grid" size={15} /><span>Findings</span><span class="finding-count"
            >{findings.length}</span
          ><Icon name="chevron-down" size={13} /></button
        >
      </div>
    </header>

    <div class="app-body">
      {#if sidebarOpen}
        <aside class="sidebar" aria-label="Conversation navigation">
          <button class="new-chat" onclick={newConversation}
            ><Icon name="plus" size={16} /><span>New conversation</span></button
          >
          <button
            class="sidebar-search"
            onclick={() => {
              closeFindings();
              searchOpen = true;
              findQuery = "";
            }}><Icon name="search" size={16} /><span>Search</span><kbd>⌘ K</kbd></button
          >
          <nav class="projects" aria-label="Projects">
            {#each projects as project (project.id)}
              <section class="project-group" aria-label={project.name}>
                <button
                  class="project-heading"
                  aria-expanded={expandedProjects.includes(project.id)}
                  aria-controls={`project-${project.id}`}
                  onclick={() => toggleProject(project.id)}
                >
                  <Icon
                    name={expandedProjects.includes(project.id) ? "chevron-down" : "chevron-right"}
                    size={13}
                  /><Icon name="folder" size={16} /><span>{project.name}</span>
                </button>
                {#if expandedProjects.includes(project.id)}
                  <div class="threads" id={`project-${project.id}`}>
                    {#each project.threads as name (name)}<button
                        class:current={activeProject.id === project.id && thread === name}
                        aria-current={activeProject.id === project.id && thread === name
                          ? "page"
                          : undefined}
                        title={name}
                        onclick={() => chooseThread(project, name)}
                        ><Icon name="message" size={14} /><span>{name}</span></button
                      >{/each}
                    {#if isNew && activeProject.id === project.id}<button
                        class="current"
                        aria-current="page"
                        onclick={() => chooseThread(project, "New conversation")}
                        ><Icon name="message" size={14} /><span>New conversation</span></button
                      >{/if}
                  </div>
                {/if}
              </section>
            {/each}
          </nav>
          <div class="account">
            <span class="avatar">SF</span><strong>Stephen</strong><button
              class="icon-button"
              aria-label="Workspace information"
              onclick={showFindings}><Icon name="settings" size={17} /></button
            >
          </div>
        </aside>
      {/if}

      <section class="chat" aria-label="Conversation">
        <div class="chat-scroll" bind:this={chatViewport}>
          <div class="conversation-content">
            {#if isNew && exchanges.length === 0}
              <div class="chat-empty">
                {@render mark(26)}
                <h1>What are we looking into?</h1>
              </div>
            {:else if !isNew}
              <div class="message user-message">
                <div class="byline"><span class="user-mark">S</span><strong>You</strong></div>
                <p>
                  Compare these desktop references. What should we keep, and where can I see the
                  source?
                </p>
              </div>
              <div class="message assistant-message">
                <div class="byline">
                  <span class="assistant-mark">{@render mark(15)}</span><strong>Moke</strong>
                </div>
                <p>I found three useful patterns across the references.</p>
                <p>
                  Keep chat as the main workspace. Put findings in the top-right menu and open the
                  selected source beside the conversation.
                </p>
              </div>
            {/if}
            {#each exchanges as exchange (exchange.id)}
              <div class="message user-message">
                <div class="byline"><span class="user-mark">S</span><strong>You</strong></div>
                <p>{exchange.message}</p>
              </div>
              <div class="message assistant-message">
                <div class="byline">
                  <span class="assistant-mark">{@render mark(15)}</span><strong>Moke</strong>
                </div>
                <p>The references are ready to explore in Findings.</p>
              </div>
            {/each}
          </div>
        </div>
        <div class="composer-region">
          <form class="composer" onsubmit={send}>
            <label class="sr-only" for="chat-message">Message Moke</label><textarea
              id="chat-message"
              bind:this={composerInput}
              bind:value={draft}
              rows="2"
              maxlength="2000"
              placeholder="Message Moke…"></textarea>
            <div class="composer-tools">
              <button
                type="button"
                class="icon-button"
                aria-label="Browse workspace sources"
                onclick={showFindings}><Icon name="plus" size={19} /></button
              ><span class="spacer"></span><button
                class="send"
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send sample message"><Icon name="arrow-up" size={17} /></button
              >
            </div>
          </form>
        </div>
      </section>

      {#if selectedFinding}
        <aside class="source-panel" aria-label="Finding source">
          <header class="source-header">
            <Icon name="file-text" size={16} /><strong>{selectedFinding.filename}</strong><span
              class="spacer"
            ></span><button
              class="icon-button"
              aria-label="Close source panel"
              onclick={closeSource}><Icon name="x" size={17} /></button
            >
          </header>
          <div class="source-tabs" aria-label="Source views">
            <button
              class:current={sourceTab === "evidence"}
              aria-pressed={sourceTab === "evidence"}
              onclick={() => (sourceTab = "evidence")}>Evidence</button
            ><button
              class:current={sourceTab === "details"}
              aria-pressed={sourceTab === "details"}
              onclick={() => (sourceTab = "details")}>Details</button
            >
          </div>
          <div class="source-scroll">
            <h2>{selectedFinding.title}</h2>
            {#if sourceTab === "evidence"}
              <p class="source-explanation">{selectedFinding.detail}</p>
              <div class="excerpt">
                <div class="excerpt-title">{selectedFinding.excerptLabel}</div>
                <pre aria-label="Source excerpt"><code
                    >{#each selectedFinding.excerpt as line, index (`${selectedFinding.id}-${index}`)}<span
                      class="code-line"
                      ><span class="line-number" aria-hidden="true">{index + 1}</span><span
                        >{line}</span
                      ></span
                    >{/each}</code
                  ></pre>
              </div>
            {:else}
              <dl class="source-details">
                <div>
                  <dt>Reference</dt>
                  <dd>{selectedFinding.source}</dd>
                </div>
                <div>
                  <dt>File</dt>
                  <dd>{selectedFinding.filename}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{selectedFinding.location}</dd>
                </div>
              </dl>
            {/if}
            {#if selectedFinding.href}<a
                class="source-link"
                href={selectedFinding.href}
                target="_blank"
                rel="noreferrer"
                >{selectedFinding.sourceLabel}<Icon name="arrow-up-right" size={15} /></a
              >{/if}
          </div>
        </aside>
      {/if}
    </div>

    <section
      id="workspace-findings"
      class="findings-bubble"
      popover="auto"
      bind:this={findingsBubble}
      aria-label="Workspace findings"
      ontoggle={(event) => {
        popoverOpen = event.newState === "open";
      }}
    >
      <div class="bubble-context">
        <Icon name="folder" size={17} /><strong>{activeProject.fullName}</strong>
      </div>
      <div class="bubble-results">{@render findingRows(findings)}</div>
    </section>

    {#if searchOpen}<section class="search-panel" aria-label="Search workspace">
        <div class="search-field">
          <Icon name="search" size={18} /><input
            aria-label="Search findings"
            placeholder="Search findings…"
            bind:value={findQuery}
            {@attach (input) => input.focus()}
          /><button
            class="icon-button"
            aria-label="Close search"
            onclick={() => (searchOpen = false)}><Icon name="x" size={16} /></button
          >
        </div>
        <div class="search-results">
          {#if visibleFindings.length > 0}{@render findingRows(visibleFindings)}{:else}<p>
              No matching findings.
            </p>{/if}
        </div>
      </section>{/if}
  </div>
</div>

<style>
  .study {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    color: var(--foreground, CanvasText);
  }
  .study :global(*) {
    box-sizing: border-box;
  }
  button,
  input,
  textarea {
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible,
  a:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--nd-focus, var(--ring, #888));
    outline-offset: 3px;
  }
  .desktop {
    --nd-shell: #141414;
    --nd-panel: #1b1b1b;
    --nd-raised: #262626;
    --nd-raised-hover: #2e2e2e;
    --nd-hairline: #2b2b2b;
    --nd-hairline-strong: #3b3b3b;
    --nd-ink: #ededed;
    --nd-ink-muted: #a6a6a6;
    --nd-ink-inverse: #171717;
    --nd-focus: #ededed;
    --sidebar-width: 216px;
    --source-width: 332px;
    --frame-height: 640px;
    position: relative;
    isolation: isolate;
    background: var(--nd-shell);
    border: 1px solid var(--nd-hairline);
    border-radius: 12px;
    color: var(--nd-ink);
    color-scheme: dark;
    overflow: clip;
    font-size: 13px;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
  }
  .desktop[data-theme="light"] {
    --nd-shell: #fdfdfd;
    --nd-panel: #f6f6f6;
    --nd-raised: #ededed;
    --nd-raised-hover: #e6e6e6;
    --nd-hairline: #e6e6e6;
    --nd-hairline-strong: #d4d4d4;
    --nd-ink: #252525;
    --nd-ink-muted: #686868;
    --nd-ink-inverse: #fff;
    --nd-focus: #333;
    color-scheme: light;
  }
  .desktop button {
    color: inherit;
    border: 0;
    background: transparent;
  }
  .desktop button:hover {
    background: var(--nd-raised-hover);
  }
  .desktop button:focus-visible {
    outline-offset: -2px;
  }
  .desktop :global(svg) {
    flex-shrink: 0;
  }
  .desktop :global(*) {
    scrollbar-width: thin;
    scrollbar-color: var(--nd-hairline-strong) transparent;
  }
  .desktop ::selection {
    background: var(--nd-ink);
    color: var(--nd-shell);
  }
  .window-bar {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding-right: 16px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .brand-slot {
    width: var(--sidebar-width);
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 14px;
    flex-shrink: 0;
    background: var(--nd-panel);
    border-right: 1px solid var(--nd-hairline);
  }
  .brand-name {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.2px;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 6px;
    color: var(--nd-ink-muted) !important;
    flex-shrink: 0;
  }
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }
  .project-crumb {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--nd-ink-muted);
    min-width: 0;
    max-width: 200px;
    font-size: 13px;
  }
  .project-crumb > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .project-monogram {
    display: grid;
    place-items: center;
    width: 17px;
    height: 17px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    background: var(--nd-raised);
    color: var(--nd-ink);
    flex-shrink: 0;
  }
  .breadcrumb-divider {
    color: var(--nd-ink-muted);
    font-size: 14px;
  }
  .breadcrumbs > strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    font-weight: 500;
  }
  .window-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .theme-picker {
    padding: 5px 8px !important;
    border-radius: 5px;
    font-size: 12px;
    color: var(--nd-ink-muted) !important;
  }
  .findings-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 5px 9px !important;
    border-radius: 7px;
    font-size: 12px;
  }
  .findings-trigger.expanded {
    background: var(--nd-raised) !important;
  }
  .finding-count {
    display: grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--nd-ink-muted);
  }
  .app-body {
    height: var(--frame-height);
    display: flex;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    width: var(--sidebar-width);
    flex-shrink: 0;
    padding: 20px 12px 0;
    border-right: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
  }
  .new-chat {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 36px;
    padding: 8px 11px !important;
    border: 1px solid var(--nd-hairline-strong) !important;
    border-radius: 7px;
    font-size: 13px;
    white-space: nowrap;
    text-align: left;
  }
  .sidebar-search {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 7px 0 25px;
    min-height: 36px;
    padding: 8px 11px !important;
    font-size: 13px;
    border-radius: 6px;
    color: var(--nd-ink-muted) !important;
    text-align: left;
  }
  kbd {
    font: inherit;
    font-size: 11px;
    color: var(--nd-ink-muted);
    margin-left: auto;
    white-space: nowrap;
  }
  .projects {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0 -4px;
    padding: 0 4px 16px;
  }
  .project-group + .project-group {
    margin-top: 18px;
  }
  .project-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 34px;
    padding: 7px 4px !important;
    border-radius: 6px;
    text-align: left;
    font-size: 13px;
    font-weight: 500;
  }
  .project-heading > :global(svg) {
    color: var(--nd-ink-muted);
  }
  .project-heading > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .threads {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 6px 0 0 10px;
    padding-left: 8px;
    border-left: 1px solid var(--nd-hairline);
  }
  .threads button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    font-size: 13px;
    min-height: 36px;
    padding: 8px !important;
    text-align: left;
    border-radius: 7px;
    color: var(--nd-ink-muted);
  }
  .threads button.current {
    color: var(--nd-ink);
    background: var(--nd-raised);
  }
  .threads button > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .account {
    display: flex;
    gap: 9px;
    align-items: center;
    padding: 16px 5px;
    margin-top: auto;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 7px;
    font-size: 11px;
    color: var(--nd-ink-muted);
  }
  .account strong {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
  }
  .chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .chat-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 52px 40px 24px;
  }
  .conversation-content {
    max-width: 640px;
    margin: auto;
  }
  .message {
    margin: 0 0 36px;
    font-size: 15px;
    line-height: 1.75;
  }
  .byline {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .byline strong {
    font-size: 13px;
    font-weight: 500;
  }
  .user-mark,
  .assistant-mark {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    border-radius: 5px;
  }
  .user-mark {
    background: var(--nd-raised);
    color: var(--nd-ink-muted);
  }
  .message p {
    margin: 13px 0;
    overflow-wrap: anywhere;
  }
  .composer-region {
    flex-shrink: 0;
    padding: 16px 32px 24px;
  }
  .composer {
    max-width: 656px;
    margin: auto;
    padding: 16px 15px 10px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 11px;
    background: var(--nd-panel);
  }
  .composer:focus-within {
    border-color: var(--nd-ink-muted);
  }
  .composer textarea {
    display: block;
    width: 100%;
    resize: none;
    border: 0;
    background: transparent;
    color: var(--nd-ink);
    outline: 0;
    font-size: 14px;
    line-height: 1.65;
    padding: 0 2px;
    caret-color: var(--nd-ink);
  }
  .composer textarea::placeholder {
    color: var(--nd-ink-muted);
    opacity: 1;
  }
  .composer-tools {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: 12px;
  }
  .spacer {
    flex: 1;
  }
  .desktop .send {
    display: grid;
    place-items: center;
    width: 29px;
    height: 29px;
    padding: 0;
    background: var(--nd-ink);
    color: var(--nd-ink-inverse);
    border-radius: 7px;
  }
  .desktop .send:disabled {
    color: var(--nd-ink-muted);
    background: var(--nd-raised);
  }
  .chat-empty {
    padding: 100px 12px;
    text-align: center;
    color: var(--nd-ink-muted);
  }
  .chat-empty h1 {
    color: var(--nd-ink);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.3px;
    margin: 20px 0 0;
  }
  .source-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 var(--source-width);
    min-width: 0;
    border-left: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
  }
  .source-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px;
    min-height: 52px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .source-header strong {
    font-size: 13px;
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-tabs {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 0 22px;
    min-height: 43px;
  }
  .source-tabs button {
    min-height: 43px;
    padding: 0 1px !important;
    border-bottom: 1px solid transparent !important;
    font-size: 12px;
    color: var(--nd-ink-muted);
  }
  .source-tabs button.current {
    color: var(--nd-ink);
    border-bottom-color: var(--nd-ink) !important;
  }
  .source-scroll {
    flex: 1;
    overflow: auto;
    padding: 26px 24px;
  }
  .source-scroll h2 {
    font-size: 18px;
    font-weight: 500;
    line-height: 1.4;
    letter-spacing: -0.25px;
    margin: 0 0 18px;
  }
  .source-explanation {
    font-size: 13px;
    line-height: 1.75;
    color: var(--nd-ink-muted);
    margin: 0 0 24px;
  }
  .excerpt {
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    background: var(--nd-shell);
    overflow: hidden;
  }
  .excerpt-title {
    padding: 12px 14px;
    border-bottom: 1px solid var(--nd-hairline);
    font-size: 11px;
    color: var(--nd-ink-muted);
  }
  pre {
    margin: 0;
    padding: 16px 0;
    overflow: auto;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.85;
  }
  code {
    font: inherit;
  }
  .code-line {
    display: flex;
    white-space: pre;
    padding-right: 16px;
  }
  .line-number {
    display: inline-block;
    min-width: 32px;
    padding-right: 10px;
    color: var(--nd-ink-muted);
    user-select: none;
    text-align: right;
  }
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    margin-top: 24px;
    font-size: 12px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    text-decoration: none;
    color: var(--nd-ink);
  }
  .source-link:hover {
    background: var(--nd-raised);
  }
  .source-details {
    margin: 0;
  }
  .source-details > div {
    border-bottom: 1px solid var(--nd-hairline);
    padding: 14px 0;
  }
  .source-details dt {
    font-size: 12px;
    color: var(--nd-ink-muted);
    margin-bottom: 6px;
  }
  .source-details dd {
    font-size: 13px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .findings-bubble {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 16px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 16px;
    color: var(--nd-ink);
    background: var(--nd-panel);
    box-shadow:
      0 4px 10px -4px #0002,
      0 16px 40px -14px #0008;
    overflow: auto;
  }
  .bubble-context {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px 21px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--nd-hairline);
    color: var(--nd-ink-muted);
  }
  .bubble-context strong {
    font-size: 13px;
    font-weight: 500;
  }
  .bubble-results {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .finding-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 12px !important;
    border-radius: 8px;
    text-align: left;
    width: 100%;
  }
  .finding-row.selected {
    background: var(--nd-raised);
  }
  .finding-row > span {
    min-width: 0;
    flex: 1;
    font-size: 13px;
    line-height: 1.5;
  }
  .finding-row > :global(svg) {
    color: var(--nd-ink-muted);
  }
  .search-panel {
    position: absolute;
    left: 50%;
    top: 80px;
    translate: -50% 0;
    width: min(440px, calc(100% - 28px));
    background: var(--nd-panel);
    color: var(--nd-ink);
    border: 1px solid var(--nd-hairline-strong);
    box-shadow: 0 16px 38px -12px #0008;
    border-radius: 12px;
    padding: 12px;
    z-index: 3;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--nd-hairline);
    padding: 5px 8px 14px;
    color: var(--nd-ink-muted);
  }
  .search-field input {
    min-width: 0;
    flex: 1;
    background: transparent;
    color: var(--nd-ink);
    padding: 6px 0;
    font-size: 13px;
    border: 0;
  }
  .search-field input::placeholder {
    color: var(--nd-ink-muted);
    opacity: 1;
  }
  .search-results {
    padding-top: 9px;
  }
  .search-results > p {
    font-size: 13px;
    color: var(--nd-ink-muted);
    padding: 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .sidebar-closed .brand-slot {
    width: 52px;
    padding-left: 10px;
    border-right: 0;
    background: transparent;
  }
  .sidebar-closed .brand-name {
    display: none;
  }
  @media (min-width: 1050px) {
    .desktop {
      --sidebar-width: 224px;
      --source-width: 340px;
      --frame-height: 660px;
    }
  }
  @media (max-width: 1049px) {
    .desktop {
      --sidebar-width: 184px;
      --source-width: 296px;
    }
    .window-bar {
      gap: 12px;
      padding-right: 12px;
    }
    .breadcrumbs {
      gap: 9px;
    }
    .project-crumb {
      max-width: 120px;
    }
    .chat-scroll {
      padding: 42px 28px 24px;
    }
    .composer-region {
      padding-inline: 20px;
    }
    .sidebar {
      padding-inline: 10px;
    }
    .new-chat,
    .threads button {
      padding-inline: 9px !important;
    }
    .source-open .sidebar {
      display: none;
    }
    .source-open .brand-slot {
      width: 52px;
      padding-left: 10px;
      border-right: 0;
      background: transparent;
    }
    .source-open .brand-name {
      display: none;
    }
  }
  @media (max-width: 600px) {
    .desktop {
      --frame-height: 600px;
    }
    .sidebar {
      display: none;
    }
    .window-bar {
      height: 50px;
      gap: 8px;
      padding-right: 9px;
    }
    .brand-slot {
      width: 40px;
      padding-left: 7px;
      border-right: 0;
      background: transparent;
    }
    .brand-name {
      display: none;
    }
    .breadcrumbs {
      gap: 7px;
    }
    .project-crumb {
      max-width: 25px;
    }
    .project-crumb > span:last-child {
      display: none;
    }
    .breadcrumbs > strong {
      font-size: 12px;
    }
    .breadcrumb-divider {
      display: none;
    }
    .window-actions {
      gap: 4px;
    }
    .theme-picker {
      font-size: 11px;
      padding-inline: 5px !important;
    }
    .findings-trigger {
      min-height: 30px;
      gap: 5px;
      padding-inline: 6px !important;
    }
    .findings-trigger > span:not(.finding-count) {
      display: none;
    }
    .finding-count {
      font-size: 12px;
    }
    .chat-scroll {
      padding: 34px 22px 20px;
    }
    .composer-region {
      padding: 12px 14px 18px;
    }
    .composer textarea {
      font-size: 16px;
    }
    .source-panel {
      position: absolute;
      top: 50px;
      right: 0;
      bottom: 0;
      width: min(340px, calc(100% - 30px));
      z-index: 2;
      box-shadow: -8px 0 25px -15px #0009;
    }
    .desktop.mobile-navigation-open .sidebar {
      display: flex;
      width: 220px;
      position: absolute;
      left: 0;
      top: 50px;
      bottom: 0;
      z-index: 4;
      box-shadow: 10px 0 25px -15px #0009;
    }
    .bubble-context {
      padding-inline: 8px;
    }
    .finding-row {
      padding-inline: 8px !important;
      gap: 10px;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .desktop button {
      transition: background 140ms ease-out;
    }
  }
</style>
