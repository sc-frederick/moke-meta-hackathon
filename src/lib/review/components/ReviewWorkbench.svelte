<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    Artifact,
    Conversation,
    Finding,
    Project,
    ReviewSnapshot,
    Sheet,
    SheetLabelSuggestions,
  } from "#lib/review/contracts.ts";
  import { Match, Option, Schema } from "effect";
  import { ReviewCommand, OperationId, RevisionId } from "#lib/review/contracts.ts";
  import { newCommandId, reviewCommand, type ReviewClient } from "#lib/review/client.ts";
  import CloudReviewControls from "./CloudReviewControls.svelte";
  import {
    cloudReviewLocksWorkspace,
    latestCloudReviewStatus,
    type CloudReviewStatus,
    type CloudReviewSetup,
  } from "#lib/review/cloud.ts";
  import { createCloudReturnHydration } from "#lib/review/cloud-delivery.ts";
  import ExecutionControls from "./ExecutionControls.svelte";
  import RevisionMapping from "./RevisionMapping.svelte";
  import SheetSetup from "./SheetSetup.svelte";
  import {
    ReviewDisciplineSelection,
    reviewDisciplines,
    type ExecutionSetup,
    type ExecutionStatus,
  } from "#lib/review/execution.ts";
  import FindingInspector from "./FindingInspector.svelte";
  import FindingDecision from "./FindingDecision.svelte";
  import FirmChecklistSettings from "./FirmChecklistSettings.svelte";
  import PacketReviewPanel from "./PacketReviewPanel.svelte";
  import { ReviewDiscipline } from "#lib/review/disciplines.ts";
  import { SheetId } from "#lib/review/contracts.ts";
  import type {
    FirmChecklist,
    PacketFindingFocus,
    PacketFindingVerdict,
    PacketReview,
    StartPacketReview,
  } from "#lib/review/packet.ts";
  import { packetFindingText } from "#lib/review/packet.ts";
  import { focusOutlines } from "#lib/review/segmentation.ts";
  import { inInitialReviewPhase, initialReview } from "#lib/review/initial-review.ts";
  import { followPacketReviews } from "#lib/review/packet-subscription.ts";
  import ReviewIcon from "./ReviewIcon.svelte";
  import ReviewText from "./ReviewText.svelte";
  import SourceViewer from "./SourceViewer.svelte";
  import ReviewSelect from "./ReviewSelect.svelte";
  import { ReviewModelId, reviewModels } from "#lib/review/models.ts";
  import {
    findingSubtitle,
    formatOutcome,
    projectMonogram,
    formatElapsed,
  } from "./review-format.ts";

  let { client }: { client: ReviewClient } = $props();

  let shortcutLabel = $state("Ctrl K");
  let historyReviewId = $state<string | null>(null);
  let sidebarOpen = $state(true);
  let mobileNavigationOpen = $state(false);
  let popoverOpen = $state(false);
  let searchOpen = $state(false);
  let findQuery = $state("");
  let ready = $state(false);
  let busy = $state(false);
  let importing = $state(false);
  let importDialog: HTMLDialogElement | undefined = $state();
  let revisionLabel = $state("");
  let droppedPdf = $state<{ token: string; name: string } | null>(null);
  let importError = $state("");
  let dropRequest = 0;
  let scopeMode = $state<"whole_set" | "selected_sheets" | "discipline">("whole_set");
  let scopeRevisionId = $state("");
  let selectedSheetIds = $state<ReadonlyArray<Sheet["id"]>>([]);
  let selectedPacketFindingId = $state<string | null>(null);
  let error = $state("");
  let snapshot = $state.raw<ReviewSnapshot | null>(null);
  let eventCursor = $state(0);

  let selectedProjectId = $state<Project["id"] | null>(null);
  let selectedConversationId = $state<string | null>(null);
  let selectedFindingId = $state<string | null>(null);
  let sourceTab = $state<"evidence" | "sheets" | "revision">("evidence");
  let panelOpen = $state(false);
  let reviewFindingId = $state<string | null>(null);
  let reviewMode = $state<"review" | "note">("review");
  let discipline = $state<typeof ReviewDisciplineSelection.Type>("auto");
  let selectedModel = $state<typeof ReviewModelId.Type>("muse-spark-1.3");
  let setup = $state.raw<ExecutionSetup | null>(null);
  let executionStatus = $state.raw<ExecutionStatus | null>(null);
  let location = $state<"local" | "cloud">("local");
  let cloudStatus = $state.raw<CloudReviewStatus | null>(null);
  let cloudSetup = $state.raw<CloudReviewSetup | null>(null);
  let cloudLoaded = $state(false);
  let estimatingWorkspace = $state(false);

  // Preflight and packaging run before the cloud receipt exists, so time them here.
  let cloudSubmittedAt = $state<number | null>(null);
  let cloudSubmitClock = $state(0);
  const submittingCloud = $derived(cloudSubmittedAt !== null);

  $effect(() => {
    if (cloudSubmittedAt === null) return;

    const clock = setInterval(() => {
      cloudSubmitClock = Date.now();
    }, 1000);

    return () => clearInterval(clock);
  });

  const cloudLocked = $derived(
    cloudStatus !== null && cloudReviewLocksWorkspace(cloudStatus.phase),
  );

  const cloudBlocked = $derived(!cloudLoaded || cloudLocked || submittingCloud);

  const cloudEstimateOverLimit = $derived(
    cloudSetup?.workspaceEstimate !== undefined &&
      (cloudSetup.workspaceEstimate.bytes > 1024 * 1024 * 1024 ||
        cloudSetup.workspaceEstimate.files > 5000),
  );

  const cloudLocalReviews = $derived(cloudSetup?.workspaceEstimate?.localReviews ?? []);

  const cloudEstimateMissing = $derived(
    location === "cloud" &&
      reviewMode === "review" &&
      (estimatingWorkspace || cloudSetup?.workspaceEstimate === undefined),
  );

  let callLimit = $state<number | undefined>(undefined);
  let packetReviews = $state.raw<ReadonlyArray<PacketReview>>([]);
  let packetBusy = $state(false);
  let firmChecklist = $state<typeof FirmChecklist.Type | null>(null);
  let firmChecklistLoaded = $state(false);
  let firmChecklistMessage = $state("");

  let steeringCommand: {
    commandId: ReturnType<typeof newCommandId>;
    reviewId: string;
    text: string;
  } | null = null;

  let packetConnectionLost = $state(false);
  let packetProjectId: Project["id"] | null = null;
  let packetSubscription: AbortController | null = null;
  let notice = $state("");
  let sourceLoading = $state(false);
  let previewedSheet = $state.raw<Sheet | null>(null);
  let projectConversations = $state.raw<Readonly<Record<string, ReadonlyArray<Conversation>>>>({});

  const conversationViews = new Map<
    string,
    {
      draft: string;
      /** Null follows the latest message; the layout can change before the user returns. */
      scroll: number | null;
      scopeMode: "whole_set" | "selected_sheets" | "discipline";
      revisionId: string;
      sheetIds: ReadonlyArray<Sheet["id"]>;
      discipline: typeof ReviewDisciplineSelection.Type;
      model: typeof ReviewModelId.Type;
      location: "local" | "cloud";
      callLimit: number | undefined;
    }
  >();

  let sourceRequest = 0;
  let refreshRequest = 0;

  let newProjectName = $state("");
  let draft = $state("");
  let expandedProjects = $state.raw<ReadonlyArray<string>>([]);

  let createFindingOpen = $state(false);
  let projectDialog: HTMLDialogElement | undefined = $state();
  let settingsDialog: HTMLDialogElement | undefined = $state();
  let projectNameInput: HTMLInputElement | undefined = $state();
  let sourceSide = $state<"drawn" | "scheduled">("drawn");
  let selectingRegion = $state(false);

  let applySelectedRegion: ((region: import("#lib/review/contracts.ts").Region) => void) | null =
    null;

  let sourceZoomFactor = $state(1);
  let sourceImageUrl = $state("");
  let sourceArtifact = $state.raw<Artifact | null>(null);

  // A saved model render can be a partial crop even when a location only names the sheet.
  const sourceIsCrop = $derived(
    sourceArtifact?.region != null &&
      previewedSheet !== null &&
      (sourceArtifact.region.width < previewedSheet.box.width * 0.98 ||
        sourceArtifact.region.height < previewedSheet.box.height * 0.98),
  );

  let sourceRequestedDpi = 96;
  let pendingDropImport = $state.raw<Parameters<ReviewClient["chooseReviewPdf"]>[0] | null>(null);

  let sourceOverlays = $state.raw<
    ReadonlyArray<{
      region: { x: number; y: number; width: number; height: number };
      title: string;
    }>
  >([]);

  let findingsButton: HTMLButtonElement | undefined = $state();
  let findingsBubble: HTMLElement | undefined = $state();
  let chatViewport: HTMLDivElement | undefined = $state();

  // A thread at its latest message stays there while reviews load or the window resizes,
  // until the reader scrolls up.
  let followLatest = true;

  // The position this component last scrolled to; its own scroll events are not reader input.
  let autoScrollTop: number | null = null;

  function scrollToLatest(viewport: HTMLDivElement) {
    followLatest = true;
    viewport.scrollTop = viewport.scrollHeight;
    autoScrollTop = viewport.scrollTop;
  }

  $effect(() => {
    const viewport = chatViewport;
    const content = viewport?.firstElementChild;

    if (!viewport || !content) return;

    const observer = new ResizeObserver(() => {
      if (followLatest || viewport.scrollHeight <= viewport.clientHeight) scrollToLatest(viewport);
    });

    observer.observe(viewport);
    observer.observe(content);

    return () => observer.disconnect();
  });

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

  const conversationReviews = $derived(
    packetReviews
      .filter((review) => review.conversationId === activeConversation?.id)
      .toSorted((left, right) => left.startedAt - right.startedAt),
  );

  const scopeRevision = $derived(
    revisions.find((revision) => revision.id === scopeRevisionId) ?? revisions.at(-1),
  );

  const scopeSheets = $derived(sheets.filter((sheet) => sheet.revisionId === scopeRevision?.id));

  const scopeCount = $derived(
    Match.value(scopeMode).pipe(
      Match.when(
        "selected_sheets",
        () => scopeSheets.filter((sheet) => selectedSheetIds.includes(sheet.id)).length,
      ),
      Match.when(
        "discipline",
        () => scopeSheets.filter((sheet) => sheet.discipline === discipline).length,
      ),
      Match.orElse(() => scopeSheets.length),
    ),
  );

  const activePacketReview = $derived(conversationReviews.at(-1) ?? null);

  const displayedPacketReview = $derived(
    conversationReviews.find((review) => review.id === historyReviewId) ?? activePacketReview,
  );

  const packetFindings = $derived(displayedPacketReview?.findings ?? []);

  const selectedPacketFinding = $derived(
    packetFindings.find((finding) => finding.id === selectedPacketFindingId) ?? null,
  );

  const selectedPacketText = $derived(
    selectedPacketFinding === null ? null : packetFindingText(selectedPacketFinding),
  );

  // The finding's SAM zoom, while its artifact is the displayed source.
  const displayedFocus = $derived(
    selectedPacketFinding?.focus !== undefined &&
      sourceArtifact?.id === selectedPacketFinding.focus.artifactId
      ? selectedPacketFinding.focus
      : null,
  );

  const focusMasks = $derived(displayedFocus === null ? [] : focusOutlines(displayedFocus));

  const validCallLimit = $derived(
    callLimit === undefined || (Number.isInteger(callLimit) && callLimit > 0),
  );

  const modelOptions = $derived(
    (
      setup?.models ??
      reviewModels.map((model) => ({
        ...model,
        available: setup?.configured && setup.provider === model.provider,
      }))
    ).map((model) => ({
      value: model.id,
      label: model.label,
      description: `${model.provider === "meta" ? "Meta" : "Baseten"}${model.available ? "" : " · add a connection in settings"}`,
      disabled: !model.available,
    })),
  );

  const selectedModelAvailable = $derived(
    modelOptions.some((model) => model.value === selectedModel && !model.disabled),
  );

  const executionBlocked = $derived(
    (activePacketReview !== null &&
      ["running", "paused", "uncertain"].includes(activePacketReview.state)) ||
      (executionStatus !== null &&
        (["running", "pausing", "paused", "uncertain"].includes(executionStatus.state) ||
          (executionStatus.unresolvedAttempts > 0 && !executionStatus.uncertaintyAcknowledged))),
  );

  const initialReviewModel = "muse-spark-1.3" satisfies typeof ReviewModelId.Type;

  // Shown until a revised set arrives; a first set made of several PDFs keeps it.
  const initialReviewVisible = $derived(
    inInitialReviewPhase({
      revisions,
      correspondence: snapshot?.sheetCorrespondence ?? [],
      reviews: packetReviews,
    }),
  );

  // Cloud when it is set up and can take this workspace; on this computer otherwise.
  const initialReviewPlacement = $derived.by(() => {
    const local = (reason: string) =>
      ({ location: "local", label: `on this computer: ${reason}` }) as const;

    if (!cloudSetup?.configured) return { location: "local", label: "on this computer" } as const;

    if (cloudSetup.workspaceEstimate === undefined)
      return local("the cloud size check is unavailable");

    if (cloudEstimateOverLimit) return local("this workspace exceeds the cloud limit");

    if (cloudLocalReviews.length > 0) return local("local reviews are still active");

    return { location: "cloud", label: "in the cloud" } as const;
  });

  // Why the button cannot run now, or null when it can.
  const initialReviewBlocker = $derived.by(() => {
    if (activePacketReview?.state === "running" && activePacketReview.preset === initialReview.id)
      return "Initial review running…";

    if (submittingCloud) return "Sending the review to the cloud…";

    if (cloudLocked) return "A cloud review is in progress. Results sync automatically.";

    if (executionBlocked) return "Finish or cancel the current review first.";

    if (sheets.length === 0) return "Waiting for the imported sheets.";

    if (!modelOptions.some((model) => model.value === initialReviewModel && !model.disabled))
      return "Connect Meta in Review settings to run the initial review.";

    if (cloudSetup?.configured && estimatingWorkspace) return "Measuring the workspace for cloud…";

    return null;
  });

  const initialReviewReady = $derived(
    initialReviewBlocker === null && !busy && !importing && !cloudBlocked,
  );

  const initialReviewSummary = $derived(
    `Whole set · all disciplines · four passes · ${
      reviewModels.find((model) => model.id === initialReviewModel)?.label ?? initialReviewModel
    } · ${initialReviewPlacement.label}`,
  );

  const visibleFindings = $derived(
    findings.filter((finding) =>
      `${finding.title} ${finding.objectClass} ${findingSubtitle(finding, sheets)} ${formatOutcome(finding.outcome)}`
        .toLowerCase()
        .includes(findQuery.toLowerCase()),
    ),
  );

  const visiblePacketFindings = $derived(
    packetFindings.filter((finding) =>
      `${finding.title} ${finding.observed} ${finding.correction} ${Object.values(packetFindingText(finding)).join(" ")} ${finding.discipline}`
        .toLowerCase()
        .includes(findQuery.toLowerCase()),
    ),
  );

  const conversationMessages = $derived.by(() => {
    if (activeConversation === null) return [];

    const currentMessages = messages.filter(
      (message) => message.conversationId === activeConversation.id,
    );

    const displayedAnswer = activePacketReview?.summary
      ? currentMessages.findLast(
          (message) =>
            message.role === "application" &&
            message.text === activePacketReview.summary &&
            Date.parse(message.createdAt) >= activePacketReview.startedAt,
        )
      : undefined;

    return currentMessages.filter((message) => message.id !== displayedAnswer?.id);
  });

  // These notices describe one moment of a review and go stale once its state changes.
  const reviewStatusNotices = ["Review started.", "Review status refreshed."];

  // Reviews load after a project switch, so the conversation's model is restored when they arrive.
  let modelChosen = false;

  function receivePacketReview(review: PacketReview) {
    if (review.projectId !== selectedProjectId) return;
    const previous = packetReviews.find((item) => item.id === review.id);

    if (previous && previous.version > review.version) return;

    if (previous && previous.state !== review.state && reviewStatusNotices.includes(notice))
      notice = "";
    packetReviews = [...packetReviews.filter((item) => item.id !== review.id), review];

    if (!modelChosen && review.conversationId === selectedConversationId) {
      const latest = packetReviews
        .filter((item) => item.conversationId === selectedConversationId)
        .reduce((last, item) => (item.startedAt > last.startedAt ? item : last));

      selectedModel = latest.model;
    }
  }

  async function trackPacketReviews(projectId: Project["id"]) {
    if (packetProjectId === projectId && packetSubscription !== null) return;
    packetSubscription?.abort();
    const controller = new AbortController();
    packetSubscription = controller;
    packetProjectId = projectId;
    packetReviews = [];
    packetConnectionLost = false;
    await followPacketReviews({
      client,
      projectId,
      signal: controller.signal,
      onReview: (review) => {
        receivePacketReview(review);
        // Snapshot refresh must not block the stream acknowledgement.
        void refresh(projectId);
      },
      onConnectionLost: (lost) => {
        packetConnectionLost = lost;
      },
      onError: (message) => console.warn("Local review progress:", message),
    });
  }

  async function showPacketFinding(findingId: string) {
    const finding = packetFindings.find((item) => item.id === findingId);

    if (!finding) return;
    sourceRequest++;
    sourceLoading = false;
    selectingRegion = false;
    applySelectedRegion = null;
    selectedFindingId = null;
    previewedSheet = null;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    sourceOverlays = [];
    error = "";
    selectedPacketFindingId = findingId;
    searchOpen = false;
    panelOpen = true;
    sourceTab = "evidence";
    closeFindings();

    if (finding.focus) await openPacketFocus(finding.focus);
    else if (finding.evidenceIds.length || finding.locations.length)
      await openPacketEvidence(finding.evidenceIds[0] ?? null, finding.locations[0]);
  }

  async function controlPacketReview(
    review: PacketReview,
    action: "pause" | "resume" | "cancel",
    maxCalls?: number | null,
  ) {
    if (cloudBlocked) return;
    packetBusy = true;

    if (reviewStatusNotices.includes(notice)) notice = "";

    let result = await client.controlPacketReview(
      review.projectId,
      review.id,
      review.version,
      action,
      maxCalls,
    );

    if (!result.ok && "reason" in result.error && result.error.reason === "conflict") {
      const current = await client.getPacketReview(review.projectId, review.id);

      if (current.ok) {
        receivePacketReview(current.value);
        const retryPause = action === "pause" && current.value.state === "running";

        const retryCancel =
          action === "cancel" && ["running", "paused", "uncertain"].includes(current.value.state);

        if (retryPause || retryCancel)
          result = await client.controlPacketReview(
            current.value.projectId,
            current.value.id,
            current.value.version,
            action,
            maxCalls,
          );
      }
    }

    packetBusy = false;

    if (review.projectId !== selectedProjectId || review.conversationId !== selectedConversationId)
      return;

    if (result.ok) {
      error = "";
      receivePacketReview(result.value);
    } else error = result.error.message;
  }

  async function refreshPacketReview(review: PacketReview) {
    packetBusy = true;
    const result = await client.getPacketReview(review.projectId, review.id);
    packetBusy = false;

    if (review.projectId !== selectedProjectId || review.conversationId !== selectedConversationId)
      return;

    if (result.ok) {
      receivePacketReview(result.value);
      error = "";
      notice = "Review status refreshed.";
    } else error = result.error.message;
  }

  async function refreshWorkspaceEstimate(quiet = false) {
    if (estimatingWorkspace) return;
    estimatingWorkspace = true;
    const result = await client.cloudSetup();
    estimatingWorkspace = false;

    if (result.ok) cloudSetup = result.value;
    else if (!quiet) error = result.error.message;
  }

  // Initial Review runs in the cloud when it is set up, so learn that before the reviewer
  // chooses. A failed check stays quiet; the line then names this computer.
  let cloudSetupChecked = false;

  $effect(() => {
    if (!initialReviewVisible || cloudSetupChecked || cloudSetup !== null) return;
    cloudSetupChecked = true;
    void refreshWorkspaceEstimate(true);
  });

  async function suggestSheetLabels(): Promise<SheetLabelSuggestions | null> {
    if (!project || !scopeRevision || cloudBlocked) return null;

    const result = await client.suggestSheetLabels({
      projectId: project.id,
      revisionId: scopeRevision.id,
    });

    if (result.ok) return result.value;

    error = result.error.message;

    return null;
  }

  async function applySheetLabels(
    revisionId: Sheet["revisionId"],
    labels: ReadonlyArray<{ sheetId: Sheet["id"]; label: string }>,
  ) {
    if (!project || labels.length === 0) return false;

    return await runCommand(
      reviewCommand(
        ReviewCommand.cases.ApplySheetLabels.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          revisionId,
          labels: Schema.decodeUnknownSync(ReviewCommand.cases.ApplySheetLabels.fields.labels)(
            labels,
          ),
        }),
      ),
    );
  }

  async function completePacketFinding(
    review: PacketReview,
    findingId: string,
    completed: boolean,
  ) {
    if (cloudBlocked) return;
    packetBusy = true;

    const result = await client.completePacketFinding(
      review.projectId,
      review.id,
      findingId,
      completed,
      review.version,
    );

    packetBusy = false;

    if (result.ok) receivePacketReview(result.value);
    else error = result.error.message;
  }

  async function decidePacketFinding(
    review: PacketReview,
    findingId: string,
    decision: { verdict: typeof PacketFindingVerdict.Type; reason: string } | null,
  ) {
    if (cloudBlocked) return;
    packetBusy = true;

    const result = await client.decidePacketFinding(
      review.projectId,
      review.id,
      findingId,
      decision,
      review.version,
    );

    packetBusy = false;

    if (result.ok) receivePacketReview(result.value);
    else error = result.error.message;
  }

  async function loadFirmChecklist() {
    const result = await client.firmChecklist();

    if (result.ok) {
      firmChecklist = result.value;
      firmChecklistLoaded = true;
    } else firmChecklistMessage = result.error.message;
  }

  async function saveFirmChecklist(text: string) {
    if (cloudBlocked || !firmChecklistLoaded) return;
    packetBusy = true;
    const result = await client.saveFirmChecklist(text, firmChecklist?.revision ?? 0);
    packetBusy = false;

    if (result.ok) {
      firmChecklist = result.value;
      firmChecklistMessage = "Saved. New reviews will use this revision.";
    } else {
      firmChecklistMessage = result.error.message;
      void loadFirmChecklist();
    }
  }

  function openPacketFocus(focus: typeof PacketFindingFocus.Type) {
    return openPacketEvidence(focus.artifactId, {
      sheetId: focus.sheetId,
      region: focus.region,
      detail: "Finding region",
    });
  }

  async function openPacketEvidence(
    artifactId: import("#lib/review/contracts.ts").Artifact["id"] | null,
    location?: {
      sheetId: Sheet["id"];
      region: import("#lib/review/contracts.ts").Region | null;
      detail: string;
    },
  ) {
    if (project === null) return;
    const projectId = project.id;
    const request = ++sourceRequest;
    await refresh(projectId);

    if (request !== sourceRequest || projectId !== selectedProjectId) return;
    const artifact = snapshot?.artifacts.find((item) => item.id === artifactId);

    const sheet = snapshot?.sheets.find(
      (item) => item.id === (artifact?.sheetId ?? location?.sheetId),
    );

    if (!sheet) {
      error = "This source sheet is unavailable in the current project.";

      return;
    }

    selectedFindingId = null;
    panelOpen = true;
    sourceTab = "evidence";

    if (artifact) {
      sourceLoading = true;
      previewedSheet = sheet;
      sourceZoomFactor = 1;

      if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
      sourceImageUrl = "";
      sourceArtifact = null;
      sourceOverlays = [];
      const blob = await client.loadArtifactBlobUrl(artifact.projectId, artifact);

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
      sourceOverlays =
        location?.region && location.sheetId === sheet.id
          ? [{ region: location.region, title: location.detail }]
          : [];
    } else {
      await loadSheetSource(
        sheet,
        150,
        undefined,
        undefined,
        location?.region ? [{ region: location.region, title: location.detail }] : [],
        request,
      );
    }
  }

  async function refresh(projectId: typeof selectedProjectId = selectedProjectId) {
    const request = ++refreshRequest;
    const result = await client.snapshot(projectId, eventCursor);

    if (request !== refreshRequest) return false;

    if (!result.ok) {
      error = result.error.message;

      return false;
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

    if (selectedProjectId !== null) void trackPacketReviews(selectedProjectId);

    return true;
  }

  async function runCommand(command: Parameters<ReviewClient["command"]>[0]) {
    if (cloudBlocked) return false;
    busy = true;
    const result = await client.command(command);

    if (!result.ok) {
      busy = false;
      error = result.error.message;

      return false;
    }

    error = "";
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
    projectDialog?.close();
    selectedFindingId = null;
    await chooseConversation(snapshot?.conversations[0]?.id ?? null, false);
    reviewFindingId = null;
    executionStatus = null;
    draft = "";
    closeSource();
  }

  async function openProjectDialog() {
    if (cloudBlocked) return;
    closeFindings();
    mobileNavigationOpen = false;
    projectDialog?.showModal();
    await tick();
    projectNameInput?.focus();
  }

  function rememberConversation() {
    if (activeConversation)
      conversationViews.set(activeConversation.id, {
        draft,
        scroll:
          chatViewport &&
          chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight > 24
            ? chatViewport.scrollTop
            : null,
        scopeMode,
        revisionId: scopeRevisionId,
        sheetIds: selectedSheetIds,
        discipline,
        model: selectedModel,
        location,
        callLimit,
      });
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
    notice = "";
    error = "";
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

    if (project === null || activeConversation === null || cloudBlocked) return;
    const text = draft.trim();

    if (!text || busy) return;

    if (reviewMode === "review" && activePacketReview?.state === "running") {
      busy = true;

      if (
        !steeringCommand ||
        steeringCommand.reviewId !== activePacketReview.id ||
        steeringCommand.text !== text
      )
        steeringCommand = { commandId: newCommandId(), reviewId: activePacketReview.id, text };

      const result = await client.steerPacketReview({
        commandId: steeringCommand.commandId,
        projectId: project.id,
        reviewId: activePacketReview.id,
        conversationId: activeConversation.id,
        text,
      });

      busy = false;

      if (result.ok) {
        steeringCommand = null;
        receivePacketReview(result.value);
        draft = "";
        notice = "Follow-up queued for this review. MOKE will apply it at the next tool boundary.";
        await refresh();
      } else error = result.error.message;

      return;
    }

    const command = ReviewCommand.cases.PostMessage.make({
      commandId: newCommandId(),
      projectId: project.id,
      expectedVersion: project.version,
      conversationId: activeConversation.id,
      text,
    });

    if (reviewMode === "review") {
      if (sheets.length === 0 || !selectedModelAvailable || !validCallLimit || executionBlocked)
        return;

      if (
        location === "cloud" &&
        (cloudEstimateMissing || cloudEstimateOverLimit || cloudLocalReviews.length > 0)
      )
        return;

      if (!scopeRevision || !scopeCount || (scopeMode === "discipline" && discipline === "auto"))
        return;

      await startDrawingReview(
        command,
        {
          model: selectedModel,
          discipline,
          maxCalls: callLimit ?? null,
          selection: { mode: scopeMode, revisionId: scopeRevision.id, sheetIds: selectedSheetIds },
        },
        location,
        () => {
          draft = "";
        },
      );
    } else if (await runCommand(command)) {
      draft = "";
      notice = "Note saved.";
    }

    await followConversation(command);
  }

  /** Save the reviewer's message, then start its drawing-set review here or in the cloud. */
  async function startDrawingReview(
    command: typeof ReviewCommand.cases.PostMessage.Type,
    review: Omit<
      typeof StartPacketReview.Type,
      "commandId" | "projectId" | "conversationId" | "messageId"
    >,
    where: "local" | "cloud",
    onSaved: () => void,
  ) {
    busy = true;
    const saved = await client.command(command);

    if (!saved.ok) {
      error = saved.error.message;
      busy = false;

      return;
    }

    onSaved();
    await refresh(saved.value.projectId);

    const request = {
      commandId: newCommandId(),
      projectId: command.projectId,
      conversationId: command.conversationId,
      messageId: saved.value.entityId,
      ...review,
    };

    if (where === "cloud") {
      cloudSubmittedAt = cloudSubmitClock = Date.now();
      busy = false;

      const result = await client.startCloudPacketReview({
        ...request,
        kind: "packet",
        transferScope: "whole-application",
      });

      cloudSubmittedAt = null;

      if (result.ok) {
        cloudStatus = latestCloudReviewStatus(cloudStatus, result.value);
        executionStatus = null;

        if (
          selectedProjectId === command.projectId &&
          selectedConversationId === command.conversationId
        ) {
          error = "";
          notice = "Review pushed to cloud. Progress and results sync automatically.";
        }
      } else if (
        selectedProjectId === command.projectId &&
        selectedConversationId === command.conversationId
      )
        error = `Your message was saved. ${result.error.message}`;
    } else {
      const result = await client.startPacketReview(request);

      if (result.ok) {
        receivePacketReview(result.value);
        error = "";
        notice = "Review started.";
      } else error = `Your message was saved. ${result.error.message}`;
    }

    await refresh();
    busy = false;
  }

  /** Send the preset initial QA request as the reviewer's message, with its fixed settings. */
  async function startInitialReview() {
    const target = { projectId: project?.id, conversationId: activeConversation?.id };

    // A local review started elsewhere since the last size check would refuse the cloud transfer.
    if (cloudSetup?.configured) await refreshWorkspaceEstimate(true);

    if (
      project === null ||
      activeConversation === null ||
      project.id !== target.projectId ||
      activeConversation.id !== target.conversationId ||
      !initialReviewReady
    )
      return;

    const command = ReviewCommand.cases.PostMessage.make({
      commandId: newCommandId(),
      projectId: project.id,
      expectedVersion: project.version,
      conversationId: activeConversation.id,
      text: initialReview.text,
    });

    // The composer shows where this review runs.
    location = initialReviewPlacement.location;
    // No selection: the first set can span several PDFs, and every one of its sheets is in scope.
    await startDrawingReview(
      command,
      { model: initialReviewModel, discipline: "auto", maxCalls: null, preset: initialReview.id },
      initialReviewPlacement.location,
      () => undefined,
    );
    await followConversation(command);
  }

  async function followConversation(command: typeof ReviewCommand.cases.PostMessage.Type) {
    await tick();

    if (
      chatViewport &&
      selectedProjectId === command.projectId &&
      selectedConversationId === command.conversationId
    )
      scrollToLatest(chatViewport);
  }

  function importPdf() {
    if (project === null || cloudBlocked) return;
    dropRequest++;
    revisionLabel = revisions.length ? `Rev ${revisions.length}` : "";
    droppedPdf = null;
    pendingDropImport = null;
    importError = "";
    importDialog?.showModal();
  }

  async function receiveDrop(event: DragEvent) {
    event.preventDefault();
    const request = ++dropRequest;
    droppedPdf = null;
    pendingDropImport = null;
    const files = Array.from(event.dataTransfer?.files ?? []);

    if (files.length !== 1) {
      importError = "Drop one PDF at a time.";

      return;
    }

    const file = files[0];

    if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
      importError = "Choose a PDF drawing file.";

      return;
    }

    try {
      const staged = await window.mokeFiles.stageDrop(file);

      if (request !== dropRequest || !importDialog?.open) return;
      droppedPdf = staged;
      importError = droppedPdf
        ? ""
        : "This file has no usable local PDF path. Use Choose PDF instead.";
    } catch {
      if (request !== dropRequest || !importDialog?.open) return;
      droppedPdf = null;
      importError = "The dropped PDF could not be read. Use Choose PDF instead.";
    }
  }

  async function performImport(useDrop = false) {
    if (project === null || importing || cloudBlocked) return;
    busy = true;
    importing = true;

    const request: Parameters<ReviewClient["chooseReviewPdf"]>[0] = pendingDropImport ?? {
      projectId: project.id,
      expectedVersion: project.version,
      commandId: newCommandId(),
    };

    if (!pendingDropImport && revisionLabel.trim()) request.revisionLabel = revisionLabel.trim();

    if (useDrop && droppedPdf) request.dropToken = droppedPdf.token;

    if (request.dropToken) pendingDropImport = request;
    const result = await client.chooseReviewPdf(request);

    if (!result.ok) {
      await refresh(request.projectId);
      busy = false;
      importing = false;
      importError = result.error.message;

      return;
    }

    if (result.value === null) {
      busy = false;
      importing = false;

      return;
    }

    await refresh(result.value.projectId);
    pendingDropImport = null;
    scopeRevisionId = revisions.at(-1)?.id ?? "";
    selectedSheetIds = [];
    selectedPacketFindingId = null;
    importDialog?.close();
    sourceRequest++;
    sourceLoading = false;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    panelOpen = true;
    sourceTab = "sheets";
    previewedSheet = null;
    notice = initialReviewVisible
      ? "PDF imported. Choose Initial Review, or assign sheet disciplines and choose a review scope."
      : "PDF imported. Assign sheet disciplines if useful, then choose a review scope.";

    // The Initial Review line names where it runs, which depends on the workspace size.
    if (cloudSetup?.configured) void refreshWorkspaceEstimate();
    busy = false;
    importing = false;
  }

  async function loadThumbnail(sheet: Sheet): Promise<string | null> {
    if (cloudBlocked) return null;

    const rendered = await client.renderSource({
      projectId: sheet.projectId,
      sheetId: sheet.id,
      operationId: Schema.decodeUnknownSync(OperationId)(crypto.randomUUID()),
      region: sheet.box,
      dpi: 24,
    });

    if (!rendered.ok) return null;
    const blob = await client.loadArtifactBlobUrl(sheet.projectId, rendered.value);

    return blob.ok ? blob.value : null;
  }

  async function assignSheetDiscipline(
    ids: ReadonlyArray<Sheet["id"]>,
    value: typeof ReviewDiscipline.Type | null,
  ) {
    if (!project || !ids.length) return;
    await runCommand(
      reviewCommand(
        ReviewCommand.cases.AssignSheetDiscipline.make({
          commandId: newCommandId(),
          projectId: project.id,
          expectedVersion: project.version,
          sheetIds: Schema.decodeUnknownSync(Schema.NonEmptyArray(SheetId))(ids),
          discipline: value,
        }),
      ),
    );
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
    overlays?: typeof sourceOverlays,
    request = ++sourceRequest,
    keepZoom = false,
  ) {
    if (project === null) return;
    const projectId = project.id;

    if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    sourceImageUrl = "";
    sourceArtifact = null;
    sourceOverlays = [];
    previewedSheet = sheet;
    sourceLoading = true;

    // Only previous/next/jump navigation keeps the reviewer's zoom; a new context starts fitted.
    if (!keepZoom) sourceZoomFactor = 1;

    const targetRegion = region ?? {
      x: sheet.box.x,
      y: sheet.box.y,
      width: sheet.box.width,
      height: sheet.box.height,
    };

    const rendered = await client.renderSource({
      projectId,
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

    if (request !== sourceRequest || projectId !== selectedProjectId) return;
    const blob = await client.loadArtifactBlobUrl(projectId, artifact);

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
    sourceRequestedDpi = dpi;
    const drawn = facts.findLast((fact) => fact.findingId === finding?.id && fact.side === "drawn");

    const scheduled = facts.findLast(
      (fact) => fact.findingId === finding?.id && fact.side === "scheduled",
    );

    sourceOverlays = overlays ?? [
      ...(drawn?.evidence.sheetId === sheet.id
        ? [{ region: drawn.evidence.region, title: "Drawn evidence" }]
        : []),
      ...(scheduled?.evidence.sheetId === sheet.id
        ? [{ region: scheduled.evidence.region, title: "Scheduled evidence" }]
        : []),
    ];
  }

  function openFinding(finding: Finding) {
    selectingRegion = false;
    applySelectedRegion = null;
    selectedPacketFindingId = null;
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
    notice = "";
    selectingRegion = false;
    applySelectedRegion = null;
    sourceRequest++;
    sourceLoading = false;
    panelOpen = false;
    selectedFindingId = null;
    selectedPacketFindingId = null;

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

    if (id !== selectedConversationId) {
      executionStatus = null;
    }

    if (id !== selectedConversationId) closeSource();
    notice = "";
    error = "";
    historyReviewId = null;
    selectedPacketFindingId = null;
    const saved = id === null ? undefined : conversationViews.get(id);
    const previousReview = packetReviews.findLast((review) => review.conversationId === id);
    scopeMode = saved?.scopeMode ?? "whole_set";
    scopeRevisionId = saved?.revisionId ?? "";
    selectedSheetIds = saved?.sheetIds ?? [];
    discipline = saved?.discipline ?? "auto";
    selectedModel =
      saved?.model ??
      previousReview?.model ??
      setup?.models?.find((model) => model.available)?.id ??
      selectedModel;
    modelChosen = saved?.model !== undefined;
    location = saved?.location ?? "local";

    // Local reviews may have started elsewhere since this conversation measured the workspace.
    if (location === "cloud") void refreshWorkspaceEstimate();
    callLimit = saved?.callLimit;
    selectedConversationId = id;
    draft = id === null ? "" : (conversationViews.get(id)?.draft ?? "");
    mobileNavigationOpen = false;
    closeFindings();
    await tick();

    const savedScroll = id === null ? 0 : conversationViews.get(id)?.scroll;

    if (!chatViewport) followLatest = savedScroll === undefined || savedScroll === null;
    else if (savedScroll === undefined || savedScroll === null) scrollToLatest(chatViewport);
    else {
      followLatest = false;
      chatViewport.scrollTop = savedScroll;
    }
  }

  function selectReviewFinding(id: string) {
    if (reviewFindingId !== id) executionStatus = null;
    reviewFindingId = id || null;
  }

  function openSetup(tab: "sheets" | "settings" | "revision", create = false) {
    if (tab === "settings") {
      closeFindings();
      mobileNavigationOpen = false;
      settingsDialog?.showModal();
      void loadFirmChecklist();

      return;
    }

    if (panelOpen && sourceTab === tab && !create) {
      closeSource();

      return;
    }

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
    // Every dialog opens modally, including child-component dialogs, and owns its own Escape.
    if (event.defaultPrevented || document.querySelector("dialog[open]") !== null) return;

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
        sourceRequestedDpi,
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
      newSheetId: string | null;
      confirmed: boolean;
      content: "changed" | "unchanged" | "removed" | "unresolved";
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

  const onCloudReturned = createCloudReturnHydration({
    selection: () => ({
      projectId: selectedProjectId,
      findingId: reviewFindingId,
      receipt: cloudStatus,
    }),
    refreshSnapshot: async () => {
      eventCursor = 0;

      if (!(await refresh())) return false;
      const projectId = selectedProjectId;

      if (projectId === null) return true;
      const result = await client.listPacketReviews(projectId);

      if (projectId !== selectedProjectId) return false;

      if (!result.ok) {
        error = result.error.message;

        return false;
      }

      packetReviews = result.value;

      return true;
    },
    loadExecution: (projectId, runId) => client.executionStatus(projectId, runId),
    applyExecution: (status) => {
      executionStatus = status;
    },
    reportError: (message) => {
      error = message;
    },
  });

  onMount(() => {
    shortcutLabel = /Mac/.test(navigator.userAgent) ? "⌘ K" : "Ctrl K";
    const controller = new AbortController();
    void client.snapshot(null, 0, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;

      if (result.ok) {
        const remote = await client.cloudStatus();

        if (controller.signal.aborted) return;

        if (remote.ok && remote.value && cloudReviewLocksWorkspace(remote.value.phase)) {
          cloudStatus = latestCloudReviewStatus(cloudStatus, remote.value);
          selectedProjectId = remote.value.projectId;
          eventCursor = 0;
          await refresh(remote.value.projectId);
          selectedConversationId =
            remote.value.conversationId ??
            remote.value.packet?.conversationId ??
            snapshot?.conversations[0]?.id ??
            null;

          if (remote.value.packet) selectedModel = remote.value.packet.model;
          location = "cloud";
          ready = true;

          return;
        }

        snapshot = result.value;

        if (result.value.project) {
          selectedProjectId = result.value.project.id;
          selectedConversationId = result.value.conversations[0]?.id ?? null;
          projectConversations = { [result.value.project.id]: result.value.conversations };
          expandedProjects = [result.value.project.id];
          void trackPacketReviews(result.value.project.id);
        }
      } else {
        error = result.error.message;
      }

      ready = true;
    });
    void client.executionSetup().then((result) => {
      if (controller.signal.aborted) return;

      if (result.ok) {
        setup = result.value;
        const configuredModel = Schema.decodeUnknownOption(ReviewModelId)(result.value.model);

        // A conversation that already has a review keeps that review's model.
        if (
          Option.isSome(configuredModel) &&
          !modelChosen &&
          !packetReviews.some((item) => item.conversationId === selectedConversationId)
        )
          selectedModel = configuredModel.value;
      } else error = result.error.message;
    });

    return () => {
      controller.abort();
      packetSubscription?.abort();
      sourceRequest++;

      if (sourceImageUrl.startsWith("blob:")) URL.revokeObjectURL(sourceImageUrl);
    };
  });
</script>

<svelte:window onkeydown={handleKey} onresize={positionFindings} onscroll={positionFindings} />

{#snippet mark(size = 24)}
  <span class="brand-mark" style:--mark-size={`${size}px`} aria-hidden="true">M</span>
{/snippet}

{#snippet packetPanel(review: PacketReview, historical = false)}
  <PacketReviewPanel
    {review}
    {historical}
    busy={packetBusy || busy || cloudBlocked}
    onRefresh={() => refreshPacketReview(review)}
    onCopyDiagnostics={async () => {
      const result = await client.copyPacketReviewDiagnostics(review.projectId, review.id);
      return result.ok;
    }}
    onControl={(action, maxCalls) => controlPacketReview(review, action, maxCalls)}
    onFinding={async (id) => {
      historyReviewId = historical ? review.id : null;
      await tick();
      await showPacketFinding(id);
    }}
    onExport={async () => {
      const result = await client.choosePacketReport(review.projectId, review.id);
      if (!result.ok) error = result.error.message;
      else if (result.value) notice = "Review report exported.";
    }}
    onOpenSource={async (url) => {
      const result = await client.openReviewSource(url);
      if (!result.ok) error = result.error.message;
    }}
  />
{/snippet}

<div class="workbench-root">
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
        <button class="icon-btn" aria-label="Toggle conversation sidebar" onclick={toggleSidebar}
          ><ReviewIcon name="layout-sidebar" size={18} /></button
        >{@render mark()}<span class="brand-name">MOKE</span>
      </div>
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        {#if project}<span class="project-crumb" title={project.name}
            ><span class="project-monogram" aria-hidden="true">{projectMonogram(project.name)}</span
            ><span>{project.name}</span></span
          ><span class="breadcrumb-divider" aria-hidden="true">/</span>{/if}
        <strong aria-current="page">{activeConversation?.title ?? "Drawing review"}</strong>
      </nav>
      <div class="window-actions">
        {#if project}
          <span class="compact-project" title={project.name}>{project.name}</span>
          <details class="compact-actions">
            <summary aria-label="More project actions">More</summary>
            <div>
              <button disabled={busy || cloudBlocked} onclick={() => openSetup("sheets", true)}
                >New count check</button
              >
              <button disabled={busy || cloudBlocked} onclick={importPdf}>Import PDF</button>
            </div>
          </details>
          <button
            type="button"
            class="btn ghost-btn import-trigger"
            disabled={busy || cloudBlocked}
            data-testid="import-pdf"
            title="Import PDF"
            aria-busy={importing}
            onclick={importPdf}
            ><ReviewIcon name="upload" size={16} /><span
              >{importing ? "Importing PDF…" : "Import PDF"}</span
            ></button
          >
          <button
            class="btn ghost-btn secondary-count"
            data-testid="open-create-finding"
            disabled={busy || cloudBlocked}
            title="New count check"
            onclick={() => openSetup("sheets", true)}
            ><ReviewIcon name="plus" size={16} /><span>New count check</span></button
          >
          <button
            class="btn sheets-trigger"
            aria-expanded={panelOpen && sourceTab === "sheets"}
            onclick={() => openSetup("sheets")}
            ><ReviewIcon name="file-text" size={16} /><span>Sheets</span><span class="finding-count"
              >{sheets.length}</span
            ></button
          >
          <button
            class={["btn findings-trigger", { expanded: popoverOpen }]}
            disabled={busy || cloudBlocked}
            bind:this={findingsButton}
            aria-label="Open findings"
            aria-expanded={popoverOpen}
            popovertarget="review-findings"
            onclick={positionFindings}
            ><ReviewIcon name="layout-grid" size={16} /><span>Findings</span><span
              class="finding-count">{findings.length + packetFindings.length}</span
            ><ReviewIcon name="chevron-down" size={14} /></button
          >
        {/if}
      </div>
    </header>
    <dialog
      class="workspace-dialog"
      bind:this={projectDialog}
      aria-labelledby="project-dialog-title"
    >
      <form class="project-form" data-testid="create-project-form" onsubmit={createProject}>
        <header>
          <h2 id="project-dialog-title">New project</h2>
          <button
            type="button"
            class="icon-btn"
            aria-label="Close new project"
            disabled={busy}
            onclick={() => projectDialog?.close()}><ReviewIcon name="x" size={18} /></button
          >
        </header>
        <p>Keep drawings, conversations, and findings together.</p>
        <label
          >Project name<input
            bind:this={projectNameInput}
            data-testid="project-name-input"
            bind:value={newProjectName}
            required
            maxlength="160"
            placeholder="For example, Oak Street renovation"
          /></label
        >
        {#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
        <footer>
          <button
            type="button"
            class="btn md"
            disabled={busy}
            onclick={() => projectDialog?.close()}>Cancel</button
          ><button
            class="btn md primary"
            type="submit"
            disabled={busy || !newProjectName.trim()}
            data-testid="create-project-button">{busy ? "Creating…" : "Create project"}</button
          >
        </footer>
      </form>
    </dialog>
    <dialog
      class="workspace-dialog import-dialog"
      bind:this={importDialog}
      aria-labelledby="import-dialog-title"
      onclose={() => {
        dropRequest++;
        droppedPdf = null;
        pendingDropImport = null;
      }}
      oncancel={(event) => {
        if (importing) event.preventDefault();
      }}
    >
      <header>
        <h2 id="import-dialog-title">{revisions.length ? "Import revision" : "Import drawings"}</h2>
        <button
          class="icon-btn"
          disabled={importing}
          aria-label="Close PDF import"
          onclick={() => importDialog?.close()}><ReviewIcon name="x" size={18} /></button
        >
      </header>
      {#if revisions.length}<label class="import-label"
          >Revision label<input
            bind:value={revisionLabel}
            disabled={importing || pendingDropImport !== null}
            maxlength="160"
            required
          /></label
        >
        <p>
          Earlier sources and reviews stay in the project. Sheet correspondence is confirmed
          separately.
        </p>{/if}
      <!-- svelte-ignore a11y_no_static_element_interactions (The drop zone also provides a native chooser button.) -->
      <div
        class="pdf-drop-zone"
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => {
          if (!importing) void receiveDrop(event);
        }}
      >
        <ReviewIcon name="upload" size={28} /><strong
          >{droppedPdf?.name ?? "Drop a PDF here"}</strong
        ><span>or choose a file from your computer</span><button
          class="btn"
          disabled={importing ||
            pendingDropImport !== null ||
            (revisions.length > 0 && !revisionLabel.trim())}
          onclick={() => performImport()}>Choose PDF…</button
        >
      </div>
      {#if importError}<p role="alert" class="dialog-error">{importError}</p>{/if}
      {#if pendingDropImport && !importing}<p>
          Retry uses the same import request. Drop the PDF again or cancel to start a new request.
        </p>{/if}
      <footer>
        <button class="btn md" disabled={importing} onclick={() => importDialog?.close()}
          >Cancel</button
        >{#if droppedPdf}<button
            class="btn md primary"
            disabled={importing || (revisions.length > 0 && !revisionLabel.trim())}
            onclick={() => performImport(true)}>{importing ? "Importing…" : "Import PDF"}</button
          >{/if}
      </footer>
    </dialog>
    <dialog
      class="workspace-dialog settings-dialog"
      bind:this={settingsDialog}
      aria-labelledby="settings-dialog-title"
    >
      <header>
        <h2 id="settings-dialog-title">Review settings</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close review settings"
          onclick={() => settingsDialog?.close()}><ReviewIcon name="x" size={18} /></button
        >
      </header>
      <section class="settings-section">
        <h3>Review scope</h3>
        <p class="muted">
          Ask for a whole-set QA pass, a discipline review, or follow-up scrutiny. MOKE follows the
          project instructions and records the sources, coverage, findings, and missing inputs.
        </p>
        <details>
          <summary>Optional call budget</summary>
          <label
            >Maximum provider calls<input
              type="number"
              min="1"
              step="1"
              bind:value={callLimit}
              placeholder="No application call limit"
            /></label
          >
          <p class="muted">
            Leave blank to let the review continue without an application call ceiling. A budget
            applies to the next review; recorded work remains available if it is reached.
          </p>
        </details>
      </section>
      <FirmChecklistSettings
        checklist={firmChecklist}
        loaded={firmChecklistLoaded}
        message={firmChecklistMessage}
        disabled={packetBusy || cloudBlocked}
        onSave={saveFirmChecklist}
      />
      <section class="settings-section">
        <h3>Cloud reviews</h3>
        <p>{cloudSetup?.configured ? "Connected" : "Cloud connection needs setup"}</p>
        {#if cloudSetup?.message}<p class="muted">{cloudSetup.message}</p>{/if}
        <p class="muted">
          Choose Push to cloud in the composer. Progress and results sync automatically, including
          after you reopen Moke. Local edits pause during the review.
        </p>
        <p class="muted">
          Review time limit: {cloudSetup?.timeoutMinutes ?? 15} minutes. Model usage is billed separately
          from cloud compute.
        </p>
      </section>
      <section class="settings-section">
        <h3>Model connections</h3>
        <p>
          Meta <span class="connection-state"
            >{setup?.models?.some((model) => model.provider === "meta" && model.available)
              ? "Connected"
              : "Not connected"}</span
          >
        </p>
        <p>
          Baseten <span class="connection-state"
            >{setup?.models?.some((model) => model.provider === "baseten" && model.available)
              ? "Connected"
              : "Not connected"}</span
          >
        </p>
        <p class="muted">Add a connection from File → Import provider credential configuration.</p>
      </section>
      <section class="settings-section">
        <h3>You make the final call</h3>
        <p class="muted">
          Review the findings, evidence, governing sources, and any missing inputs before using a
          report. Completion checkboxes track your correction work; they do not change the review's
          evidence or source status.
        </p>
        <details>
          <summary>Technical details</summary>
          <p class="muted">
            MOKE uses the selected model's configured capabilities and durable review history.
            Context management preserves source records and completed work. Image-token usage and
            cost may be unavailable.
          </p>
          <p class="muted">
            {setup?.packetPromptVersion ?? setup?.promptVersion} · {setup?.instructionRevision.slice(
              0,
              12,
            )}
          </p>
        </details>
      </section>
      <footer><button class="btn md" onclick={() => settingsDialog?.close()}>Done</button></footer>
    </dialog>
    <div class="app-body">
      {#if sidebarOpen}
        <aside class="sidebar" aria-label="Conversation navigation">
          <button
            class="btn new-chat"
            data-testid="new-conversation"
            onclick={project ? createConversation : openProjectDialog}
            disabled={busy || cloudBlocked}
            ><ReviewIcon name="plus" size={16} /><span
              >{project ? "New conversation" : "New project"}</span
            ></button
          >
          <button class="nav-action" onclick={openSearch}
            ><ReviewIcon name="search" size={16} /><span>Search findings</span><kbd
              >{shortcutLabel}</kbd
            ></button
          >
          {#if !ready}<p role="status">Loading projects…</p>{/if}
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
            {#if project}
              <button class="nav-action" onclick={openProjectDialog} disabled={busy || cloudBlocked}
                ><ReviewIcon name="folder-plus" size={16} /><span>New project</span></button
              >
            {/if}
            <button
              class="nav-action"
              aria-label="Review settings"
              onclick={() => openSetup("settings")}
              ><ReviewIcon name="settings" size={16} /><span>Review settings</span><span
                class={["connection-dot", { connected: setup?.configured }]}
                title={setup?.configured ? "Provider configured" : "Provider not configured"}
              ></span></button
            >
            <div class="package-actions">
              <button
                class="nav-action"
                disabled={busy || cloudBlocked || !project}
                onclick={async () => {
                  busy = true;
                  const result = await client.chooseReviewExport();
                  busy = false;
                  if (!result.ok) error = result.error.message;
                  else if (result.value) notice = "Complete review package exported.";
                }}
                ><ReviewIcon name="package-export" size={16} /><span>Export complete package</span
                ></button
              ><button
                class="nav-action"
                disabled={busy || cloudBlocked}
                onclick={async () => {
                  busy = true;
                  const result = await client.chooseReviewRestore();
                  busy = false;
                  if (!result.ok) error = result.error.message;
                }}
                ><ReviewIcon name="package-import" size={16} /><span>Restore package</span></button
              >
            </div>
          </div>
        </aside>
      {/if}
      <section class="chat" class:canvas-covered={panelOpen} aria-label="Conversation">
        {#if error}<div class="banner" role="alert">
            <span>{error}</span><button
              class="icon-btn"
              aria-label="Dismiss error"
              onclick={() => (error = "")}><ReviewIcon name="x" size={16} /></button
            >
          </div>{/if}
        {#if packetConnectionLost}<div class="notice" role="status">
            <span>Local progress is reconnecting. Saved findings remain available.</span><button
              class="text-button"
              onclick={() => {
                if (selectedProjectId) {
                  packetSubscription?.abort();
                  packetSubscription = null;
                  void trackPacketReviews(selectedProjectId);
                }
              }}>Reconnect</button
            >
          </div>{/if}
        {#if notice}<div class="notice" role="status">
            <span>{notice}</span><button
              class="icon-btn"
              aria-label="Dismiss notification"
              onclick={() => (notice = "")}><ReviewIcon name="x" size={16} /></button
            >
          </div>{/if}
        <div
          class="chat-scroll"
          bind:this={chatViewport}
          onscroll={() => {
            if (
              !chatViewport ||
              (autoScrollTop !== null && Math.abs(chatViewport.scrollTop - autoScrollTop) < 2)
            )
              return;
            // The reader moved; a later return to the same position is theirs too.
            autoScrollTop = null;
            followLatest =
              chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight <= 24;
          }}
        >
          <div class="conversation-content">
            {#if !ready}<div class="chat-empty"><p role="status">Opening workspace…</p></div>
            {:else if project === null}<div class="chat-empty">
                {@render mark(40)}
                <h1>Start a drawing review</h1>
                <p>Create a project, import its drawings, and ask MOKE to review them.</p>
                <button class="btn md primary" onclick={openProjectDialog}
                  ><ReviewIcon name="folder-plus" size={16} />Create a project</button
                >
              </div>
            {:else if conversationMessages.length === 0}
              <div class="chat-empty">
                {@render mark(40)}
                <h1>What should MOKE review?</h1>
                {#if sheets.length === 0}<p>
                    Import a drawing PDF to begin. Your source sheets and review history stay with
                    this project.
                  </p>
                  <button class="btn md primary" disabled={busy} onclick={importPdf}
                    ><ReviewIcon name="upload" size={16} />Import drawings</button
                  >
                {:else}<p>
                    Ask for a whole-set QA pass or select a discipline reviewer. MOKE reads the
                    supplied sheets, checks sources and coordination, and prepares findings with
                    clear source evidence.
                  </p>
                  <p class="muted">
                    {initialReviewVisible
                      ? "Start with Initial Review for a complete first pass, or ask for a specific check."
                      : "For example: “Run a quick QA pass on this drawing set.”"}
                  </p>{/if}
              </div>
            {/if}
            {#each conversationMessages as message (message.id)}
              <article
                class={[
                  "message",
                  {
                    "application-message": message.role === "application",
                    "reviewer-message": message.role === "reviewer",
                  },
                ]}
              >
                {#if message.origin?.elapsedMs !== undefined}<p class="work-duration">
                    Worked for {formatElapsed(message.origin.elapsedMs)}
                  </p>{/if}
                <div class="byline">
                  {#if message.role === "reviewer"}<span class="user-mark">S</span
                    >{:else}{@render mark(20)}{/if}<strong
                    >{message.role === "reviewer" ? "You" : "MOKE"}</strong
                  >{#if message.origin}<span class="message-provenance selectable"
                      >Inspection · {message.origin.discipline?.replaceAll("_", " ") ??
                        "general"}</span
                    >{/if}
                </div>
                {#if message.role === "application"}<ReviewText
                    text={message.text}
                  />{:else if message.text === initialReview.text}<div class="preset-request">
                    <p>
                      <strong>Initial Review</strong>
                      <span class="muted">· whole set · all disciplines · four passes</span>
                    </p>
                    <details>
                      <summary>Show the full request</summary>
                      <p>{message.text}</p>
                    </details>
                  </div>{:else}<p>
                    {message.text}
                  </p>{/if}
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
            {#if activePacketReview}
              {#if displayedPacketReview && displayedPacketReview.id !== activePacketReview.id}
                <h3>Saved review</h3>
                {@render packetPanel(displayedPacketReview, true)}
                <h3>Latest review</h3>
              {/if}
              {@render packetPanel(activePacketReview)}
              {#if conversationReviews.length > 1}<details class="previous-reviews">
                  <summary>Previous reviews in this conversation</summary>{#each conversationReviews
                    .slice(0, -1)
                    .toReversed() as review (review.id)}<div>
                      <span
                        >{review.scope._tag === "Discipline"
                          ? review.scope.discipline.replaceAll("_", " ")
                          : review.scope._tag === "SelectedSheets"
                            ? "Selected sheets"
                            : "Whole set"} · {new Date(review.startedAt).toLocaleString()} · {review.state}</span
                      >
                      <button
                        class="text-button"
                        onclick={() => {
                          historyReviewId = review.id;
                        }}>Open saved review</button
                      >
                    </div>{/each}
                </details>{/if}
              {#if historyReviewId}<button
                  class="text-button"
                  onclick={() => {
                    historyReviewId = null;
                  }}>Back to latest review</button
                >{/if}
            {/if}
            {#if reviewFinding && !cloudBlocked}
              {#key reviewFinding.id + (activeConversation?.id ?? "")}<ExecutionControls
                  {client}
                  finding={reviewFinding}
                  conversation={activeConversation}
                  hasReply={conversationMessages.some(
                    (message) => message.origin?.runId === executionStatus?.runId,
                  )}
                  bind:status={executionStatus}
                  onProgress={async () => {
                    await refresh();
                  }}
                />{/key}
            {/if}
          </div>
        </div>
        <CloudReviewControls
          {client}
          bind:status={cloudStatus}
          bind:setup={cloudSetup}
          bind:loaded={cloudLoaded}
          projectId={selectedProjectId}
          conversationId={activeConversation?.id ?? null}
          projectName={project?.name ?? ""}
          {projects}
          onReturned={onCloudReturned}
        />
        {#if project}
          <div class="composer-region">
            {#if project}
              <div class="scope-bar">
                <ReviewSelect
                  label="Scope"
                  value={scopeMode}
                  options={[
                    { value: "whole_set", label: "Whole set" },
                    { value: "selected_sheets", label: "Selected sheets" },
                    { value: "discipline", label: "Selected discipline" },
                  ]}
                  disabled={busy || executionBlocked || cloudBlocked}
                  onChange={(value) => {
                    scopeMode = Schema.decodeUnknownSync(
                      Schema.Literals(["whole_set", "selected_sheets", "discipline"]),
                    )(value);
                    if (value === "selected_sheets") openSetup("sheets");
                  }}
                />
                <span class="muted review-scope"
                  >{scopeRevision?.name ?? "No revision"} · {scopeCount}
                  {scopeCount === 1 ? "sheet" : "sheets"}</span
                >
                {#if findings.length > 0}<div class="scope-select">
                    <ReviewSelect
                      label="Check"
                      value={reviewFindingId ?? ""}
                      options={[
                        { value: "", label: "Optional count comparison" },
                        ...findings.map((finding) => ({ value: finding.id, label: finding.title })),
                      ]}
                      disabled={busy || executionBlocked || cloudBlocked}
                      onChange={selectReviewFinding}
                    />
                  </div>{/if}
              </div>
            {/if}
            {#if initialReviewVisible}
              <div class="initial-review">
                <button
                  type="button"
                  class="btn primary"
                  disabled={!initialReviewReady}
                  aria-describedby="initial-review-summary"
                  onclick={startInitialReview}>Initial Review</button
                >
                <span id="initial-review-summary" class="muted" aria-live="polite"
                  >{initialReviewBlocker ?? initialReviewSummary}</span
                >
              </div>
            {/if}
            <form class="composer" onsubmit={postMessage}>
              <label class="sr-only" for="chat-message">Message</label><textarea
                id="chat-message"
                bind:this={composerInput}
                bind:value={draft}
                rows="2"
                maxlength="32000"
                placeholder={reviewMode === "review"
                  ? activePacketReview?.state === "running"
                    ? "Steer this review…"
                    : "Ask MOKE to review these drawings…"
                  : "Add a project note…"}
                onkeydown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={project === null || activeConversation === null || cloudBlocked}
              ></textarea>
              <div class="composer-tools">
                <div class="composer-options">
                  <ReviewSelect
                    label="Execution location"
                    value={location}
                    options={[
                      { value: "local", label: "On this computer" },
                      { value: "cloud", label: "Push to cloud", disabled: !cloudSetup?.configured },
                    ]}
                    disabled={busy || executionBlocked || cloudBlocked}
                    onChange={(value) => {
                      location = value === "cloud" ? "cloud" : "local";
                      if (location === "cloud") void refreshWorkspaceEstimate();
                    }}
                  />
                  <ReviewSelect
                    label="Model"
                    value={selectedModel}
                    options={modelOptions}
                    disabled={busy || executionBlocked || cloudBlocked}
                    onChange={(value) => {
                      selectedModel = Schema.decodeUnknownSync(ReviewModelId)(value);
                      modelChosen = true;
                    }}
                  />
                  <ReviewSelect
                    label="Reviewer"
                    value={scopeMode === "discipline" ? discipline : "all"}
                    options={scopeMode === "discipline"
                      ? [
                          {
                            value: "auto",
                            label: "Choose discipline…",
                            description: "Reviews sheets assigned to this discipline",
                          },
                          ...reviewDisciplines.map((scope) => ({
                            value: scope.id,
                            label: scope.label,
                          })),
                        ]
                      : [{ value: "all", label: "All disciplines" }]}
                    disabled={busy ||
                      executionBlocked ||
                      cloudBlocked ||
                      scopeMode !== "discipline"}
                    onChange={(value) => {
                      discipline = Schema.decodeUnknownSync(ReviewDisciplineSelection)(value);
                    }}
                  />
                </div>
                <button
                  type="button"
                  class="note-toggle"
                  aria-label="Save as note"
                  aria-pressed={reviewMode === "note"}
                  disabled={busy || cloudBlocked}
                  onclick={() => {
                    reviewMode = reviewMode === "note" ? "review" : "note";
                  }}>Note</button
                >
                <button
                  type="submit"
                  class="send"
                  disabled={!draft.trim() ||
                    busy ||
                    cloudBlocked ||
                    !project ||
                    (reviewMode === "review" &&
                      location === "cloud" &&
                      (cloudEstimateMissing ||
                        cloudEstimateOverLimit ||
                        cloudLocalReviews.length > 0)) ||
                    (reviewMode === "review" &&
                      activePacketReview?.state !== "running" &&
                      (sheets.length === 0 ||
                        !selectedModelAvailable ||
                        !validCallLimit ||
                        executionBlocked ||
                        !scopeCount))}
                  aria-label="Send message"
                  title={reviewMode === "review"
                    ? activePacketReview?.state === "running"
                      ? "Send follow-up to this review"
                      : location === "cloud"
                        ? "Push review to cloud"
                        : "Send and start document review"
                    : "Save note"}><ReviewIcon name="arrow-up" size={16} stroke={1.8} /></button
                >
              </div>
            </form>
            {#if reviewMode === "review" && location === "cloud" && !cloudBlocked}
              <div class="cloud-preview" aria-label="Cloud transfer preview">
                <strong>Cloud reviews use the whole workspace</strong>
                {#if cloudSetup?.workspaceEstimate}
                  {@const estimate = cloudSetup.workspaceEstimate}
                  {@const synced = Math.min(estimate.syncedBytes ?? 0, estimate.bytes)}
                  <span>
                    {#if synced > 0}About {((estimate.bytes - synced) / 1024 / 1024).toFixed(1)} MiB to
                      upload at Send; {(synced / 1024 / 1024).toFixed(1)} MiB of source files are already
                      in cloud storage ·{:else}Estimated {(estimate.bytes / 1024 / 1024).toFixed(1)} MiB
                      ·{/if}
                    {estimate.files} files ·
                    {estimate.projects}
                    {estimate.projects === 1 ? "project" : "projects"}. Limit: 1,024 MiB / 5,000
                    files.
                  </span>
                {:else}<span>
                    {estimatingWorkspace
                      ? "Measuring workspace…"
                      : "Check the workspace size before sending."}
                  </span>{/if}
                <button
                  class="text-button"
                  disabled={estimatingWorkspace || busy}
                  onclick={() => refreshWorkspaceEstimate()}
                  >{estimatingWorkspace ? "Measuring…" : "Recheck size"}</button
                >
                {#if cloudSetup?.workspaceEstimateError}<p role="alert">
                    {cloudSetup.workspaceEstimateError}
                  </p>{/if}
                {#if cloudLocalReviews.length > 0}<p role="alert">
                    Local reviews must finish or be cancelled before the whole workspace can go to
                    the cloud. Still active on this computer: {cloudLocalReviews.join(", ")}.
                    Recheck when they are done.
                  </p>{/if}
                {#if cloudEstimateOverLimit}<p role="alert">
                    This workspace exceeds the cloud limit. Your message has not been sent. Export a
                    backup and use a smaller workspace for this review.
                  </p>{/if}
              </div>
            {/if}
            <div class="composer-help">
              {#if submittingCloud && !cloudLocked && cloudSubmittedAt !== null}Checking cloud setup
                and packaging the workspace · {formatElapsed(
                  Math.max(0, cloudSubmitClock - cloudSubmittedAt),
                )}. Upload progress appears when packaging finishes.{:else if cloudBlocked}{cloudLoaded
                  ? "Cloud review in progress. Results sync automatically; local edits are paused."
                  : "Connecting to your cloud review…"}{:else if reviewMode === "review" && location === "cloud"}Uses
                every project in this workspace (up to 1 GiB / 5,000 files). Source PDFs and renders
                sync to cloud storage after import, so Send uploads the database, review history and
                any files not yet synced. Results sync automatically. Local edits pause until sync
                completes or you stop the review.{:else if reviewMode === "note"}Notes are saved
                without starting a review.{:else if activePacketReview?.state === "running"}Follow-ups
                join this review after its current tool round. Enter sends · Shift+Enter adds a
                line.{:else if sheets.length === 0}Import the drawing set to start a review.{:else if scopeMode === "discipline" && discipline === "auto"}Choose
                a discipline reviewer, then review its assigned sheets.{:else if !scopeCount}No
                sheets match this scope.
                <button class="text-button" onclick={() => openSetup("sheets")}
                  >Choose sheets or assign disciplines</button
                >.{:else if !setup?.configured}Provider not configured. <button
                  class="text-button"
                  onclick={() => openSetup("settings")}>Open review settings</button
                >{:else if !selectedModelAvailable}Choose a connected model or add a connection in
                review settings.{:else if !validCallLimit}Enter a positive whole-number call budget
                or leave it blank.{:else if executionBlocked}{activePacketReview?.state ===
                "uncertain"
                  ? "Cancel the stopped review to unlock a new request. Its saved work and possible charges remain recorded."
                  : "Use the review controls above before sending another request."}{:else}Review
                the findings, source status, and coverage before using the results.{/if}
            </div>
          </div>
        {/if}
      </section>
      {#if panelOpen}
        <aside class="source-panel" aria-label="Finding source" data-testid="source-panel">
          <header class="source-header">
            <ReviewIcon name="file-text" size={16} /><strong
              >{sourceTab === "evidence"
                ? (selectedFinding?.title ?? "Evidence")
                : (project?.name ?? "Project")}</strong
            ><button
              class="btn ghost-btn source-close"
              aria-label="Close source panel"
              onclick={closeSource}>Back to conversation<ReviewIcon name="x" size={16} /></button
            >
          </header>
          <div class="source-tabs">
            <button
              class={{ current: sourceTab === "evidence" }}
              disabled={busy || (!selectedFinding && !previewedSheet)}
              onclick={() => {
                sourceTab = "evidence";
                if (selectedFinding)
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
          </div>
          {#if error}<p role="alert" class="banner">{error}</p>{/if}
          <div
            class="source-scroll"
            class:packet-evidence={sourceTab === "evidence" && selectedPacketFinding !== null}
          >
            {#if sourceTab === "evidence" && selectedPacketFinding && selectedPacketText}<article
                class="selected-finding"
                data-testid="selected-packet-finding"
              >
                <h2>{selectedPacketText.title}</h2>
                <p class="muted">
                  {selectedPacketFinding.severity} · {selectedPacketFinding.status} · {selectedPacketFinding.discipline.replaceAll(
                    "_",
                    " ",
                  )}
                </p>
                <details
                  class="finding-description"
                  open={selectedPacketFinding.summary?._tag === "Ready"}
                >
                  <summary>Observation and correction</summary>
                  <p>{selectedPacketText.observed}</p>
                  <p><strong>Correction</strong> {selectedPacketText.correction}</p>
                </details>
                {#if selectedPacketFinding.summary?._tag === "Ready"}<details
                    class="finding-description"
                  >
                    <summary>Full technical finding</summary>
                    <h3>{selectedPacketFinding.title}</h3>
                    <p>{selectedPacketFinding.observed}</p>
                    <p><strong>Correction</strong> {selectedPacketFinding.correction}</p>
                  </details>{:else if selectedPacketFinding.summary?._tag === "Pending"}<p
                    role="status"
                    class="muted"
                  >
                    Short summary pending. The full technical finding is shown.
                  </p>{/if}
                <div class="finding-evidence-actions">
                  {#if selectedPacketFinding.focus}{@const focus =
                      selectedPacketFinding.focus}<button
                      class="ghost"
                      disabled={busy || sourceLoading || cloudBlocked}
                      onclick={() => openPacketFocus(focus)}
                      >SAM focus · {focus.segments.length}
                      {focus.segments.length === 1 ? "segment" : "segments"}</button
                    >{/if}
                  {#each selectedPacketFinding.locations as location, index (index)}<button
                      class="evidence-action"
                      disabled={busy || sourceLoading || cloudBlocked}
                      onclick={async () => {
                        const sheet = sheets.find((item) => item.id === location.sheetId);
                        if (sheet) {
                          await loadSheetSource(
                            sheet,
                            300,
                            location.region ?? undefined,
                            undefined,
                            location.region
                              ? [{ region: location.region, title: location.detail }]
                              : [],
                          );
                        }
                      }}
                      >{location.detail}{location.region
                        ? " · Focus detail"
                        : " · View sheet"}</button
                    >{/each}
                </div>
                {#if selectedPacketFinding.evidenceNote}<details>
                    <summary>Evidence notes</summary>
                    <p class="muted">{selectedPacketFinding.evidenceNote}</p>
                  </details>{/if}
                {#each selectedPacketFinding.citationIds as id (id)}{@const citation =
                    displayedPacketReview?.citations.find(
                      (item) => item.id === id,
                    )}{#if citation}<details>
                      <summary>{citation.document} {citation.section} · {citation.status}</summary>
                      <p>{citation.quote}</p>
                      <p>{citation.application}</p>
                      <p>{citation.note}</p>
                    </details>{/if}{/each}<label
                  ><input
                    type="checkbox"
                    checked={selectedPacketFinding.completed}
                    disabled={packetBusy || busy || cloudBlocked}
                    onchange={(event) => {
                      if (displayedPacketReview && selectedPacketFinding)
                        void completePacketFinding(
                          displayedPacketReview,
                          selectedPacketFinding.id,
                          event.currentTarget.checked,
                        );
                    }}
                  />Completed · tracks your correction work</label
                >
                {#key selectedPacketFinding.id}<FindingDecision
                    decision={selectedPacketFinding.decision}
                    disabled={packetBusy || busy || cloudBlocked}
                    onSave={async (decision) => {
                      if (displayedPacketReview && selectedPacketFinding)
                        await decidePacketFinding(
                          displayedPacketReview,
                          selectedPacketFinding.id,
                          decision,
                        );
                    }}
                  />{/key}
              </article>{/if}
            {#if sourceTab === "sheets"}
              <label class="revision-picker"
                >Revision<select
                  aria-label="Revision"
                  value={scopeRevision?.id ?? ""}
                  onchange={(event) => {
                    scopeRevisionId = event.currentTarget.value;
                    selectedSheetIds = [];
                  }}
                  >{#each revisions as revision (revision.id)}<option value={revision.id}
                      >{revision.name}</option
                    >{/each}</select
                ></label
              >
              <SheetSetup
                {loadThumbnail}
                onSuggestLabels={suggestSheetLabels}
                onApplyLabels={applySheetLabels}
                sheets={scopeSheets}
                bind:selectedIds={selectedSheetIds}
                onAssign={assignSheetDiscipline}
                busy={busy || sourceLoading || cloudBlocked}
                bind:createOpen={createFindingOpen}
                onConfirm={confirmSheet}
                onPreview={(sheet) => {
                  sourceTab = "evidence";
                  selectedPacketFindingId = null;
                  selectedFindingId = null;
                  void loadSheetSource(sheet, 96);
                }}
                onCreate={createFinding}
              />
            {:else if sourceTab === "evidence" && selectedFinding}
              {#if sourceLoading}<p class="muted" role="status">
                  Rendering source…
                </p>{:else if sourceImageUrl}<SourceViewer
                  bind:zoomFactor={sourceZoomFactor}
                  imageUrl={sourceImageUrl}
                  pdfToPixels={sourceArtifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
                  overlays={sourceOverlays}
                  label="Original source render"
                  bind:selecting={selectingRegion}
                  onSelectRegion={(region) => {
                    if (!previewedSheet) return;
                    const box = previewedSheet.box;
                    const x = Math.max(box.x, region.x);
                    const y = Math.max(box.y, region.y);
                    const width = Math.min(box.x + box.width, region.x + region.width) - x;
                    const height = Math.min(box.y + box.height, region.y + region.height) - y;
                    if (width <= 0 || height <= 0) return;
                    applySelectedRegion?.({ x, y, width, height });
                    sourceOverlays = [
                      { region: { x, y, width, height }, title: "Selected review area" },
                    ];
                    notice = "Review area selected. Confirm its count below.";
                  }}
                />{/if}
              {#if previewedSheet && sourceArtifact}<div class="source-provenance selectable">
                  <strong>{previewedSheet.label}</strong><span
                    >{revisions.find((item) => item.id === previewedSheet?.revisionId)?.name} · page
                    {previewedSheet.pageIndex + 1} · {sourceArtifact.dpi} DPI</span
                  >
                  <details>
                    <summary>Source details</summary><span
                      >Source SHA {revisions
                        .find((item) => item.id === previewedSheet?.revisionId)
                        ?.sha256.slice(0, 16)}</span
                    >
                  </details>
                </div>{/if}
              {#key selectedFinding.id}<FindingInspector
                  finding={selectedFinding}
                  {sheets}
                  {facts}
                  {checks}
                  busy={busy || cloudBlocked}
                  onAccept={acceptCount}
                  onEvaluate={evaluateFinding}
                  onStatus={setFindingStatus}
                  onRequestDetail={requestDetail}
                  onChooseRegion={async (side, apply) => {
                    if (!selectedFinding) return;
                    applySelectedRegion = apply;
                    selectingRegion = true;
                    await loadSourceForFinding(selectedFinding, 96, undefined, side);
                    document
                      .querySelector('[aria-label="Pan and zoom source canvas"]')
                      ?.scrollIntoView({ block: "nearest" });
                  }}
                />{/key}
            {:else if sourceTab === "evidence" && previewedSheet}
              {#if sourceLoading}<p class="muted" role="status">
                  Rendering source…
                </p>{:else if sourceImageUrl}<SourceViewer
                  bind:zoomFactor={sourceZoomFactor}
                  sheets={sheets.filter((sheet) => sheet.revisionId === previewedSheet?.revisionId)}
                  currentSheetId={previewedSheet?.id ?? null}
                  onSheet={async (sheet) => {
                    await loadSheetSource(
                      sheet,
                      96,
                      undefined,
                      undefined,
                      undefined,
                      undefined,
                      true,
                    );
                  }}
                  imageUrl={sourceImageUrl}
                  pdfToPixels={sourceArtifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
                  overlays={sourceOverlays}
                  masks={focusMasks}
                  label="Original source render"
                />{/if}
              <div class="source-provenance selectable">
                <strong>{previewedSheet.label}</strong><span
                  >{revisions.find((item) => item.id === previewedSheet?.revisionId)?.name} · page {previewedSheet.pageIndex +
                    1}{sourceIsCrop ? " · partial view of this page" : ""}</span
                >
                {#if displayedFocus}<span data-testid="sam-focus-caption"
                    >SAM 3.1 focus · {displayedFocus.segments.length} segmented
                    {displayedFocus.segments.length === 1 ? "object" : "objects"} · proposals, not verified
                    symbols</span
                  >{/if}
              </div>
            {:else if sourceTab === "revision"}
              <button
                class="btn import-revision"
                disabled={busy || cloudBlocked}
                onclick={importPdf}><ReviewIcon name="upload" size={16} />Import revision</button
              >
              <RevisionMapping
                {revisions}
                {sheets}
                {loadThumbnail}
                correspondence={snapshot?.sheetCorrespondence ?? []}
                busy={busy || cloudBlocked}
                onApply={associateRevision}
              />
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
          <ReviewIcon name="folder" size={16} /><strong>{project.name}</strong>
        </div>
        <div class="bubble-results">
          {#each packetFindings as finding (finding.id)}<button
              class="finding-row"
              onclick={() => showPacketFinding(finding.id)}
              ><ReviewIcon name="file-text" size={16} /><span class="finding-title"
                >{packetFindingText(finding).title}</span
              ><span class="outcome tag">{finding.severity}</span></button
            >{/each}
          {#if findings.length > 0}<p class="menu-section-label">Count comparisons</p>{/if}
          {#each findings as finding (finding.id)}<button
              class={["finding-row", { selected: selectedFindingId === finding.id }]}
              data-testid={"finding-row-" + finding.id}
              onclick={() => openFinding(finding)}
              title={findingSubtitle(finding, sheets)}
              ><ReviewIcon name="file-text" size={16} /><span class="finding-title"
                >{finding.title}</span
              ><span class="outcome tag">{formatOutcome(finding.outcome)}</span><ReviewIcon
                name="chevron-right"
                size={16}
              /></button
            >{/each}
          {#if packetFindings.length === 0 && findings.length === 0}<p class="menu-empty">
              No findings yet. Ask MOKE to review the supplied drawing set.
            </p>{/if}
        </div>{/if}
    </section>
    {#if searchOpen}<section class="search-panel" aria-label="Search findings">
        <div class="search-field">
          <ReviewIcon name="search" size={16} /><input
            aria-label="Search findings"
            placeholder={`Search this conversation in ${project?.name ?? "this project"}`}
            bind:this={searchInput}
            bind:value={findQuery}
          /><button class="icon-btn" aria-label="Close search" onclick={() => (searchOpen = false)}
            ><ReviewIcon name="x" size={16} /></button
          >
        </div>
        <div class="search-results">
          {#each visiblePacketFindings as finding (finding.id)}<button
              class="finding-row"
              onclick={() => showPacketFinding(finding.id)}
              ><span class="finding-title">{packetFindingText(finding).title}</span><span class="outcome tag"
                >{finding.severity} · {finding.status}</span
              ></button
            >{/each}
          {#each visibleFindings as finding (finding.id)}<button
              class="finding-row"
              onclick={() => openFinding(finding)}
              ><span class="finding-title">{finding.title}</span><span class="outcome tag"
                >{formatOutcome(finding.outcome)}</span
              ></button
            >{/each}
          {#if visiblePacketFindings.length === 0 && visibleFindings.length === 0}<p
              class="menu-empty"
            >
              {findQuery
                ? "No matching findings in this conversation or the project's count checks. Other conversations and projects are not searched."
                : "No findings in this conversation or count comparisons."}
            </p>{/if}
        </div>
      </section>{/if}
  </div>
</div>

<style>
  .workbench-root {
    font-family: var(--font-body);
    font-size: var(--text-body-sm);
  }
  .desktop {
    --sidebar-width: 232px;
    --source-width: min(420px, 40vw);
    height: 100dvh;
    overflow: hidden;
    background: var(--color-bg);
    color: var(--color-text);
    display: flex;
    flex-direction: column;
  }
  .desktop :global(p) {
    overflow-wrap: anywhere;
  }
  .window-bar {
    height: 52px;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--space-md);
    padding-right: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }
  .brand-slot {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 10px;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    align-self: stretch;
  }
  .brand-mark {
    --mark-size: 24px;
    width: var(--mark-size);
    height: var(--mark-size);
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-md);
    background: var(--color-ember);
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: calc(var(--mark-size) * 0.5);
    font-weight: 700;
    line-height: 1;
  }
  .brand-name {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .breadcrumbs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-size: var(--text-body-md);
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
    gap: var(--space-xs);
    align-items: center;
    color: var(--color-text-muted);
    max-width: 220px;
    min-width: 40px;
  }
  .project-monogram {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 600;
  }
  .breadcrumb-divider {
    color: var(--color-ash-soft);
  }
  .window-actions {
    display: flex;
    gap: var(--space-xs);
    align-items: center;
    flex-shrink: 0;
  }
  .finding-count {
    min-width: 18px;
    height: 18px;
    display: inline-grid;
    place-items: center;
    padding: 0 4px;
    border-radius: var(--radius-sm);
    background: var(--color-slate);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .findings-trigger.expanded,
  .sheets-trigger[aria-expanded="true"] {
    border-color: var(--color-ember);
  }
  .findings-trigger.expanded .finding-count,
  .sheets-trigger[aria-expanded="true"] .finding-count {
    background: var(--color-ember);
    color: var(--color-ink);
  }
  .previous-reviews {
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
    margin: var(--space-md) 0 28px;
  }
  .previous-reviews > div {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-xs) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .menu-section-label {
    margin: 0;
    padding: var(--space-xs) var(--space-sm) var(--space-2xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .finding-row + .menu-section-label {
    margin-top: var(--space-xs);
    padding-top: var(--space-sm);
    border-top: 1px solid var(--color-border);
  }
  .review-scope {
    font-size: var(--text-mono-sm);
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
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    padding: var(--space-md) 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .project-group,
  .projects,
  .threads {
    min-width: 0;
  }
  .new-chat {
    width: 100%;
    justify-content: flex-start;
    margin-bottom: var(--space-xs);
  }
  .project-heading,
  .threads button,
  .nav-action {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding: 0 var(--space-xs);
    min-height: 32px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-body-sm);
    font-weight: 500;
    transition:
      color var(--duration-fast) var(--ease-out),
      background var(--duration-fast) var(--ease-out);
  }
  .project-heading:hover:not(:disabled),
  .threads button:hover:not(:disabled),
  .nav-action:hover:not(:disabled) {
    background: var(--color-slate);
    color: var(--color-text);
  }
  .nav-action kbd {
    margin-left: auto;
    white-space: nowrap;
  }
  .projects {
    margin-top: var(--space-md);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-md);
  }
  .project-heading {
    padding-left: 4px;
  }
  .project-heading[aria-expanded="true"] {
    color: var(--color-text);
  }
  .project-heading span,
  .threads button span,
  .nav-action span:not(.connection-dot) {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .threads {
    margin: 2px 0 0 10px;
    padding-left: var(--space-xs);
    border-left: 1px solid var(--color-border);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .threads button.current {
    background: var(--color-slate);
    color: var(--color-text);
    box-shadow: inset 2px 0 0 var(--color-ember);
  }
  .threads button.current:focus-visible {
    box-shadow:
      inset 2px 0 0 var(--color-ember),
      var(--shadow-focus-ring);
  }
  .sidebar-footer {
    margin-top: auto;
    padding-top: var(--space-lg);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .connection-dot {
    margin-left: auto;
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 1px;
    border: 1px solid var(--color-ash);
  }
  .connection-dot.connected {
    border-color: var(--color-success);
    background: var(--color-success);
  }
  .package-actions {
    border-top: 1px solid var(--color-border);
    margin-top: var(--space-xs);
    padding-top: var(--space-xs);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
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
    padding: 40px 28px 20px;
  }
  .conversation-content {
    max-width: 68ch;
    margin: 0 auto;
  }
  .conversation-content > h3 {
    margin: var(--space-lg) 0 var(--space-sm);
    padding-bottom: var(--space-xs);
    border-bottom: 1px solid var(--color-border);
    font-family: var(--font-display);
    font-size: var(--text-title-md);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }
  .message {
    margin-bottom: 28px;
    font-size: var(--text-body-md);
    line-height: var(--leading-relaxed);
  }
  .reviewer-message {
    width: fit-content;
    max-width: 88%;
    margin-left: auto;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-slate);
    box-shadow: var(--shadow-card);
  }
  .reviewer-message .byline {
    display: none;
  }
  .reviewer-message p {
    margin: 0;
  }
  .work-duration {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
    margin-bottom: var(--space-sm);
  }
  .message p {
    margin: var(--space-xs) 0 0;
    white-space: pre-wrap;
  }
  .byline {
    display: flex;
    gap: var(--space-xs);
    align-items: center;
    font-size: var(--text-body-sm);
    line-height: 22px;
  }
  .byline strong {
    font-weight: 600;
  }
  .user-mark {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-slate);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 600;
  }
  .message-provenance {
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .message-source {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    margin-top: 10px;
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--color-accent);
    font-size: var(--text-body-sm);
    font-weight: 500;
  }
  .message-source:hover {
    color: var(--color-accent-hover);
  }
  .composer-region {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 10px 24px var(--space-md);
  }
  .scope-bar {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin-bottom: var(--space-xs);
  }
  .scope-select {
    min-width: 0;
    flex: 1;
  }
  .preset-request details p {
    margin-top: var(--space-xs);
  }
  .preset-request summary {
    margin-top: 6px;
    font-size: var(--text-body-sm);
  }
  .initial-review {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin-bottom: var(--space-xs);
    min-width: 0;
  }
  .initial-review span {
    min-width: 0;
    font-size: var(--text-mono-sm);
  }
  .text-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    white-space: nowrap;
    border: 0;
    background: transparent;
    color: var(--color-accent);
    padding: 4px 0;
    font-weight: 500;
  }
  .text-button:hover:not(:disabled) {
    color: var(--color-accent-hover);
  }
  .note-toggle {
    height: 24px;
    margin-left: auto;
    padding: 0 var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    transition:
      color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }
  .note-toggle:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-border-strong);
  }
  .note-toggle[aria-pressed="true"] {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .composer {
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--space-sm);
    transition:
      border-color var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) var(--ease-out);
  }
  .composer:hover {
    border-color: var(--color-border-strong);
  }
  .composer:has(textarea:focus) {
    border-color: var(--color-accent);
    box-shadow: var(--shadow-focus);
  }
  .composer textarea {
    display: block;
    width: 100%;
    resize: none;
    min-height: 56px;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 2px 2px 10px;
    color: inherit;
    font-size: var(--text-body-md);
    font-weight: 400;
    line-height: var(--leading-relaxed);
  }
  .composer textarea:focus,
  .composer textarea:focus-visible {
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .composer-tools {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    justify-content: space-between;
  }
  .composer-options {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    min-width: 0;
  }
  .send {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-ember);
    background: var(--color-ember);
    color: var(--color-ink);
    display: grid;
    place-items: center;
    transition:
      background var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }
  .send:hover:not(:disabled) {
    background: var(--color-spark);
    border-color: var(--color-spark);
  }
  .send:disabled {
    border-color: var(--color-border-strong);
    background: var(--color-slate);
    color: var(--color-text-muted);
    opacity: 1;
  }
  .composer-help {
    font-size: var(--text-mono-sm);
    line-height: 1.5;
    color: var(--color-text-muted);
    margin-top: var(--space-xs);
    min-height: 18px;
  }
  .composer-help .text-button {
    font-size: var(--text-mono-sm);
    padding: 0;
  }
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-md);
    margin: 12vh auto 32px;
    max-width: 480px;
    text-align: center;
  }
  .chat-empty h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-headline-lg);
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  .chat-empty p {
    color: var(--color-text-muted);
    line-height: var(--leading-relaxed);
    margin: 0;
    font-size: var(--text-body-md);
  }
  .banner,
  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    justify-content: space-between;
    margin: 0;
    padding: 6px var(--space-sm) 6px var(--space-md);
    border-bottom: 1px solid var(--color-border);
    line-height: 1.5;
  }
  .banner {
    color: var(--color-error);
    background: var(--color-surface);
    box-shadow: inset 2px 0 0 var(--color-error);
  }
  .notice {
    color: var(--color-text-muted);
    background: var(--color-surface);
  }
  .source-panel {
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .source-header {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding: 0 var(--space-xs) 0 var(--space-md);
    min-height: 51px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .source-header strong {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--color-text);
    font-size: var(--text-body-md);
    font-weight: 600;
  }
  .source-tabs {
    display: flex;
    gap: var(--space-lg);
    padding: 0 var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .source-tabs button {
    position: relative;
    margin-inline: calc(var(--space-2xs) * -1);
    padding: var(--space-sm) var(--space-2xs);
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    transition: color var(--duration-fast) var(--ease-out);
  }
  .source-tabs button::after {
    content: "";
    position: absolute;
    left: var(--space-2xs);
    right: var(--space-2xs);
    bottom: -1px;
    height: 2px;
    background: transparent;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .source-tabs button:hover:not(:disabled),
  .source-tabs button.current {
    color: var(--color-text);
  }
  .source-tabs button.current::after {
    background: var(--color-ember);
  }
  .source-tabs button:focus-visible {
    border-radius: var(--radius-sm);
    color: var(--color-text);
  }
  .source-scroll {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .source-provenance {
    display: grid;
    gap: 4px;
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .source-provenance strong {
    color: var(--color-text);
    font-size: var(--text-body-sm);
    font-weight: 600;
  }
  .source-provenance details span {
    font-family: var(--font-mono);
    letter-spacing: var(--tracking-wide);
  }
  .settings-section {
    display: grid;
    gap: var(--space-sm);
    padding-bottom: 20px;
    border-bottom: 1px solid var(--color-border);
  }
  .settings-section p {
    font-size: var(--text-body-sm);
    line-height: var(--leading-relaxed);
    margin: 0;
  }
  .muted {
    color: var(--color-text-muted);
  }
  .findings-bubble {
    margin: 0;
    padding: var(--space-xs);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-pop);
    overflow-y: auto;
  }
  .bubble-context {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-xs) var(--space-sm) var(--space-sm);
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
  }
  .bubble-context strong {
    font-weight: 600;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bubble-results,
  .search-results {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    padding-top: var(--space-xs);
  }
  .finding-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 0;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-body-sm);
    font-weight: 500;
    text-align: left;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .finding-row:hover,
  .finding-row.selected {
    background: var(--color-slate);
  }
  .finding-row.selected {
    box-shadow: inset 2px 0 0 var(--color-ember);
  }
  .finding-row.selected:focus-visible {
    box-shadow:
      inset 2px 0 0 var(--color-ember),
      var(--shadow-focus-ring);
  }
  .finding-row > :global(svg) {
    color: var(--color-text-muted);
  }
  .finding-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .finding-row .outcome {
    margin-left: auto;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu-empty {
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    line-height: var(--leading-relaxed);
    color: var(--color-text-muted);
  }
  .workspace-dialog {
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    padding: var(--space-lg);
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100dvh - 48px);
    overflow: auto;
    box-shadow: var(--shadow-pop);
  }
  .workspace-dialog header {
    display: flex;
    gap: var(--space-md);
    align-items: center;
    justify-content: space-between;
    padding-bottom: var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .workspace-dialog h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-headline-md);
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  .workspace-dialog h3 {
    margin: 0;
    font-size: var(--text-body-md);
    font-weight: 600;
  }
  .workspace-dialog p {
    line-height: var(--leading-relaxed);
    font-size: var(--text-body-sm);
  }
  .workspace-dialog footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-xs);
    margin-top: var(--space-lg);
  }
  .project-form {
    display: grid;
    gap: var(--space-md);
  }
  .project-form p {
    color: var(--color-text-muted);
    margin: 0;
  }
  .project-form label,
  .import-label,
  .settings-dialog label {
    display: grid;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .project-form input,
  .import-label input,
  .settings-dialog input {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 var(--space-md);
    font-family: var(--font-body);
    font-size: var(--text-body-md);
    letter-spacing: normal;
    text-transform: none;
  }
  .dialog-error {
    color: var(--color-error);
  }
  .settings-dialog {
    width: min(520px, calc(100vw - 32px));
  }
  .settings-dialog .settings-section {
    padding: 20px 0;
  }
  .settings-dialog .settings-section p {
    margin: 6px 0;
  }
  .connection-state {
    float: right;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .workspace-dialog details {
    margin-top: var(--space-sm);
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
  }
  .workspace-dialog details > :not(summary) {
    margin-top: var(--space-xs);
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
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    padding: var(--space-xs);
    z-index: 20;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    padding: 0 0 var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .search-field input {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    border: 0;
    background: transparent;
    padding: 0 var(--space-2xs);
    color: var(--color-text);
    font-size: var(--text-body-md);
    font-weight: 400;
  }
  .search-field input:focus,
  .search-field input:focus-visible {
    background: transparent;
    box-shadow: none;
  }
  .search-field:has(input:focus-visible) {
    border-bottom-color: var(--color-accent);
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
      box-shadow: var(--shadow-pop);
    }
    .project-crumb {
      max-width: 150px;
    }
  }
  @media (max-width: 1180px) {
    .import-trigger,
    .secondary-count {
      width: 32px;
      padding: 0;
    }
    .import-trigger span,
    .secondary-count span {
      display: none;
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
      display: inline-flex;
    }
    .secondary-count {
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
      padding-left: var(--space-xs);
      gap: 6px;
    }
    .window-bar {
      gap: var(--space-xs);
      padding-right: var(--space-xs);
    }
    .breadcrumbs {
      display: none;
    }
    .window-actions {
      margin-left: auto;
      gap: 4px;
    }
    .window-actions :global(.btn) {
      padding: 0 var(--space-xs);
      gap: 4px;
    }
    .sidebar {
      position: fixed;
      inset: 52px auto 0 0;
      width: 240px;
      z-index: 15;
      visibility: hidden;
      box-shadow: var(--shadow-pop);
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
      padding: 28px 20px var(--space-md);
    }
    .composer-region {
      padding: 10px var(--space-md) 14px;
    }
    .chat-empty {
      margin-top: 8vh;
    }
  }
  .desktop.source-open .app-body {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  }
  .desktop.sidebar-closed.source-open .app-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .chat.canvas-covered {
    display: none;
  }
  .source-panel {
    min-width: 0;
    width: auto;
  }
  .source-scroll {
    display: flex;
    flex-direction: column;
  }
  .source-scroll :global(.viewer) {
    flex: 1 0 min(62vh, 720px);
    height: min(62vh, 720px);
    min-height: 360px;
  }
  .conversation-content {
    max-width: 1120px;
    width: 100%;
  }
  .composer-region {
    width: 100%;
    max-width: 1180px;
    align-self: center;
  }
  .application-message p {
    max-width: 85ch;
  }
  .selected-finding {
    max-width: 1000px;
    padding: 0 0 20px;
    line-height: var(--leading-relaxed);
    font-size: var(--text-body-md);
  }
  .selected-finding h2 {
    margin: 0 0 var(--space-xs);
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  .selected-finding p {
    margin: var(--space-xs) 0;
  }
  .selected-finding details {
    margin: var(--space-xs) 0;
  }
  .selected-finding > label {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin-top: var(--space-sm);
    color: var(--color-text-muted);
  }
  .source-scroll.packet-evidence {
    display: grid;
    grid-template-columns: minmax(230px, 31%) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    min-height: 0;
    overflow: hidden;
    gap: 14px;
  }
  .packet-evidence .selected-finding {
    grid-column: 1;
    grid-row: 1 / span 2;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--space-sm) var(--space-xs) 0;
    font-size: var(--text-body-sm);
    line-height: 1.5;
  }
  .packet-evidence .selected-finding h2 {
    font-size: var(--text-title-md);
    line-height: 1.3;
  }
  .finding-evidence-actions {
    display: grid;
    gap: 2px;
    margin: var(--space-sm) 0;
  }
  .evidence-action {
    width: 100%;
    padding: var(--space-xs) 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-slate);
    color: var(--color-text);
    text-align: left;
    white-space: normal;
    line-height: 1.4;
    font-size: var(--text-body-sm);
    transition: border-color var(--duration-fast) var(--ease-out);
  }
  .evidence-action:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .source-scroll.packet-evidence :global(.viewer) {
    grid-column: 2;
    grid-row: 1;
    height: 100%;
    min-height: 0;
  }
  .packet-evidence > .muted {
    grid-column: 2;
    grid-row: 1;
  }
  .packet-evidence > .source-provenance {
    grid-column: 2;
    grid-row: 2;
  }
  .cloud-preview {
    display: flex;
    gap: 6px var(--space-sm);
    flex-wrap: wrap;
    align-items: baseline;
    margin: 10px 4px 0;
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
  }
  .cloud-preview strong {
    color: var(--color-text);
    font-weight: 600;
  }
  .cloud-preview p {
    flex-basis: 100%;
    margin: 0;
  }
  .cloud-preview p[role="alert"] {
    color: var(--color-error);
  }
  .revision-picker {
    display: flex;
    gap: var(--space-sm);
    align-items: center;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .revision-picker select {
    flex: 1;
    min-width: 0;
    font-family: var(--font-body);
    letter-spacing: normal;
    text-transform: none;
  }
  .import-revision {
    align-self: flex-start;
  }
  .compact-actions {
    display: none;
    position: relative;
    font-size: var(--text-body-sm);
  }
  .compact-actions summary {
    height: 32px;
    padding: 0 var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-label-sm);
    font-weight: 600;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .compact-actions > div {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    min-width: 180px;
    padding: var(--space-2xs);
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    z-index: 20;
  }
  .compact-actions button {
    display: block;
    width: 100%;
    min-height: 32px;
    padding: 0 10px;
    text-align: left;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-body-sm);
  }
  .compact-actions button:hover:not(:disabled) {
    background: var(--color-slate);
  }
  @media (max-width: 900px) {
    .compact-actions {
      display: block;
    }
  }
  .compact-project {
    display: none;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
    font-size: var(--text-body-sm);
  }
  @media (max-width: 900px) {
    .compact-project {
      display: block;
    }
    .window-actions {
      min-width: 0;
    }
  }
  @media (max-width: 700px) {
    .window-actions .import-trigger {
      display: none;
    }
  }
  .scope-bar {
    flex-wrap: wrap;
  }
  .import-dialog {
    width: min(580px, calc(100vw - 32px));
  }
  .import-label {
    margin-top: var(--space-md);
  }
  .pdf-drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-sm);
    padding: 40px 20px;
    margin-top: 20px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-slate);
    color: var(--color-text-muted);
  }
  .pdf-drop-zone strong {
    color: var(--color-text);
    font-size: var(--text-body-md);
    font-weight: 600;
  }
  .pdf-drop-zone span {
    font-size: var(--text-body-sm);
  }
  @media (max-width: 1180px) and (min-width: 701px) {
    .desktop.source-open .app-body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 700px) {
    .desktop.source-open .app-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .source-scroll :global(.viewer) {
      min-height: 300px;
    }
    .source-scroll.packet-evidence {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(90px, 180px) minmax(0, 1fr) auto;
    }
    .packet-evidence .selected-finding {
      grid-row: 1;
      padding: 0;
    }
    .source-scroll.packet-evidence :global(.viewer) {
      grid-column: 1;
      grid-row: 2;
      min-height: 0;
    }
    .packet-evidence > .muted {
      grid-column: 1;
      grid-row: 2;
    }
    .packet-evidence > .source-provenance {
      grid-column: 1;
      grid-row: 3;
    }
  }
</style>
