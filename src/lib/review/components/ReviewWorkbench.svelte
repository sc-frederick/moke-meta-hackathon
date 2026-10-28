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
  import { ReviewCommand, OperationId, RevisionId } from "#lib/review/contracts.ts";
  import { newCommandId, reviewCommand, type ReviewClient } from "#lib/review/client.ts";
  import ExecutionControls from "./ExecutionControls.svelte";
  import SheetSetup from "./SheetSetup.svelte";
  import { sendReviewMessage } from "#lib/review/conversation.ts";
  import {
    ExecutionBudget,
    ReviewDiscipline,
    reviewDisciplines,
    type ExecutionSetup,
    type ExecutionStatus,
  } from "#lib/review/execution.ts";
  import FindingInspector from "./FindingInspector.svelte";
  import ReviewIcon from "./ReviewIcon.svelte";
  import SourceViewer from "./SourceViewer.svelte";
  import { findingSubtitle, formatOutcome, projectMonogram } from "./review-format.ts";

  let { client }: { client: ReviewClient } = $props();

  let theme = $state<"dark" | "light">("dark");
  let sidebarOpen = $state(true);
  let mobileNavigationOpen = $state(false);
  let popoverOpen = $state(false);
  let searchOpen = $state(false);
  let findQuery = $state("");
  let ready = $state(false);
  let busy = $state(false);
  let importing = $state(false);
  let error = $state("");
  let snapshot = $state.raw<ReviewSnapshot | null>(null);
  let eventCursor = $state(0);

  let selectedProjectId = $state<Project["id"] | null>(null);
  let selectedConversationId = $state<string | null>(null);
  let selectedFindingId = $state<string | null>(null);
  let sourceTab = $state<"evidence" | "sheets" | "revision" | "settings">("evidence");
  let panelOpen = $state(false);
  let reviewFindingId = $state<string | null>(null);
  let reviewMode = $state<"review" | "note">("review");
  let discipline = $state<typeof ReviewDiscipline.Type>("general");
  let setup = $state.raw<ExecutionSetup | null>(null);
  let executionStatus = $state.raw<ExecutionStatus | null>(null);
  let callLimit = $state(12);
  let notice = $state("");
  let sourceLoading = $state(false);
  let previewedSheet = $state.raw<Sheet | null>(null);
  let projectConversations = $state.raw<Readonly<Record<string, ReadonlyArray<Conversation>>>>({});
  const conversationViews = new Map<string, { draft: string; scroll: number }>();
  let sourceRequest = 0;
  let refreshRequest = 0;

  let newProjectName = $state("");
  let draft = $state("");
  let expandedProjects = $state.raw<ReadonlyArray<string>>([]);

  let createFindingOpen = $state(false);
  let newProjectOpen = $state(false);
  let sourceSide = $state<"drawn" | "scheduled">("drawn");

  let revisionChoices = $state<
    Array<{
      oldSheetId: string;
      newSheetId: string;
      confirmed: boolean;
      content: "changed" | "unchanged";
    }>
  >([]);

  function stageRevision(
    oldSheetId: string,
    update: { newSheetId?: string; confirmed?: boolean; content?: "changed" | "unchanged" },
  ) {
    const previous = revisionChoices.find((pair) => pair.oldSheetId === oldSheetId);
    revisionChoices = [
      ...revisionChoices.filter((pair) => pair.oldSheetId !== oldSheetId),
      {
        oldSheetId,
        newSheetId: previous?.newSheetId ?? "",
        confirmed: previous?.confirmed ?? false,
        content: previous?.content ?? "changed",
        ...update,
      },
    ];
  }

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
  let searchInput: HTMLInputElement | undefined = $state();

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
  const reviewFinding = $derived(findings.find((item) => item.id === reviewFindingId) ?? null);

  const budget = $derived(
    new ExecutionBudget({ maxCalls: callLimit, maxInputTokens: 64000, maxOutputTokens: 4096 }),
  );

  const executionBlocked = $derived(
    executionStatus !== null &&
      (["running", "pausing", "paused", "uncertain"].includes(executionStatus.state) ||
        (executionStatus.unresolvedAttempts > 0 && !executionStatus.uncertaintyAcknowledged)),
  );

  const visibleFindings = $derived(
    findings.filter((finding) =>
      `${finding.title} ${finding.objectClass} ${findingSubtitle(finding, sheets)} ${formatOutcome(finding.outcome)}`
        .toLowerCase()
        .includes(findQuery.toLowerCase()),
    ),
  );

  const conversationMessages = $derived(
    activeConversation === null
      ? []
      : messages.filter((message) => message.conversationId === activeConversation.id),
  );

  async function refresh(projectId: typeof selectedProjectId = selectedProjectId) {
    const request = ++refreshRequest;
    const result = await client.snapshot(projectId, eventCursor);

    if (request !== refreshRequest) return;

    if (!result.ok) {
      error = result.error.message;

      return;
    }

    const sameProject = snapshot?.project?.id === result.value.project?.id;

    const events = sameProject
      ? [...(snapshot?.events ?? []), ...result.value.events]
      : result.value.events;

    const seen = new Set<number>();
    snapshot = {
      ...result.value,
      events: events.filter((event) => {
        if (seen.has(event.sequence)) return false;
        seen.add(event.sequence);

        return true;
      }),
    };
    error = "";

    if (result.value.project !== null)
      projectConversations = {
        ...projectConversations,
        [result.value.project.id]: result.value.conversations,
      };

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
    rememberConversation();
    eventCursor = 0;

    const ok = await runCommand(
      reviewCommand(ReviewCommand.cases.CreateProject.make({ commandId: newCommandId(), name })),
    );

    if (!ok) return;
    newProjectName = "";
    newProjectOpen = false;
    selectedFindingId = null;
    selectedConversationId = snapshot?.conversations[0]?.id ?? null;
    reviewFindingId = null;
    executionStatus = null;
    draft = "";
    closeSource();
  }

  function rememberConversation() {
    if (activeConversation)
      conversationViews.set(activeConversation.id, { draft, scroll: chatViewport?.scrollTop ?? 0 });
  }

  async function selectProject(entry: Project, conversationId?: string) {
    rememberConversation();

    if (entry.id === selectedProjectId) {
      if (conversationId) await chooseConversation(conversationId);

      return;
    }

    closeSource();
    reviewFindingId = null;
    executionStatus = null;
    eventCursor = 0;
    selectedProjectId = entry.id;
    selectedConversationId = null;
    selectedFindingId = null;
    await refresh(entry.id);
    const first = snapshot?.conversations[0];
    await chooseConversation(conversationId ?? first?.id ?? null, false);
  }

  async function createConversation() {
    if (project === null) return;
    rememberConversation();

    const ok = await runCommand(
      reviewCommand(
        ReviewCommand.cases.CreateConversation.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          title: `Drawing review ${conversations.length + 1}`,
        }),
      ),
    );

    if (ok) await chooseConversation(snapshot?.conversations.at(-1)?.id ?? null, false);
  }

  async function postMessage(event: SubmitEvent) {
    event.preventDefault();

    if (project === null || activeConversation === null) return;
    const text = draft.trim();

    if (!text) return;

    const command = ReviewCommand.cases.PostMessage.make({
      commandId: newCommandId(),
      projectId: project.id,
      expectedVersion: project.version,
      conversationId: activeConversation.id,
      text,
    });

    if (reviewMode === "review") {
      if (reviewFinding === null || !setup?.configured || executionBlocked) return;
      busy = true;

      const result = await sendReviewMessage(client, {
        command,
        executionCommandId: newCommandId(),
        findingId: reviewFinding.id,
        discipline,
        budget,
      });

      if (result.saved) draft = "";
      await refresh();

      if (result.saved) executionStatus = result.execution;
      error = result.error ?? "";
      busy = false;
    } else if (await runCommand(command)) {
      draft = "";
      notice = "Note saved.";
    }

    await tick();

    if (chatViewport) chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  async function importPdf() {
    if (project === null) return;
    busy = true;
    importing = true;

    const result = await client.chooseReviewPdf({
      projectId: project.id,
      expectedVersion: project.version,
      commandId: newCommandId(),
    });

    if (!result.ok) {
      busy = false;
      importing = false;
      error = result.error.message;

      return;
    }

    if (result.value === null) {
      busy = false;
      importing = false;

      return;
    }

    await refresh(result.value.projectId);
    sourceRequest++;
    sourceLoading = false;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    panelOpen = true;
    sourceTab = "sheets";
    previewedSheet = null;
    notice = "PDF imported. Review and confirm its sheets, then create a coordination check.";
    busy = false;
    importing = false;
  }

  async function confirmSheet(sheet: Sheet, label: string, coverage: Sheet["coverage"]) {
    if (project === null) return;
    const trimmed = label.trim() || `Sheet ${sheet.pageIndex + 1}`;
    await runCommand(
      reviewCommand(
        ReviewCommand.cases.ConfirmSheet.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          sheetId: sheet.id,
          label: trimmed,
          coverage,
        }),
      ),
    );
  }

  async function createFinding(input: {
    title: string;
    objectClass: string;
    drawnSheetId: string;
    scheduledSheetId: string;
    applicabilityConfirmed: boolean;
  }) {
    if (project === null) return false;

    if (!input.title || !input.objectClass) {
      error = "Enter a title and object class for this check.";

      return false;
    }

    const drawn = sheets.find((sheet) => sheet.id === input.drawnSheetId);
    const scheduled = sheets.find((sheet) => sheet.id === input.scheduledSheetId);

    if (drawn === undefined || scheduled === undefined) {
      error = "Choose both source sheets.";

      return false;
    }

    const ok = await runCommand(
      reviewCommand(
        ReviewCommand.cases.CreateFinding.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          title: input.title,
          objectClass: input.objectClass,
          drawnSheetId: drawn.id,
          scheduledSheetId: scheduled.id,
          applicabilityConfirmed: input.applicabilityConfirmed,
        }),
      ),
    );

    if (!ok) return false;
    createFindingOpen = false;
    const latest = snapshot?.findings.at(-1);

    if (latest) openFinding(latest);

    return true;
  }

  async function loadSourceForFinding(
    finding: Finding,
    dpi: number,
    region?: { x: number; y: number; width: number; height: number },
    side: "drawn" | "scheduled" = "drawn",
  ) {
    if (project === null) return;
    sourceSide = side;

    const sheet = sheets.find(
      (item) => item.id === (side === "drawn" ? finding.drawnSheetId : finding.scheduledSheetId),
    );

    if (sheet === undefined) return;

    await loadSheetSource(sheet, dpi, region, finding);
  }

  async function loadSheetSource(
    sheet: Sheet,
    dpi: number,
    region?: { x: number; y: number; width: number; height: number },
    finding?: Finding,
  ) {
    if (project === null) return;
    const request = ++sourceRequest;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    sourceOverlays = [];
    previewedSheet = sheet;
    sourceLoading = true;

    const targetRegion = region ?? {
      x: sheet.box.x,
      y: sheet.box.y,
      width: sheet.box.width,
      height: sheet.box.height,
    };

    const rendered = await client.renderSource({
      projectId: project.id,
      sheetId: sheet.id,
      operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
      region: targetRegion,
      dpi,
    });

    if (!rendered.ok) {
      if (request !== sourceRequest) return;
      sourceLoading = false;
      error = rendered.error.message;

      return;
    }

    const artifact = rendered.value;
    const blob = await client.loadArtifactBlobUrl(project.id, artifact);

    if (request !== sourceRequest) {
      if (blob.ok) URL.revokeObjectURL(blob.value);

      return;
    }

    sourceLoading = false;

    if (!blob.ok) {
      error = blob.error.message;

      return;
    }

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = blob.value;
    sourceArtifact = artifact;
    const drawn = facts.findLast((fact) => fact.findingId === finding?.id && fact.side === "drawn");

    const scheduled = facts.findLast(
      (fact) => fact.findingId === finding?.id && fact.side === "scheduled",
    );

    sourceOverlays = [
      ...(drawn?.evidence.sheetId === sheet.id
        ? [{ region: drawn.evidence.region, title: "Drawn evidence" }]
        : []),
      ...(scheduled?.evidence.sheetId === sheet.id
        ? [{ region: scheduled.evidence.region, title: "Scheduled evidence" }]
        : []),
    ];
  }

  function openFinding(finding: Finding) {
    selectedFindingId = finding.id;
    selectReviewFinding(finding.id);
    panelOpen = true;
    sourceTab = "evidence";
    closeFindings();
    searchOpen = false;
    mobileNavigationOpen = false;
    void loadSourceForFinding(finding, 96);
  }

  function closeSource() {
    sourceRequest++;
    sourceLoading = false;
    panelOpen = false;
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
    if (
      window.matchMedia("(max-width: 700px)").matches ||
      (panelOpen && window.matchMedia("(max-width: 1180px)").matches)
    ) {
      sidebarOpen = true;
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

  async function chooseConversation(id: string | null, remember = true) {
    if (remember) rememberConversation();
    selectedConversationId = id;
    draft = id === null ? "" : (conversationViews.get(id)?.draft ?? "");
    mobileNavigationOpen = false;
    closeFindings();
    await tick();

    if (chatViewport)
      chatViewport.scrollTop =
        (id === null ? 0 : conversationViews.get(id)?.scroll) ?? chatViewport.scrollHeight;
  }

  function selectReviewFinding(id: string) {
    if (reviewFindingId !== id) executionStatus = null;
    reviewFindingId = id || null;
  }

  function openSetup(tab: "sheets" | "settings" | "revision", create = false) {
    panelOpen = true;
    sourceTab = tab;
    createFindingOpen = create;
    closeFindings();
    mobileNavigationOpen = false;
  }

  async function openSearch() {
    closeFindings();
    searchOpen = true;
    findQuery = "";
    await tick();
    searchInput?.focus();
  }

  function handleKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      closeFindings();

      if (searchOpen) searchOpen = false;
      else void openSearch();
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void createConversation();
    }

    if (event.key === "Escape") {
      searchOpen = false;
      mobileNavigationOpen = false;

      if (!popoverOpen && panelOpen) closeSource();
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
      reviewCommand(
        ReviewCommand.cases.AcceptCount.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          findingId: selectedFinding.id,
          side,
          value: payload.value,
          unit: "count",
          coverageConfirmed: payload.coverageConfirmed,
          evidence: { sheetId, region: payload.region, statement: payload.statement },
          rationale: payload.rationale,
        }),
      ),
    );

    if (selectedFinding)
      await loadSourceForFinding(
        selectedFinding,
        sourceArtifact?.dpi ?? 96,
        sourceArtifact?.region ?? undefined,
        sourceSide,
      );
  }

  async function evaluateFinding() {
    if (project === null || selectedFinding === null) return;
    await runCommand(
      reviewCommand(
        ReviewCommand.cases.EvaluateFinding.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          findingId: selectedFinding.id,
        }),
      ),
    );
  }

  async function setFindingStatus(closed: boolean, taskCompleted: boolean) {
    if (project === null || selectedFinding === null) return;
    await runCommand(
      reviewCommand(
        ReviewCommand.cases.SetFindingStatus.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          findingId: selectedFinding.id,
          closed,
          taskCompleted,
        }),
      ),
    );
  }

  async function requestDetail(
    side: "drawn" | "scheduled",
    selectedRegion?: import("#lib/review/contracts.ts").Region,
  ) {
    if (selectedFinding === null) return;

    const sheetId =
      side === "drawn" ? selectedFinding.drawnSheetId : selectedFinding.scheduledSheetId;

    const sheet = sheets.find((item) => item.id === sheetId);

    if (sheet === undefined) return;

    const fact = facts.findLast(
      (entry) => entry.findingId === selectedFinding.id && entry.side === side,
    );

    const region = selectedRegion ??
      fact?.evidence.region ?? {
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
      reviewCommand(
        ReviewCommand.cases.AssociateRevision.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          revisionId: Schema.decodeUnknownSync(RevisionId)(revisionId),
          correspondence: Schema.decodeUnknownSync(
            ReviewCommand.cases.AssociateRevision.fields.correspondence,
          )(pairs),
        }),
      ),
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
          projectConversations = { [result.value.project.id]: result.value.conversations };
          expandedProjects = [result.value.project.id];
        }
      } else {
        error = result.error.message;
      }

      ready = true;
    });
    void client.executionSetup().then((result) => {
      if (controller.signal.aborted) return;

      if (result.ok) setup = result.value;
      else error = result.error.message;
    });

    return () => {
      controller.abort();
      sourceRequest++;

      if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    };
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
    class={[
      "desktop",
      {
        "sidebar-closed": !sidebarOpen,
        "source-open": panelOpen,
        "mobile-navigation-open": mobileNavigationOpen,
      },
    ]}
    data-testid="review-workbench"
  >
    <header class="window-bar">
      <div class="brand-slot">
        <button class="icon-button" aria-label="Toggle conversation sidebar" onclick={toggleSidebar}
          ><ReviewIcon name="layout-sidebar" size={17} /></button
        ><span class="brand-name">Moke</span>
      </div>
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        {#if project}<span class="project-crumb" title={project.name}
            ><span class="project-monogram" aria-hidden="true">{projectMonogram(project.name)}</span
            ><span>{project.name}</span></span
          ><span class="breadcrumb-divider" aria-hidden="true">/</span>{/if}
        <strong aria-current="page">{activeConversation?.title ?? "Drawing review"}</strong>
      </nav>
      <div class="window-actions">
        <button
          class="theme-picker"
          onclick={() => (theme = theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Use light appearance" : "Use dark appearance"}
          >{theme === "dark" ? "Light" : "Dark"}</button
        >
        {#if project}
          <button
            type="button"
            class="ghost"
            disabled={busy}
            data-testid="import-pdf"
            aria-busy={importing}
            onclick={importPdf}
            ><ReviewIcon name="upload" size={15} /><span
              >{importing ? "Importing PDF…" : "Import PDF"}</span
            ></button
          >
          <button class="ghost sheets-trigger" onclick={() => openSetup("sheets")}
            ><ReviewIcon name="file-text" size={15} /><span>Sheets</span><span class="finding-count"
              >{sheets.length}</span
            ></button
          >
          <button
            class={["findings-trigger", { expanded: popoverOpen }]}
            disabled={busy}
            bind:this={findingsButton}
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
          <button
            class="new-chat"
            data-testid="new-conversation"
            onclick={createConversation}
            disabled={!project || busy}
            ><ReviewIcon name="plus" size={16} /><span>New conversation</span></button
          >
          <button class="nav-action" onclick={openSearch}
            ><ReviewIcon name="search" size={16} /><span>Search findings</span><kbd>⌘ K</kbd
            ></button
          >
          {#if !ready}<p role="status">Loading projects…</p>{/if}
          {#if ready && (projects.length === 0 || newProjectOpen)}
            <form class="create-project" data-testid="create-project-form" onsubmit={createProject}>
              <h2>Create a project</h2>
              <label
                >Project name<input
                  data-testid="project-name-input"
                  bind:value={newProjectName}
                  required
                  maxlength="160"
                  placeholder="Project name"
                /></label
              >
              <div class="actions">
                {#if projects.length > 0}<button
                    type="button"
                    onclick={() => (newProjectOpen = false)}>Cancel</button
                  >{/if}<button
                  class="primary"
                  type="submit"
                  disabled={busy}
                  data-testid="create-project-button">Create project</button
                >
              </div>
            </form>
          {/if}
          <nav class="projects" aria-label="Projects">
            {#each projects as entry (entry.id)}
              <section class="project-group" aria-label={entry.name}>
                <button
                  class="project-heading"
                  disabled={busy}
                  aria-expanded={expandedProjects.includes(entry.id)}
                  onclick={async () => {
                    toggleProject(entry.id);
                    await selectProject(entry);
                  }}
                  ><ReviewIcon
                    name={expandedProjects.includes(entry.id) ? "chevron-down" : "chevron-right"}
                    size={13}
                  /><ReviewIcon name="folder" size={16} /><span title={entry.name}
                    >{entry.name}</span
                  ></button
                >
                {#if expandedProjects.includes(entry.id)}
                  <div class="threads">
                    {#each projectConversations[entry.id] ?? [] as thread (thread.id)}
                      <button
                        class={{ current: selectedConversationId === thread.id }}
                        disabled={busy}
                        aria-current={selectedConversationId === thread.id ? "page" : undefined}
                        data-testid={"conversation-" + thread.id}
                        onclick={() => selectProject(entry, thread.id)}
                        ><ReviewIcon name="message" size={14} /><span title={thread.title}
                          >{thread.title}</span
                        ></button
                      >
                    {/each}
                  </div>
                {/if}
              </section>
            {/each}
          </nav>
          <div class="sidebar-footer">
            <button class="nav-action" onclick={() => (newProjectOpen = true)} disabled={busy}
              ><ReviewIcon name="folder" size={16} /><span>New project</span></button
            >
            <button class="nav-action" onclick={() => openSetup("settings")}
              ><ReviewIcon name="settings" size={16} /><span>Review settings</span><span
                class={["connection-dot", { connected: setup?.configured }]}
                title={setup?.configured ? "Provider configured" : "Provider not configured"}
              ></span></button
            >
            <div class="package-actions">
              <button
                disabled={busy || !project}
                onclick={async () => {
                  busy = true;
                  const result = await client.chooseReviewExport();
                  busy = false;
                  if (!result.ok) error = result.error.message;
                  else if (result.value) notice = "Complete review package exported.";
                }}>Export complete package</button
              ><button
                disabled={busy}
                onclick={async () => {
                  busy = true;
                  const result = await client.chooseReviewRestore();
                  busy = false;
                  if (!result.ok) error = result.error.message;
                }}>Restore package</button
              >
            </div>
          </div>
        </aside>
      {/if}
      <section class="chat" aria-label="Conversation">
        {#if error}<div class="banner" role="alert">
            <span>{error}</span><button
              class="icon-button"
              aria-label="Dismiss error"
              onclick={() => (error = "")}><ReviewIcon name="x" size={16} /></button
            >
          </div>{/if}
        {#if notice}<div class="notice" role="status">
            <span>{notice}</span><button
              class="icon-button"
              aria-label="Dismiss notification"
              onclick={() => (notice = "")}><ReviewIcon name="x" size={15} /></button
            >
          </div>{/if}
        <div class="chat-scroll" bind:this={chatViewport}>
          <div class="conversation-content">
            {#if !ready}<div class="chat-empty"><p role="status">Opening workspace…</p></div>
            {:else if project === null}<div class="chat-empty">
                {@render mark(28)}
                <h1>Start a drawing review</h1>
                <p>Create a project, import its drawings, and choose a coordination check.</p>
                <button
                  class="ghost"
                  onclick={() => {
                    sidebarOpen = true;
                    mobileNavigationOpen = true;
                    newProjectOpen = true;
                  }}>Create a project</button
                >
              </div>
            {:else if conversationMessages.length === 0}
              <div class="chat-empty">
                {@render mark(28)}
                <h1>What are we checking?</h1>
                {#if sheets.length === 0}<p>
                    Import a drawing PDF to begin. Your source sheets and review history stay with
                    this project.
                  </p>
                  <button class="ghost" disabled={busy} onclick={importPdf}
                    ><ReviewIcon name="upload" size={15} />Import drawings</button
                  >
                {:else if findings.length === 0}<p>
                    Confirm the source sheets and define a drawn-to-schedule count check. Then ask
                    Moke to inspect it.
                  </p>
                  <button class="ghost" onclick={() => openSetup("sheets", true)}
                    >Set up a coordination check</button
                  >
                {:else}<p>
                    Select a check below and ask Moke to inspect its drawing evidence. You decide
                    which observations to accept.
                  </p>{/if}
              </div>
            {/if}
            {#each conversationMessages as message (message.id)}
              <article
                class={["message", { "application-message": message.role === "application" }]}
              >
                <div class="byline">
                  {#if message.role === "reviewer"}<span class="user-mark">S</span>{:else}<span
                      class="moke-mark">{@render mark(16)}</span
                    >{/if}<strong>{message.role === "reviewer" ? "You" : "Moke"}</strong
                  >{#if message.origin}<span class="message-provenance"
                      >Inspection · {message.origin.discipline?.replaceAll("_", " ") ??
                        "general"}</span
                    >{/if}
                </div>
                <p>{message.text}</p>
                {#if message.origin}<button
                    class="message-source"
                    onclick={() => {
                      const finding = findings.find(
                        (item) => item.id === message.origin?.findingId,
                      );
                      if (finding) openFinding(finding);
                    }}>Open reviewed finding<ReviewIcon name="arrow-up-right" size={13} /></button
                  >{/if}
              </article>
            {/each}
          </div>
        </div>
        <div class="composer-region">
          {#if project}
            <div class="scope-bar">
              <label class="scope-select"
                ><span class="sr-only">Review finding</span><select
                  aria-label="Review finding"
                  value={reviewFindingId ?? ""}
                  onchange={(event) => selectReviewFinding(event.currentTarget.value)}
                  ><option value="">Choose a coordination check…</option
                  >{#each findings as finding (finding.id)}<option value={finding.id}
                      >{finding.title}</option
                    >{/each}</select
                ></label
              >
              <button
                class="text-button"
                data-testid="open-create-finding"
                onclick={() => openSetup("sheets", true)}
                ><ReviewIcon name="plus" size={14} />New check</button
              >
            </div>
            {#if reviewFinding}
              {#key reviewFinding.id}<ExecutionControls
                  {client}
                  finding={reviewFinding}
                  {setup}
                  {budget}
                  {discipline}
                  conversation={activeConversation}
                  projectVersion={project.version}
                  bind:status={executionStatus}
                  onProgress={() => refresh()}
                />{/key}
            {/if}
          {/if}
          <form class="composer" onsubmit={postMessage}>
            <label class="sr-only" for="chat-message">Message</label><textarea
              id="chat-message"
              bind:this={composerInput}
              bind:value={draft}
              rows="2"
              maxlength="2000"
              placeholder={reviewMode === "review"
                ? "Ask Moke to inspect the selected check…"
                : "Add a project note…"}
              disabled={project === null || activeConversation === null}></textarea>
            <div class="composer-tools">
              <div class="composer-options">
                <select aria-label="Message action" bind:value={reviewMode}
                  ><option value="review">Review with Moke</option><option value="note"
                    >Save note</option
                  ></select
                >{#if reviewMode === "review"}<select
                    aria-label="Review discipline"
                    bind:value={discipline}
                    >{#each reviewDisciplines as scope (scope.id)}<option value={scope.id}
                        >{scope.label}</option
                      >{/each}</select
                  >{/if}
              </div>
              <button
                type="submit"
                class="send"
                disabled={!draft.trim() ||
                  busy ||
                  !project ||
                  (reviewMode === "review" &&
                    (!reviewFinding || !setup?.configured || executionBlocked))}
                aria-label="Send message"
                title={reviewMode === "review" ? "Send and start bounded inspection" : "Save note"}
                ><ReviewIcon name="arrow-up" size={17} /></button
              >
            </div>
          </form>
          <div class="composer-help">
            {#if reviewMode === "note"}Notes are saved without starting an inspection.{:else if !reviewFinding}Choose
              a check or create one to review drawing evidence.{:else if !setup?.configured}Provider
              not configured. <button class="text-button" onclick={() => openSetup("settings")}
                >Open review settings</button
              >{:else if executionBlocked}Resolve the current inspection before sending another
              request.{:else}Up to {callLimit} calls · proposed evidence · governing code unverified{/if}
          </div>
        </div>
      </section>
      {#if panelOpen}
        <aside class="source-panel" aria-label="Finding source" data-testid="source-panel">
          <header class="source-header">
            <ReviewIcon
              name={sourceTab === "settings" ? "settings" : "file-text"}
              size={16}
            /><strong
              >{sourceTab === "settings"
                ? "Review settings"
                : sourceTab === "evidence"
                  ? (selectedFinding?.title ?? "Evidence")
                  : (project?.name ?? "Project")}</strong
            ><button class="icon-button" aria-label="Close source panel" onclick={closeSource}
              ><ReviewIcon name="x" size={17} /></button
            >
          </header>
          {#if sourceTab !== "settings"}<div class="source-tabs">
              <button
                class={{ current: sourceTab === "evidence" }}
                disabled={busy || !selectedFinding}
                onclick={() => {
                  if (selectedFinding === null) return;
                  sourceTab = "evidence";
                  void loadSourceForFinding(selectedFinding, 96, undefined, sourceSide);
                }}>Evidence</button
              ><button
                disabled={busy}
                class={{ current: sourceTab === "sheets" }}
                onclick={() => (sourceTab = "sheets")}>Sheets</button
              ><button
                class={{ current: sourceTab === "revision" }}
                disabled={busy}
                onclick={() => (sourceTab = "revision")}>Revision</button
              >
            </div>{/if}
          <div class="source-scroll">
            {#if sourceTab === "settings"}
              <section class="settings-section">
                <h2>Model connection</h2>
                {#if setup}<p>
                    {setup.configured
                      ? setup.provider + " · " + setup.model
                      : "No provider configured"}
                  </p>
                  <p class="muted">
                    Use File → Import provider credential configuration… to select your
                    configuration and restart. Credentials stay in the trusted desktop and backend.
                  </p>{:else}<p role="status">Loading configuration…</p>{/if}
              </section>
              <section class="settings-section">
                <h2>Inspection limit</h2>
                <label
                  >Maximum calls per inspection<select bind:value={callLimit}
                    ><option value={4}>4 calls</option><option value={8}>8 calls</option><option
                      value={12}>12 calls</option
                    ></select
                  ></label
                >
                <p class="muted">
                  The selection resets to 12 on restart. Includes at most 2 SAM requests when
                  available. Each model request reserves up to 64,000 text-input tokens and 4,096
                  output tokens. Billing and image-token usage are unknown. Nothing starts
                  automatically on reopen.
                </p>
              </section>
              <section class="settings-section">
                <h2>Review boundary</h2>
                <p>
                  This beta inspects one drawn-to-schedule count check at a time using its selected
                  PDF sheets. It does not complete a permit or discipline review.
                </p>
                <p class="muted">
                  Governing code is unverified: there is no browser or verified code library in this
                  runtime. Jurisdiction, adopted editions, permit stage, supporting calculations and
                  prior comments remain Needs input where relevant. Confirm them independently.
                </p>
                <p class="muted">
                  {setup?.segmentation
                    ? "SAM is available for proposed object locations."
                    : "SAM is unavailable for this provider route."} Only you accept facts, confirm coverage
                  and close findings.
                </p>
              </section>
              {#if setup}<section class="settings-section provenance">
                  <h2>Moke instructions</h2>
                  <p>{setup.promptVersion}</p>
                  <p>skills revision {setup.instructionRevision}</p>
                </section>{/if}
            {:else if sourceTab === "sheets"}
              {#if sourceLoading}<p class="muted" role="status">
                  Rendering source…
                </p>{:else if sourceImageUrl && previewedSheet}<SourceViewer
                  imageUrl={sourceImageUrl}
                  pdfToPixels={sourceArtifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
                  label="Original source render"
                />{/if}
              <SheetSetup
                {sheets}
                busy={busy || sourceLoading}
                bind:createOpen={createFindingOpen}
                onConfirm={confirmSheet}
                onPreview={(sheet) => {
                  void loadSheetSource(sheet, 96);
                }}
                onCreate={createFinding}
              />
            {:else if sourceTab === "evidence" && selectedFinding}
              {#if sourceLoading}<p class="muted" role="status">
                  Rendering source…
                </p>{:else if sourceImageUrl}<SourceViewer
                  imageUrl={sourceImageUrl}
                  pdfToPixels={sourceArtifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
                  overlays={sourceOverlays}
                  label="Original source render"
                />{/if}
              {#if previewedSheet && sourceArtifact}<div class="source-provenance">
                  <strong>{previewedSheet.label}</strong><span
                    >{revisions.find((item) => item.id === previewedSheet?.revisionId)?.name} · page
                    {previewedSheet.pageIndex + 1} · {sourceArtifact.dpi} DPI</span
                  ><span
                    >Source SHA {revisions
                      .find((item) => item.id === previewedSheet?.revisionId)
                      ?.sha256.slice(0, 16)}</span
                  >
                </div>{/if}
              {#key selectedFinding.id}<FindingInspector
                  finding={selectedFinding}
                  {sheets}
                  {facts}
                  {checks}
                  {busy}
                  onAccept={acceptCount}
                  onEvaluate={evaluateFinding}
                  onStatus={setFindingStatus}
                  onRequestDetail={requestDetail}
                />{/key}
            {:else if sourceTab === "revision"}
              {#if revisions.length >= 2}
                {@const latest = revisions.at(-1)}
                {@const previous = revisions.at(-2)}
                {#if latest && previous}
                  <p>Map sheets from {previous.name} to {latest.name}.</p>
                  <ul class="sheet-list">
                    {#each sheets.filter((s) => s.revisionId === previous.id) as oldSheet (oldSheet.id)}
                      {@const candidates = sheets.filter((s) => s.revisionId === latest.id)}
                      {@const choice = revisionChoices.find(
                        (pair) => pair.oldSheetId === oldSheet.id,
                      )}
                      <li>
                        {oldSheet.label}
                        <label
                          >New sheet<select
                            value={choice?.newSheetId ?? ""}
                            data-testid={`revision-map-${oldSheet.id}`}
                            onchange={(event) =>
                              stageRevision(oldSheet.id, { newSheetId: event.currentTarget.value })}
                          >
                            <option value="">Select new sheet…</option>
                            {#each candidates as candidate (candidate.id)}<option
                                value={candidate.id}>{candidate.label}</option
                              >{/each}
                          </select></label
                        >
                        <label
                          >Contents<select
                            value={choice?.content ?? "changed"}
                            data-testid={`revision-content-${oldSheet.id}`}
                            onchange={(event) =>
                              stageRevision(oldSheet.id, {
                                content:
                                  event.currentTarget.value === "unchanged"
                                    ? "unchanged"
                                    : "changed",
                              })}
                          >
                            <option value="changed">Changed</option><option value="unchanged"
                              >Unchanged</option
                            >
                          </select></label
                        >
                        <label
                          ><input
                            type="checkbox"
                            checked={choice?.confirmed ?? false}
                            data-testid={`revision-confirm-${oldSheet.id}`}
                            onchange={(event) =>
                              stageRevision(oldSheet.id, {
                                confirmed: event.currentTarget.checked,
                              })}
                          />Sheet correspondence confirmed</label
                        >
                      </li>
                    {/each}
                  </ul>
                  <p>Confirm each match. Unsure sheets remain unresolved.</p>
                  <button
                    data-testid="apply-revision"
                    disabled={busy ||
                      sheets
                        .filter((sheet) => sheet.revisionId === previous.id)
                        .some(
                          (sheet) =>
                            !revisionChoices.some(
                              (pair) => pair.oldSheetId === sheet.id && pair.newSheetId,
                            ),
                        )}
                    onclick={async () => {
                      await associateRevision(
                        latest.id,
                        revisionChoices.filter((pair) =>
                          sheets.some(
                            (sheet) =>
                              sheet.id === pair.oldSheetId && sheet.revisionId === previous.id,
                          ),
                        ),
                      );
                      revisionChoices = [];
                    }}>Apply revision correspondence</button
                  >
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
      ontoggle={(event) => (popoverOpen = event.newState === "open")}
    >
      {#if project}<div class="bubble-context">
          <ReviewIcon name="folder" size={17} /><strong>{project.name}</strong>
        </div>
        <div class="bubble-results">
          {#each findings as finding (finding.id)}<button
              class={["finding-row", { selected: selectedFindingId === finding.id }]}
              data-testid={"finding-row-" + finding.id}
              onclick={() => openFinding(finding)}
              title={findingSubtitle(finding, sheets)}
              ><ReviewIcon name="file-text" size={16} /><span class="finding-title"
                >{finding.title}</span
              ><span class="outcome">{formatOutcome(finding.outcome)}</span><ReviewIcon
                name="chevron-right"
                size={14}
              /></button
            >{:else}<p class="menu-empty">
              No findings yet. Define a coordination check to begin.
            </p>{/each}
        </div>{/if}
    </section>
    {#if searchOpen}<section class="search-panel" aria-label="Search findings">
        <div class="search-field">
          <ReviewIcon name="search" size={18} /><input
            aria-label="Search findings"
            bind:this={searchInput}
            bind:value={findQuery}
          /><button
            class="icon-button"
            aria-label="Close search"
            onclick={() => (searchOpen = false)}><ReviewIcon name="x" size={16} /></button
          >
        </div>
        <div class="search-results">
          {#each visibleFindings as finding (finding.id)}<button
              class="finding-row"
              onclick={() => openFinding(finding)}
              >{finding.title}<span class="outcome">{formatOutcome(finding.outcome)}</span></button
            >{:else}<p class="menu-empty">
              {findQuery ? "No matching findings." : "No findings in this project."}
            </p>{/each}
        </div>
      </section>{/if}
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
    font-size: 13px;
  }
  .desktop {
    --nd-shell: #141414;
    --nd-panel: #1b1b1b;
    --nd-raised: #262626;
    --nd-raised-hover: #303030;
    --nd-hairline: #2c2c2c;
    --nd-hairline-strong: #424242;
    --nd-ink: #ededed;
    --nd-ink-muted: #aaa;
    --nd-focus: #d8d8d8;
    --nd-warning: #edbc68;
    --sidebar-width: 224px;
    --source-width: min(420px, 40vw);
    height: 100dvh;
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
    --nd-raised-hover: #e7e7e7;
    --nd-hairline: #e2e2e2;
    --nd-hairline-strong: #cecece;
    --nd-ink: #252525;
    --nd-ink-muted: #626262;
    --nd-focus: #444;
    --nd-warning: #885509;
    color-scheme: light;
  }
  .desktop :global(::selection) {
    background: var(--nd-hairline-strong);
    color: var(--nd-ink);
  }
  .desktop :global(*) {
    scrollbar-width: thin;
    scrollbar-color: var(--nd-hairline-strong) transparent;
  }
  .desktop :global(:focus-visible) {
    outline: 2px solid var(--nd-focus);
    outline-offset: 3px;
  }
  .desktop :global(input),
  .desktop :global(select),
  .desktop :global(textarea) {
    font: inherit;
    color: inherit;
  }
  .desktop :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }
  .desktop :global(button:not(:disabled):hover) {
    filter: brightness(1.12);
  }
  .desktop :global(input),
  .desktop :global(select),
  .desktop :global(textarea) {
    accent-color: var(--nd-ink-muted);
    caret-color: var(--nd-ink);
  }
  .desktop :global(input::placeholder),
  .desktop :global(textarea::placeholder) {
    color: var(--nd-ink-muted);
    opacity: 1;
  }
  .desktop :global(p) {
    overflow-wrap: anywhere;
  }
  .window-bar {
    height: 52px;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding-right: 16px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .brand-slot {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
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
    font-weight: 650;
  }
  button {
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  .icon-button,
  .ghost,
  .findings-trigger,
  .theme-picker,
  .text-button {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .icon-button {
    display: inline-flex;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: var(--nd-ink-muted);
  }
  .icon-button:hover,
  .ghost:hover,
  .findings-trigger:hover,
  .nav-action:hover,
  .project-heading:hover,
  .threads button:hover {
    background: var(--nd-raised-hover);
  }
  .breadcrumbs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .breadcrumbs strong,
  .project-crumb > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .breadcrumbs strong {
    font-weight: 500;
  }
  .project-crumb {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    color: var(--nd-ink-muted);
    max-width: 200px;
    min-width: 40px;
  }
  .project-monogram {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
  }
  .breadcrumb-divider {
    color: var(--nd-ink-muted);
  }
  .window-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
  }
  .theme-picker {
    color: var(--nd-ink-muted);
    padding: 7px 5px;
  }
  .ghost,
  .findings-trigger {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 7px 10px;
    border-radius: 7px;
    border: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
    font-size: 13px;
  }
  .finding-count {
    background: var(--nd-raised);
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .app-body {
    flex: 1;
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    min-height: 0;
  }
  .desktop.source-open .app-body {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--source-width);
  }
  .desktop.sidebar-closed .app-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .desktop.sidebar-closed.source-open .app-body {
    grid-template-columns: minmax(0, 1fr) var(--source-width);
  }
  .sidebar {
    background: var(--nd-panel);
    border-right: 1px solid var(--nd-hairline);
    padding: 20px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow-y: auto;
  }
  .new-chat,
  .project-heading,
  .threads button,
  .nav-action {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    min-height: 34px;
    border-radius: 7px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .new-chat {
    border: 1px solid var(--nd-hairline-strong);
    margin-bottom: 3px;
  }
  .nav-action {
    color: var(--nd-ink-muted);
  }
  .nav-action kbd {
    margin-left: auto;
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
  }
  .projects {
    margin-top: 20px;
    display: grid;
    gap: 20px;
  }
  .project-heading {
    padding-left: 4px;
    color: var(--nd-ink-muted);
  }
  .project-heading span,
  .threads button span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .project-heading :global(svg),
  .threads :global(svg) {
    flex-shrink: 0;
  }
  .threads {
    margin: 3px 0 0 9px;
    padding-left: 10px;
    border-left: 1px solid var(--nd-hairline);
    display: grid;
    gap: 2px;
  }
  .threads button.current {
    background: var(--nd-raised);
  }
  .sidebar-footer {
    margin-top: auto;
    padding-top: 24px;
  }
  .connection-dot {
    margin-left: auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1px solid var(--nd-ink-muted);
  }
  .connection-dot.connected {
    background: var(--nd-ink-muted);
  }
  .package-actions {
    border-top: 1px solid var(--nd-hairline);
    margin-top: 10px;
    padding-top: 8px;
    display: grid;
  }
  .package-actions button {
    font-size: 12px;
    color: var(--nd-ink-muted);
    border: 0;
    background: transparent;
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
  }
  .chat {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .chat-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 100px;
    padding: 44px 28px 20px;
  }
  .conversation-content {
    max-width: 68ch;
    margin: 0 auto;
  }
  .message {
    margin-bottom: 28px;
    font-size: 15px;
    line-height: 1.75;
  }
  .message p {
    margin: 8px 0 0;
    white-space: pre-wrap;
  }
  .byline {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    line-height: 22px;
  }
  .byline strong {
    font-weight: 500;
  }
  .user-mark,
  .moke-mark {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 5px;
    font-size: 11px;
  }
  .user-mark {
    background: var(--nd-raised);
    color: var(--nd-ink-muted);
  }
  .message-provenance {
    font-size: 11px;
    color: var(--nd-ink-muted);
    margin-left: auto;
  }
  .message-source {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 10px;
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--nd-ink-muted);
    font-size: 12px;
  }
  .composer-region {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 10px 24px 16px;
  }
  .scope-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .scope-select {
    min-width: 0;
    flex: 1;
  }
  .scope-select select {
    max-width: 100%;
    width: 100%;
    border: 0;
    background: var(--nd-shell);
    color: var(--nd-ink-muted);
    padding: 4px 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .text-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    color: var(--nd-ink-muted);
    padding: 4px 0;
  }
  .composer {
    border: 1px solid var(--nd-hairline-strong);
    background: var(--nd-panel);
    border-radius: 11px;
    padding: 12px;
  }
  .composer textarea {
    display: block;
    width: 100%;
    resize: none;
    min-height: 56px;
    border: 0;
    background: transparent;
    padding: 3px 2px 10px;
    color: inherit;
    font-size: 15px;
    line-height: 1.6;
  }
  .composer textarea:focus-visible {
    outline-offset: 0;
    border-radius: 4px;
  }
  .composer-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
  }
  .composer-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .composer-options select {
    min-width: 0;
    max-width: 180px;
    border: 0;
    border-radius: 5px;
    padding: 5px 3px;
    background: var(--nd-panel);
    color: var(--nd-ink-muted);
    font-size: 12px;
  }
  .send {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    border: 0;
    background: var(--nd-ink);
    color: var(--nd-shell);
    display: grid;
    place-items: center;
  }
  .composer-help {
    font-size: 12px;
    line-height: 1.5;
    color: var(--nd-ink-muted);
    margin-top: 8px;
    min-height: 18px;
  }
  .composer-help .text-button {
    font-size: 12px;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin: 12vh auto 32px;
    max-width: 42ch;
    text-align: center;
  }
  .chat-empty h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 550;
  }
  .chat-empty p {
    color: var(--nd-ink-muted);
    line-height: 1.7;
    margin: 0 0 4px;
    font-size: 14px;
  }
  .banner,
  .notice {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
    margin: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--nd-hairline);
    line-height: 1.5;
  }
  .banner {
    color: var(--nd-warning);
    background: var(--nd-panel);
  }
  .notice {
    color: var(--nd-ink-muted);
  }
  .source-panel {
    border-left: 1px solid var(--nd-hairline);
    background: var(--nd-panel);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .source-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    min-height: 51px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .source-header strong {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 550;
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
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .source-provenance {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--nd-ink-muted);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .source-provenance strong {
    color: var(--nd-ink);
  }
  .settings-section {
    display: grid;
    gap: 12px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .settings-section h2 {
    font-size: 16px;
    font-weight: 550;
    margin: 0;
  }
  .settings-section p {
    font-size: 13px;
    line-height: 1.65;
    margin: 0;
  }
  .muted {
    color: var(--nd-ink-muted);
  }
  .provenance {
    overflow-wrap: anywhere;
  }
  .findings-bubble {
    margin: 0;
    padding: 16px;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 16px;
    background: var(--nd-panel);
    color: var(--nd-ink);
    box-shadow: 0 18px 40px rgb(0 0 0 / 0.25);
    overflow-y: auto;
  }
  .bubble-context {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 16px;
    color: var(--nd-ink-muted);
    border-bottom: 1px solid var(--nd-hairline);
  }
  .bubble-context strong {
    font-weight: 450;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bubble-results {
    padding-top: 8px;
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
  .finding-row:hover,
  .finding-row.selected {
    background: var(--nd-raised);
  }
  .finding-row :global(svg) {
    flex-shrink: 0;
  }
  .finding-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .finding-row .outcome {
    margin-left: auto;
    font-size: 11px;
    color: var(--nd-ink-muted);
    max-width: 94px;
  }
  .menu-empty {
    padding: 8px 12px;
    line-height: 1.6;
    color: var(--nd-ink-muted);
  }
  .create-project {
    display: grid;
    gap: 12px;
    padding: 12px 2px;
  }
  .create-project h2 {
    margin: 0;
    font-size: 15px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .create-project label,
  .settings-section label,
  .sheet-list label {
    display: grid;
    gap: 6px;
  }
  .create-project input,
  .settings-section select,
  .sheet-list select {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    background: var(--nd-shell);
    padding: 8px;
  }
  .actions button,
  .source-scroll > button,
  .create-project button {
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--nd-raised);
  }
  button.primary {
    background: var(--nd-ink);
    color: var(--nd-shell);
  }
  .sheet-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 14px;
  }
  .sheet-list li {
    display: grid;
    gap: 10px;
    border: 1px solid var(--nd-hairline);
    border-radius: 8px;
    padding: 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .search-panel {
    position: fixed;
    inset: 80px max(16px, calc((100vw - 560px) / 2)) auto;
    max-height: calc(100dvh - 100px);
    overflow-y: auto;
    background: var(--nd-panel);
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 12px;
    box-shadow: 0 16px 40px rgb(0 0 0 / 0.2);
    padding: 12px;
    z-index: 20;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 4px 10px;
    border-bottom: 1px solid var(--nd-hairline);
  }
  .search-field input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 6px;
  }
  @media (max-width: 1180px) and (min-width: 701px) {
    .desktop.source-open .app-body {
      grid-template-columns: minmax(0, 1fr) var(--source-width);
    }
    .desktop.source-open .sidebar {
      display: none;
    }
    .desktop.source-open.mobile-navigation-open .sidebar {
      display: flex;
      position: fixed;
      inset: 52px auto 0 0;
      width: var(--sidebar-width);
      z-index: 15;
      box-shadow: 12px 0 28px rgb(0 0 0 / 0.15);
    }
    .project-crumb {
      max-width: 150px;
    }
  }
  @media (max-width: 900px) {
    .project-crumb {
      display: none;
    }
    .breadcrumb-divider {
      display: none;
    }
    .sheets-trigger {
      display: none;
    }
  }
  @media (max-width: 700px) {
    .desktop .app-body,
    .desktop.source-open .app-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .brand-slot {
      width: auto;
      min-width: 86px;
      border-right: 0;
      background: transparent;
      padding-left: 8px;
      gap: 4px;
    }
    .window-bar {
      gap: 8px;
      padding-right: 8px;
    }
    .breadcrumbs {
      display: none;
    }
    .window-actions {
      margin-left: auto;
      gap: 3px;
    }
    .ghost,
    .findings-trigger {
      padding: 7px;
      gap: 4px;
    }
    .sidebar {
      position: fixed;
      inset: 52px auto 0 0;
      width: 240px;
      z-index: 15;
      visibility: hidden;
      box-shadow: 12px 0 28px rgb(0 0 0 / 0.15);
    }
    .desktop.mobile-navigation-open .sidebar {
      visibility: visible;
    }
    .source-panel {
      position: fixed;
      inset: 52px 0 0;
      z-index: 10;
    }
    .chat-scroll {
      padding: 28px 20px 16px;
    }
    .composer-region {
      padding: 10px 16px 14px;
    }
    .chat-empty {
      margin-top: 8vh;
    }
  }
</style>
