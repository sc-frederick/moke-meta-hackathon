<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    Artifact,
    Conversation,
    Finding,
    Project,
    ReviewSnapshot,
    Sheet,
  } from "#lib/review/contracts.ts";
  import { Schema } from "effect";
  import { ReviewCommand, OperationId } from "#lib/review/contracts.ts";
  import { newCommandId, reviewCommand, type ReviewClient } from "#lib/review/client.ts";
  import FindingInspector from "./FindingInspector.svelte";
  import ReviewIcon from "./ReviewIcon.svelte";
  import SourceViewer from "./SourceViewer.svelte";
  import {
    findingSubtitle,
    formatOutcome,
    projectMonogram,
    sheetCaption,
  } from "./review-format.ts";

  let { client }: { client: ReviewClient } = $props();

  let theme = $state<"dark" | "light">("dark");
  let sidebarOpen = $state(true);
  let mobileNavigationOpen = $state(false);
  let popoverOpen = $state(false);
  let searchOpen = $state(false);
  let findQuery = $state("");
  let ready = $state(false);
  let busy = $state(false);
  let error = $state("");
  let snapshot = $state.raw<ReviewSnapshot | null>(null);
  let eventCursor = $state(0);

  let selectedProjectId = $state<string | null>(null);
  let selectedConversationId = $state<string | null>(null);
  let selectedFindingId = $state<string | null>(null);
  let sourceTab = $state<"evidence" | "sheets" | "revision">("evidence");

  let newProjectName = $state("");
  let newConversationTitle = $state("Drawing coordination");
  let draft = $state("");
  let expandedProjects = $state.raw<ReadonlyArray<string>>([]);

  let createFindingOpen = $state(false);
  let newProjectOpen = $state(false);
  let sourceSide = $state<"drawn" | "scheduled">("drawn");
  let revisionChoices = $state<Array<{ oldSheetId: string; newSheetId: string; confirmed: boolean; content: "changed" | "unchanged" }>>([]);
  function stageRevision(oldSheetId: string, update: { newSheetId?: string; confirmed?: boolean; content?: "changed" | "unchanged" }) {
    const previous = revisionChoices.find((pair) => pair.oldSheetId === oldSheetId);
    revisionChoices = [...revisionChoices.filter((pair) => pair.oldSheetId !== oldSheetId), { oldSheetId, newSheetId: previous?.newSheetId ?? "", confirmed: previous?.confirmed ?? false, content: previous?.content ?? "changed", ...update }];
  }
  let findingTitle = $state("Schedule coordination");
  let findingObjectClass = $state("Electrical panel");
  let findingDrawnSheet = $state("");
  let findingScheduledSheet = $state("");
  let findingApplicability = $state(false);

  let sourceImageUrl = $state("");
  let sourceArtifact = $state.raw<Artifact | null>(null);

  let sourceOverlays = $state.raw<
    ReadonlyArray<{
      region: { x: number; y: number; width: number; height: number };
      title: string;
    }>
  >([]);

  let findingsButton: HTMLButtonElement | undefined = $state();
  let findingsBubble: HTMLElement | undefined = $state();
  let chatViewport: HTMLDivElement | undefined = $state();
  let composerInput: HTMLTextAreaElement | undefined = $state();

  const project = $derived(snapshot?.project ?? null);
  const projects = $derived(snapshot?.projects ?? []);
  const conversations = $derived(snapshot?.conversations ?? []);
  const messages = $derived(snapshot?.messages ?? []);
  const findings = $derived(snapshot?.findings ?? []);
  const sheets = $derived(snapshot?.sheets ?? []);
  const checks = $derived(snapshot?.checks ?? []);
  const facts = $derived(snapshot?.facts ?? []);
  const revisions = $derived(snapshot?.revisions ?? []);

  const activeConversation = $derived(
    conversations.find((item) => item.id === selectedConversationId) ?? conversations[0] ?? null,
  );

  const selectedFinding = $derived(findings.find((item) => item.id === selectedFindingId) ?? null);

  const visibleFindings = $derived(
    findings.filter((finding) =>
      `${finding.title} ${finding.objectClass} ${formatOutcome(finding.outcome)}`
        .toLowerCase()
        .includes(findQuery.toLowerCase()),
    ),
  );

  const conversationMessages = $derived(
    activeConversation === null
      ? []
      : messages.filter((message) => message.conversationId === activeConversation.id),
  );

  const progressEvents = $derived(snapshot?.events ?? []);

  async function refresh(projectId: typeof selectedProjectId = selectedProjectId) {
    const result = await client.snapshot(projectId, eventCursor);

    if (!result.ok) {
      error = result.error.message;

      return;
    }

    snapshot = result.value;
    error = "";

    if (result.value.events.length > 0) {
      eventCursor = result.value.events.at(-1)?.sequence ?? eventCursor;
    }

    if (selectedProjectId === null && result.value.project !== null) {
      selectedProjectId = result.value.project.id;
    }

    if (selectedConversationId === null && result.value.conversations.length > 0) {
      selectedConversationId = result.value.conversations[0]?.id ?? null;
    }

    if (selectedProjectId !== null && !expandedProjects.includes(selectedProjectId)) {
      expandedProjects = [...expandedProjects, selectedProjectId];
    }
  }

  async function runCommand(command: Parameters<ReviewClient["command"]>[0]) {
    busy = true;
    const result = await client.command(command);
    if (!result.ok) {
      busy = false;
      error = result.error.message;

      return false;
    }

    selectedProjectId = result.value.projectId;
    await refresh(result.value.projectId);
    busy = false;

    return true;
  }

  async function createProject(event: SubmitEvent) {
    event.preventDefault();
    const name = newProjectName.trim();

    if (!name) return;

    const ok = await runCommand(
      reviewCommand(ReviewCommand.cases.CreateProject.make({commandId: newCommandId(),
name})),
    );

    if (!ok) return;
    newProjectName = "";
    newProjectOpen = false;
    selectedFindingId = null;
    selectedConversationId = snapshot?.conversations[0]?.id ?? null;
  }

  async function selectProject(entry: Project) {
    selectedProjectId = entry.id;
    selectedConversationId = null;
    selectedFindingId = null;
    await refresh(entry.id);
    const first = snapshot?.conversations[0];
    selectedConversationId = first?.id ?? null;
  }

  async function createConversation() {
    if (project === null) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.CreateConversation.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
title: newConversationTitle.trim() || "Drawing coordination"})),
    );
    const latest = snapshot?.conversations.at(-1);
    selectedConversationId = latest?.id ?? selectedConversationId;
  }

  async function postMessage(event: SubmitEvent) {
    event.preventDefault();

    if (project === null || activeConversation === null) return;
    const text = draft.trim();

    if (!text) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.PostMessage.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
conversationId: activeConversation.id,
text})),
    );
    draft = "";
    await tick();

    if (chatViewport) chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  async function importPdf() {
    if (project === null) return;
    busy = true;

    const result = await client.chooseReviewPdf({
      projectId: project.id,
      expectedVersion: project.version,
      commandId: newCommandId(),
    });

    busy = false;

    if (!result.ok) {
      error = result.error.message;

      return;
    }

    if (result.value === null) return;
    await refresh(result.value.projectId);
  }

  async function confirmSheet(sheet: Sheet, label: string, coverage: Sheet["coverage"]) {
    if (project === null) return;
    const trimmed = label.trim() || `Sheet ${sheet.pageIndex + 1}`;
    await runCommand(
      reviewCommand(ReviewCommand.cases.ConfirmSheet.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
sheetId: sheet.id,
label: trimmed,
coverage: coverage === "unreviewed" ? "partial" : coverage})),
    );
  }

  async function createFinding(event: SubmitEvent) {
    event.preventDefault();

    if (project === null || !findingDrawnSheet || !findingScheduledSheet) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.CreateFinding.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
title: findingTitle.trim(),
objectClass: findingObjectClass.trim(),
drawnSheetId: findingDrawnSheet,
scheduledSheetId: findingScheduledSheet,
applicabilityConfirmed: findingApplicability})),
    );
    createFindingOpen = false;
    const latest = snapshot?.findings.at(-1);

    if (latest) selectedFindingId = latest.id;
  }

  async function loadSourceForFinding(
    finding: Finding,
    dpi: number,
    region?: { x: number; y: number; width: number; height: number },
    side: "drawn" | "scheduled" = "drawn",
  ) {
    if (project === null) return;
    sourceSide = side;
    const sheet = sheets.find((item) => item.id === (side === "drawn" ? finding.drawnSheetId : finding.scheduledSheetId));

    if (sheet === undefined) return;

    const targetRegion = region ?? {
      x: sheet.box.x,
      y: sheet.box.y,
      width: sheet.box.width,
      height: sheet.box.height,
    };

    busy = true;

    const rendered = await client.renderSource({
      projectId: project.id,
      sheetId: sheet.id,
      operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
      region: targetRegion,
      dpi,
    });

    if (!rendered.ok) {
      busy = false;
      error = rendered.error.message;

      return;
    }

    const artifact = rendered.value;
    const blob = await client.loadArtifactBlobUrl(project.id, artifact);
    busy = false;

    if (!blob.ok) {
      error = blob.error.message;

      return;
    }

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = blob.value;
    sourceArtifact = artifact;
    const drawn = facts.findLast((fact) => fact.findingId === finding.id && fact.side === "drawn");

    const scheduled = facts.findLast(
      (fact) => fact.findingId === finding.id && fact.side === "scheduled",
    );

    sourceOverlays = [
      ...(drawn?.evidence.sheetId === sheet.id ? [{ region: drawn.evidence.region, title: "Drawn evidence" }] : []),
      ...(scheduled?.evidence.sheetId === sheet.id ? [{ region: scheduled.evidence.region, title: "Scheduled evidence" }] : []),
    ];
  }

  function openFinding(finding: Finding) {
    selectedFindingId = finding.id;
    sourceTab = "evidence";
    closeFindings();
    searchOpen = false;
    mobileNavigationOpen = false;
    void loadSourceForFinding(finding, 96);
  }

  function closeSource() {
    selectedFindingId = null;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    findingsButton?.focus({ preventScroll: true });
  }

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

  function closeFindings() {
    findingsBubble?.hidePopover();
  }

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 900px)").matches) {
      mobileNavigationOpen = !mobileNavigationOpen;
    } else {
      sidebarOpen = !sidebarOpen;
    }

    closeFindings();
  }

  function toggleProject(id: string) {
    expandedProjects = expandedProjects.includes(id)
      ? expandedProjects.filter((entry) => entry !== id)
      : [...expandedProjects, id];
  }

  function chooseConversation(entry: Conversation) {
    selectedConversationId = entry.id;
    mobileNavigationOpen = false;
    closeFindings();
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
      void createConversation();
    }

    if (event.key === "Escape") {
      searchOpen = false;
      mobileNavigationOpen = false;

      if (!popoverOpen && selectedFindingId) closeSource();
    }
  }

  async function acceptCount(
    side: "drawn" | "scheduled",
    payload: {
      value: number;
      statement: string;
      rationale: string;
      coverageConfirmed: boolean;
      region: { x: number; y: number; width: number; height: number };
    },
  ) {
    if (project === null || selectedFinding === null) return;

    const sheetId =
      side === "drawn" ? selectedFinding.drawnSheetId : selectedFinding.scheduledSheetId;

    await runCommand(
      reviewCommand(ReviewCommand.cases.AcceptCount.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
findingId: selectedFinding.id,
side,
value: payload.value,
unit: "count",
coverageConfirmed: payload.coverageConfirmed,
evidence: { sheetId, region: payload.region, statement: payload.statement },
rationale: payload.rationale})),
    );

    if (selectedFinding) await loadSourceForFinding(selectedFinding, sourceArtifact?.dpi ?? 96, sourceArtifact?.region ?? undefined,sourceSide);
  }

  async function evaluateFinding() {
    if (project === null || selectedFinding === null) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.EvaluateFinding.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
findingId: selectedFinding.id})),
    );
  }

  async function setFindingStatus(closed: boolean, taskCompleted: boolean) {
    if (project === null || selectedFinding === null) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.SetFindingStatus.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
findingId: selectedFinding.id,
closed,
taskCompleted})),
    );
  }

  async function requestDetail(side: "drawn" | "scheduled", selectedRegion?: import("#lib/review/contracts.ts").Region) {
    if (selectedFinding === null) return;

    const sheetId =
      side === "drawn" ? selectedFinding.drawnSheetId : selectedFinding.scheduledSheetId;

    const sheet = sheets.find((item) => item.id === sheetId);

    if (sheet === undefined) return;

    const fact = facts.findLast(
      (entry) => entry.findingId === selectedFinding.id && entry.side === side,
    );

    const region = selectedRegion ?? fact?.evidence.region ?? {
      x: sheet.box.x + sheet.box.width * 0.25,
      y: sheet.box.y + sheet.box.height * 0.25,
      width: sheet.box.width * 0.5,
      height: sheet.box.height * 0.5,
    };

    await loadSourceForFinding(selectedFinding, 300, region, side);
  }

  async function associateRevision(
    revisionId: string,
    pairs: Array<{
      oldSheetId: string;
      newSheetId: string;
      confirmed: boolean;
      content: "changed" | "unchanged";
    }>,
  ) {
    if (project === null) return;
    await runCommand(
      reviewCommand(ReviewCommand.cases.AssociateRevision.make({commandId: newCommandId(),
projectId: project.id,
expectedVersion: project.version,
revisionId,
correspondence: pairs})),
    );
  }

  onMount(() => {
    const controller = new AbortController();
    void client.snapshot(null, 0, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;

      if (result.ok) {
        snapshot = result.value;

        if (result.value.project) {
          selectedProjectId = result.value.project.id;
          selectedConversationId = result.value.conversations[0]?.id ?? null;
        }
      } else {
        error = result.error.message;
      }

      ready = true;
    });

    return () => controller.abort();
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

<div class="workbench-root" data-theme={theme}>
  <div
    class="desktop"
    data-testid="review-workbench"
    class:sidebar-closed={!sidebarOpen}
    class:source-open={selectedFinding !== null}
    class:mobile-navigation-open={mobileNavigationOpen}
  >
    <header class="window-bar">
      <div class="brand-slot">
        <button class="icon-button" aria-label="Toggle conversation sidebar" onclick={toggleSidebar}
          ><ReviewIcon name="layout-sidebar" size={17} /></button
        ><span class="brand-name">Moke</span>
      </div>
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        {#if project}
          <span class="project-crumb"
            ><span class="project-monogram" aria-hidden="true">{projectMonogram(project.name)}</span
            ><span>{project.name}</span></span
          >
          <span class="breadcrumb-divider" aria-hidden="true">/</span>
          <strong aria-current="page">{activeConversation?.title ?? "Review"}</strong>
        {:else}
          <strong aria-current="page">Drawing review</strong>
        {/if}
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
        {#if project}
          <button
            type="button"
            class="ghost"
            disabled={busy}
            data-testid="import-pdf"
            onclick={importPdf}
            ><ReviewIcon name="upload" size={15} /><span>Import PDF</span></button
          >
          <button
            bind:this={findingsButton}
            class="findings-trigger"
            class:expanded={popoverOpen}
            aria-label="Open findings"
            aria-expanded={popoverOpen}
            popovertarget="review-findings"
            onclick={positionFindings}
            ><ReviewIcon name="layout-grid" size={15} /><span>Findings</span><span
              class="finding-count">{findings.length}</span
            ><ReviewIcon name="chevron-down" size={13} /></button
          >
        {/if}
      </div>
    </header>

    <div class="app-body">
      {#if sidebarOpen}
        <aside class="sidebar" aria-label="Conversation navigation">
          {#if !ready}
            <p role="status">Loading review…</p>
          {:else if projects.length === 0 || newProjectOpen}
            <form class="create-project" data-testid="create-project-form" onsubmit={createProject}>
              <h2>Create a project</h2>
              <label
                >Project name<input
                  data-testid="project-name-input"
                  bind:value={newProjectName}
                  required
                  maxlength="160"
                /></label
              >
              <button type="submit" disabled={busy} data-testid="create-project-button"
                >Create project</button
              >
            </form>
          {:else}
            <button class="new-chat" onclick={() => newProjectOpen = true}>New project</button>
            <button
              class="new-chat"
              data-testid="new-conversation"
              onclick={createConversation}
              disabled={!project || busy}
              ><ReviewIcon name="plus" size={16} /><span>New conversation</span></button
            >
            {#if project && sheets.length > 0}
              <section class="sheet-setup" aria-label="Sheet confirmation">
                <h2>Sheets</h2>
                <ul class="sheet-list compact" data-testid="sheet-list">
                  {#each sheets as sheet (sheet.id)}
                    <li>
                      <span>{sheetCaption(sheet)}</span>
                      <label>Label<input data-sheet-label={sheet.id} value={sheet.label} /></label>
                      <label
                        >Coverage<select data-sheet-coverage={sheet.id} value={sheet.coverage}>
                          <option value="unreviewed">Unreviewed</option>
                          <option value="partial">Partial</option>
                          <option value="reviewer_complete">Reviewer complete</option>
                        </select></label
                      >
                      <button
                        type="button"
                        data-testid={`confirm-sheet-${sheet.id}`}
                        disabled={busy}
                        onclick={(event) => {
                          const row = (event.currentTarget as HTMLButtonElement).closest("li");
                          const label =
                            row?.querySelector<HTMLInputElement>(`[data-sheet-label="${sheet.id}"]`)
                              ?.value ?? sheet.label;
                          const coverage =
                            (row?.querySelector<HTMLSelectElement>(
                              `[data-sheet-coverage="${sheet.id}"]`,
                            )?.value as Sheet["coverage"]) ?? sheet.coverage;
                          void confirmSheet(sheet, label, coverage);
                        }}>Confirm</button
                      >
                    </li>
                  {/each}
                </ul>
                <button
                  type="button"
                  class="primary"
                  data-testid="open-create-finding"
                  onclick={() => {
                    createFindingOpen = true;
                    if (sheets.filter((entry) => entry.confirmed).length >= 2) {
                      findingDrawnSheet = sheets.find((entry) => entry.confirmed)?.id ?? "";
                      findingScheduledSheet =
                        sheets.filter((entry) => entry.confirmed)[1]?.id ?? "";
                    }
                  }}>Create finding</button
                >
                {#if createFindingOpen}
                  <form
                    class="finding-form"
                    data-testid="create-finding-form"
                    onsubmit={createFinding}
                  >
                    <label>Title<input bind:value={findingTitle} required /></label>
                    <label>Object class<input bind:value={findingObjectClass} required /></label>
                    <label
                      >Drawn sheet<select bind:value={findingDrawnSheet} required>
                        <option value="">Select…</option>
                        {#each sheets.filter((s) => s.confirmed) as sheet (sheet.id)}
                          <option value={sheet.id}>{sheet.label}</option>
                        {/each}
                      </select></label
                    >
                    <label
                      >Scheduled sheet<select bind:value={findingScheduledSheet} required>
                        <option value="">Select…</option>
                        {#each sheets.filter((s) => s.confirmed) as sheet (sheet.id)}
                          <option value={sheet.id}>{sheet.label}</option>
                        {/each}
                      </select></label
                    >
                    <label class="checkbox"
                      ><input type="checkbox" bind:checked={findingApplicability} />Applicability
                      confirmed</label
                    >
                    <button type="submit" data-testid="create-finding-submit" disabled={busy}
                      >Create finding</button
                    >
                  </form>
                {/if}
              </section>
            {/if}
            <nav class="projects" aria-label="Projects">
              {#each projects as entry (entry.id)}
                <section class="project-group" aria-label={entry.name}>
                  <button
                    class="project-heading"
                    aria-expanded={expandedProjects.includes(entry.id)}
                    onclick={() => toggleProject(entry.id)}
                  >
                    <ReviewIcon
                      name={expandedProjects.includes(entry.id) ? "chevron-down" : "chevron-right"}
                      size={13}
                    /><ReviewIcon name="folder" size={16} /><span>{entry.name}</span>
                  </button>
                  {#if expandedProjects.includes(entry.id)}
                    <div class="threads">
                      {#each conversations.filter((c) => c.projectId === entry.id) as thread (thread.id)}
                        <button
                          class:current={selectedConversationId === thread.id}
                          aria-current={selectedConversationId === thread.id ? "page" : undefined}
                          data-testid={`conversation-${thread.id}`}
                          onclick={() => {
                            void selectProject(entry);
                            chooseConversation(thread);
                          }}
                          ><ReviewIcon name="message" size={14} /><span>{thread.title}</span
                          ></button
                        >
                      {/each}
                    </div>
                  {/if}
                </section>
              {/each}
            </nav>
          {/if}
        </aside>
      {/if}

      <section class="chat" aria-label="Conversation">
        {#if error}<p class="banner" role="alert">{error}</p>{/if}
        <div class="chat-scroll" bind:this={chatViewport}>
          <div class="conversation-content">
            {#if project === null}
              <div class="chat-empty">
                {@render mark(26)}
                <h1>Start a drawing review</h1>
                <p>Create a project to import PDFs and coordinate findings.</p>
              </div>
            {:else if conversationMessages.length === 0}
              <div class="chat-empty">
                {@render mark(26)}
                <h1>What are we checking?</h1>
                <p>
                  Confirm sheet coverage, accept source-linked counts, and evaluate coordination.
                </p>
              </div>
            {:else}
              {#each conversationMessages as message (message.id)}
                <div class="message" class:application-message={message.role === "application"}>
                  <div class="byline">
                    <span class="user-mark">{message.role === "reviewer" ? "S" : "M"}</span><strong
                      >{message.role === "reviewer" ? "You" : "Application"}</strong
                    >
                  </div>
                  <p>{message.text}</p>
                </div>
              {/each}
            {/if}
            {#each progressEvents as event (event.sequence)}
              <div class="progress-row" data-testid="review-progress">{event.message}</div>
            {/each}
          </div>
        </div>
        <div class="composer-region">
          <form class="composer" onsubmit={postMessage}>
            <label class="sr-only" for="chat-message">Message</label><textarea
              id="chat-message"
              bind:this={composerInput}
              bind:value={draft}
              rows="2"
              maxlength="2000"
              placeholder="Reviewer instruction…"
              disabled={project === null || activeConversation === null}></textarea>
            <div class="composer-tools">
              <button
                type="submit"
                class="send"
                disabled={!draft.trim() || busy}
                aria-label="Send message"><ReviewIcon name="arrow-up" size={17} /></button
              >
            </div>
          </form>
        </div>
      </section>

      {#if selectedFinding}
        <aside class="source-panel" aria-label="Finding source" data-testid="source-panel">
          <header class="source-header">
            <ReviewIcon name="file-text" size={16} /><strong>{selectedFinding.title}</strong><span
              class="spacer"
            ></span><button
              class="icon-button"
              aria-label="Close source panel"
              onclick={closeSource}><ReviewIcon name="x" size={17} /></button
            >
          </header>
          <div class="source-tabs">
            <button
              class:current={sourceTab === "evidence"}
              onclick={() => (sourceTab = "evidence")}>Evidence</button
            >
            <button class:current={sourceTab === "sheets"} onclick={() => (sourceTab = "sheets")}
              >Sheets</button
            >
            <button
              class:current={sourceTab === "revision"}
              onclick={() => (sourceTab = "revision")}>Revision</button
            >
          </div>
          <div class="source-scroll">
            {#if sourceTab === "evidence"}
              {#if sourceImageUrl}
                <SourceViewer
                  imageUrl={sourceImageUrl}
                  pdfToPixels={sourceArtifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
                  overlays={sourceOverlays}
                  label="Original source render"
                />
              {:else}
                <p role="status">Rendering source…</p>
              {/if}
              {#key selectedFinding.id}
              <FindingInspector
                finding={selectedFinding}
                {sheets}
                {facts}
                {checks}
                {busy}
                onAccept={acceptCount}
                onEvaluate={evaluateFinding}
                onCorrect={() => {}}
                onStatus={setFindingStatus}
                onRequestDetail={requestDetail}
              />
              {/key}
            {:else if sourceTab === "sheets"}
              <ul class="sheet-list" data-testid="sheet-list">
                {#each sheets as sheet (sheet.id)}
                  <li>
                    <strong>{sheetCaption(sheet)}</strong>
                    <label>Label<input data-sheet-label={sheet.id} value={sheet.label} /></label>
                    <label
                      >Coverage<select data-sheet-coverage={sheet.id} value={sheet.coverage}>
                        <option value="unreviewed">Unreviewed</option>
                        <option value="partial">Partial</option>
                        <option value="reviewer_complete">Reviewer complete</option>
                      </select></label
                    >
                    <button
                      type="button"
                      data-testid={`confirm-sheet-${sheet.id}`}
                      disabled={busy}
                      onclick={(event) => {
                        const row = (event.currentTarget as HTMLButtonElement).closest("li");
                        const label =
                          row?.querySelector<HTMLInputElement>(`[data-sheet-label="${sheet.id}"]`)
                            ?.value ?? sheet.label;
                        const coverage =
                          (row?.querySelector<HTMLSelectElement>(
                            `[data-sheet-coverage="${sheet.id}"]`,
                          )?.value as Sheet["coverage"]) ?? sheet.coverage;
                        void confirmSheet(sheet, label, coverage);
                      }}>Confirm sheet</button
                    >
                  </li>
                {/each}
              </ul>
              <button
                type="button"
                class="primary"
                data-testid="open-create-finding"
                onclick={() => (createFindingOpen = true)}>Create coordination finding</button
              >
              {#if createFindingOpen}
                <form
                  class="finding-form"
                  data-testid="create-finding-form"
                  onsubmit={createFinding}
                >
                  <label>Title<input bind:value={findingTitle} required /></label>
                  <label>Object class<input bind:value={findingObjectClass} required /></label>
                  <label
                    >Drawn sheet<select bind:value={findingDrawnSheet} required>
                      <option value="">Select…</option>
                      {#each sheets.filter((s) => s.confirmed) as sheet (sheet.id)}
                        <option value={sheet.id}>{sheet.label}</option>
                      {/each}
                    </select></label
                  >
                  <label
                    >Scheduled sheet<select bind:value={findingScheduledSheet} required>
                      <option value="">Select…</option>
                      {#each sheets.filter((s) => s.confirmed) as sheet (sheet.id)}
                        <option value={sheet.id}>{sheet.label}</option>
                      {/each}
                    </select></label
                  >
                  <label class="checkbox"
                    ><input type="checkbox" bind:checked={findingApplicability} />Applicability
                    confirmed</label
                  >
                  <button type="submit" data-testid="create-finding-submit" disabled={busy}
                    >Create finding</button
                  >
                </form>
              {/if}
            {:else}
              {#if revisions.length >= 2}
                {@const latest = revisions.at(-1)}
                {@const previous = revisions.at(-2)}
                {#if latest && previous}
                  <p>Map sheets from {previous.name} to {latest.name}.</p>
                  <ul class="sheet-list">
                    {#each sheets.filter((s) => s.revisionId === previous.id) as oldSheet (oldSheet.id)}
                      {@const candidates = sheets.filter((s) => s.revisionId === latest.id)}
                      <li>
                        {oldSheet.label}
                        {@const choice = revisionChoices.find((pair) => pair.oldSheetId === oldSheet.id)}
                        <label>New sheet<select value={choice?.newSheetId ?? ""} data-testid={`revision-map-${oldSheet.id}`} onchange={(event) => stageRevision(oldSheet.id,{ newSheetId: event.currentTarget.value })}>
                          <option value="">Select new sheet…</option>
                          {#each candidates as candidate (candidate.id)}<option value={candidate.id}>{candidate.label}</option>{/each}
                        </select></label>
                        <label>Contents<select value={choice?.content ?? "changed"} data-testid={`revision-content-${oldSheet.id}`} onchange={(event) => stageRevision(oldSheet.id,{ content: event.currentTarget.value === "unchanged" ? "unchanged" : "changed" })}>
                          <option value="changed">Changed</option><option value="unchanged">Unchanged</option>
                        </select></label>
                        <label><input type="checkbox" checked={choice?.confirmed ?? false} data-testid={`revision-confirm-${oldSheet.id}`} onchange={(event) => stageRevision(oldSheet.id,{ confirmed: event.currentTarget.checked })} />Sheet correspondence confirmed</label>
                      </li>
                    {/each}
                  </ul>
                  <p>Confirm each match. Unsure sheets remain unresolved.</p>
                  <button data-testid="apply-revision" disabled={busy || sheets.filter((sheet) => sheet.revisionId === previous.id).some((sheet) => !revisionChoices.some((pair) => pair.oldSheetId === sheet.id && pair.newSheetId))} onclick={async () => { await associateRevision(latest.id,revisionChoices.filter((pair) => sheets.some((sheet) => sheet.id === pair.oldSheetId && sheet.revisionId === previous.id))); revisionChoices = []; }}>Apply revision correspondence</button>
                {/if}
              {:else}
                <p>Import a revision PDF to map sheet correspondence.</p>
              {/if}
            {/if}
          </div>
        </aside>
      {/if}
    </div>

    <section
      id="review-findings"
      class="findings-bubble"
      popover="auto"
      bind:this={findingsBubble}
      aria-label="Workspace findings"
      ontoggle={(event) => {
        popoverOpen = event.newState === "open";
      }}
    >
      {#if project}
        <div class="bubble-context">
          <ReviewIcon name="folder" size={17} /><strong>{project.name}</strong>
        </div>
        <div class="bubble-results">
          {#each findings as finding (finding.id)}
            <button
              class="finding-row"
              class:selected={selectedFindingId === finding.id}
              data-testid={`finding-row-${finding.id}`}
              onclick={() => openFinding(finding)}
              title={findingSubtitle(finding, sheets)}
            >
              <ReviewIcon name="file-text" size={16} /><span>{finding.title}</span><span
                class="outcome">{formatOutcome(finding.outcome)}</span
              ><ReviewIcon name="chevron-right" size={14} />
            </button>
          {/each}
        </div>
      {/if}
    </section>

    {#if searchOpen}
      <section class="search-panel" aria-label="Search findings">
        <div class="search-field">
          <ReviewIcon name="search" size={18} /><input
            aria-label="Search findings"
            bind:value={findQuery}
          /><button
            class="icon-button"
            aria-label="Close search"
            onclick={() => (searchOpen = false)}><ReviewIcon name="x" size={16} /></button
          >
        </div>
        <div class="search-results">
          {#each visibleFindings as finding (finding.id)}
            <button class="finding-row" onclick={() => openFinding(finding)}>{finding.title}</button
            >
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .workbench-root,
  .workbench-root :global(*) {
    box-sizing: border-box;
  }
  .workbench-root {
    font-family:
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    min-height: 100vh;
    background: var(--nd-shell);
    color: var(--nd-ink);
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
    --nd-focus: #ededed;
    --sidebar-width: 240px;
    --source-width: min(420px, 42vw);
    height: 100vh;
    overflow: hidden;
    background: var(--nd-shell);
    color: var(--nd-ink);
    display: flex;
    flex-direction: column;
    color-scheme: dark;
  }
  .workbench-root[data-theme="light"] .desktop {
    --nd-shell: #fdfdfd;
    --nd-panel: #f6f6f6;
    --nd-raised: #ededed;
    --nd-raised-hover: #e6e6e6;
    --nd-hairline: #e6e6e6;
    --nd-hairline-strong: #d4d4d4;
    --nd-ink: #252525;
    --nd-ink-muted: #686868;
    color-scheme: light;
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
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 14px;
    background: var(--nd-panel);
    border-right: 1px solid var(--nd-hairline);
    align-self: stretch;
  }
  .brand-name {
    font-size: 14px;
    font-weight: 600;
  }
  .icon-button,
  .ghost,
  .findings-trigger,
  .theme-picker {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .icon-button {
    display: inline-flex;
    width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: var(--nd-ink-muted);
  }
  .icon-button:hover,
  .ghost:hover,
  .findings-trigger:hover {
    background: var(--nd-raised-hover);
  }
  .breadcrumbs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .project-crumb {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    color: var(--nd-ink-muted);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .project-monogram {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
  }
  .window-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .ghost,
  .findings-trigger {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
    font-size: 13px;
  }
  .finding-count {
    background: var(--nd-raised);
    padding: 0 6px;
    border-radius: 999px;
    font-size: 12px;
  }
  .app-body {
    flex: 1;
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    min-height: 0;
  }
  .desktop.source-open .app-body {
    grid-template-columns: var(--sidebar-width) 1fr var(--source-width);
  }
  .desktop.sidebar-closed .app-body {
    grid-template-columns: 1fr;
  }
  .desktop.sidebar-closed.source-open .app-body {
    grid-template-columns: 1fr var(--source-width);
  }
  .sidebar {
    background: var(--nd-panel);
    border-right: 1px solid var(--nd-hairline);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow-y: auto;
  }
  .new-chat,
  .project-heading,
  .threads button {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .threads button.current,
  .finding-row.selected {
    background: var(--nd-raised);
  }
  .chat {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .chat-scroll {
    flex: 1;
    overflow: auto;
    padding: 24px;
  }
  .message {
    max-width: 42rem;
    margin-bottom: 16px;
    font-size: 15px;
    line-height: 1.75;
  }
  .application-message {
    color: var(--nd-ink-muted);
  }
  .byline {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    margin-bottom: 4px;
  }
  .user-mark {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--nd-raised);
    font-size: 11px;
  }
  .composer {
    border-top: 1px solid var(--nd-hairline);
    padding: 12px 16px;
    display: flex;
    gap: 8px;
  }
  .composer textarea {
    flex: 1;
    resize: vertical;
    min-height: 44px;
    font: inherit;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-panel);
    color: inherit;
  }
  .send {
    width: 36px;
    height: 36px;
    border-radius: 999px;
    border: 0;
    background: var(--nd-ink);
    color: var(--nd-shell);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .source-panel {
    border-left: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .source-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .spacer {
    flex: 1;
  }
  .source-tabs {
    display: flex;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .source-tabs button {
    padding: 6px 10px;
    border-radius: 6px;
    border: 0;
    background: transparent;
    color: var(--nd-ink-muted);
    cursor: pointer;
    font: inherit;
  }
  .source-tabs button.current {
    background: var(--nd-raised);
    color: var(--nd-ink);
  }
  .source-scroll {
    flex: 1;
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .findings-bubble {
    margin: 0;
    padding: 16px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 14px;
    background: var(--nd-panel);
    color: var(--nd-ink);
    box-shadow: 0 18px 40px rgb(0 0 0 / 0.35);
  }
  .finding-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 12px;
    border-radius: 10px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .finding-row span.outcome {
    margin-left: auto;
    font-size: 12px;
    color: var(--nd-ink-muted);
  }
  .banner {
    margin: 0;
    padding: 10px 16px;
    background: #5a1f1f;
    color: #ffe8e8;
  }
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 16px;
    text-align: center;
  }
  .chat-empty h1 {
    margin: 0;
    font-size: 22px;
  }
  .create-project,
  .finding-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .create-project input,
  .finding-form input,
  .finding-form select {
    font: inherit;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-shell);
    color: inherit;
  }
  .sheet-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sheet-list li {
    padding: 10px;
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sheet-setup h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--nd-ink-muted);
  }
  .sheet-list.compact li {
    padding: 8px;
    font-size: 12px;
  }
  button.primary {
    padding: 8px 12px;
    border-radius: 8px;
    border: 0;
    background: var(--nd-ink);
    color: var(--nd-shell);
    cursor: pointer;
    font: inherit;
  }
  .progress-row {
    font-size: 12px;
    color: var(--nd-ink-muted);
    padding: 4px 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .search-panel {
    position: fixed;
    inset: 80px 20% auto;
    background: var(--nd-panel);
    border: 1px solid var(--nd-hairline);
    border-radius: 12px;
    padding: 12px;
    z-index: 20;
  }
  @media (max-width: 900px) {
    .desktop.source-open .app-body {
      grid-template-columns: 1fr;
    }
    .source-panel {
      position: fixed;
      inset: 52px 0 0;
      z-index: 10;
    }
  }
</style>
