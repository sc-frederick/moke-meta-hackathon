import { expect, test } from "bun:test";
import { Schema } from "effect";
import { renderPacketReport } from "../../backend/packet-review/report.ts";
import { PacketReview, PacketScope } from "#lib/review/packet.ts";
import { initializePacketCoverage } from "#lib/review/packet-coverage.ts";

const identifiers = {
  review: "10000000-0000-4000-8000-000000000001",
  project: "10000000-0000-4000-8000-000000000002",
  conversation: "10000000-0000-4000-8000-000000000003",
  request: "10000000-0000-4000-8000-000000000004",
  sheet: "10000000-0000-4000-8000-000000000005",
  revision: "10000000-0000-4000-8000-000000000006",
  finding: "10000000-0000-4000-8000-000000000007",
  evidence: "10000000-0000-4000-8000-000000000008",
  source: "10000000-0000-4000-8000-000000000009",
  citation: "10000000-0000-4000-8000-000000000010",
  calculation: "10000000-0000-4000-8000-000000000011",
  prior: "10000000-0000-4000-8000-000000000012",
};

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM8sAAAAASUVORK5CYII=";

function review(changes: Partial<PacketReview> = {}) {
  return Schema.decodeUnknownSync(PacketReview)({
    id: identifiers.review,
    projectId: identifiers.project,
    projectName: "Local QA fixture",
    conversationId: identifiers.conversation,
    requestId: identifiers.request,
    request: "Review the supplied electrical sheet and document unavailable governing sources.",
    scope: PacketScope.members[1].make({ discipline: "electrical" }),
    model: "muse-spark-1.3",
    provider: "meta",
    state: "completed",
    version: 3,
    startedAt: Date.UTC(2026, 9, 28, 18),
    changedAt: Date.UTC(2026, 9, 28, 18, 5),
    maxCalls: null,
    admittedCalls: 6,
    promptVersion: "moke-packet-test",
    instructionRevision: "fixture-revision",
    sheets: [
      {
        id: identifiers.sheet,
        revisionId: identifiers.revision,
        label: "E-101",
        pageIndex: 0,
        box: { x: 0, y: 0, width: 612, height: 792 },
        sha256: "a".repeat(64),
        documentName: "Electrical plans.pdf",
      },
    ],
    inspectedSheetIds: [identifiers.sheet],
    evidenceIds: [identifiers.evidence],
    projectConfiguration: {
      Jurisdiction: "Needs input",
      Scope: "Electrical coordination",
      permitStage: "Needs input - submittal date not stated",
    },
    coverage: [
      {
        sheetId: identifiers.sheet,
        pass: "completeness",
        discipline: "general",
        status: "checked",
        note: "Sheet and referenced detail inventoried.",
      },
      {
        sheetId: identifiers.sheet,
        pass: "requirements",
        discipline: "electrical",
        status: "needs_input",
        note: "Governing edition is not supplied.",
      },
      {
        sheetId: identifiers.sheet,
        pass: "coordination",
        discipline: "electrical",
        status: "issue",
        note: "Equipment tag disagrees with the schedule.",
      },
      {
        sheetId: identifiers.sheet,
        pass: "prior_comments",
        discipline: "electrical",
        status: "checked",
        note: "Read revised schedule against agency comment.",
      },
    ],
    sources: [
      {
        id: identifiers.source,
        url: "https://example.gov/code?edition=2023&section=1",
        title: "Official code source",
        retrievedAt: "2026-10-28T18:03:00.000Z",
        status: "unavailable",
        official: true,
        sha256: null,
        text: "Official text requires access.",
      },
    ],
    citations: [
      {
        id: identifiers.citation,
        sourceId: identifiers.source,
        jurisdiction: "Needs input",
        document: "Electrical code",
        edition: "Needs input",
        section: "Printed section on E-101",
        quote: "",
        application: "Cannot establish the governing requirement from the printed reference alone.",
        status: "unverified",
        note: "Source access is unavailable.",
      },
    ],
    calculations: [
      {
        id: identifiers.calculation,
        title: "Recorded current",
        expression: "power / voltage",
        inputs: { power: { value: 2400, unit: "W" }, voltage: { value: 240, unit: "V" } },
        result: 10,
        unit: "A",
        explanation:
          "Compare the calculation with the plan's stated load; governing limit needs input.",
      },
    ],
    findings: [
      {
        id: identifiers.finding,
        title: "Equipment tag differs between plan and schedule",
        discipline: "electrical",
        severity: "Major",
        status: "Confirmed",
        classification: "Drawing conflict",
        locations: [
          {
            sheetId: identifiers.sheet,
            detail: "Equipment plan and schedule",
            region: { x: 10, y: 20, width: 30, height: 40 },
          },
        ],
        observed: "Plan shows AHU-1; schedule shows AHU-2 at the corresponding connection.",
        correction: "Reconcile the equipment tag at the plan connection and schedule row.",
        evidenceIds: [identifiers.evidence],
        evidenceNote: "Plan and schedule tag callouts.",
        citationIds: [],
        calculationIds: [identifiers.calculation],
        priorCommentId: identifiers.prior,
        completed: false,
      },
    ],
    priorComments: [
      {
        id: identifiers.prior,
        agency: "Example jurisdiction",
        date: "2026-10-20",
        number: "E-3",
        comment: "Reconcile the equipment tag.",
        response: "Schedule revised.",
        changedSources: "E-101 schedule row reviewed; plan remains inconsistent.",
        status: "Partly resolved",
        evidenceIds: [identifiers.evidence],
      },
    ],
    summary: "A drawing conflict remains and the governing source needs input.",
    missingInputs: ["Jurisdiction and governing code edition."],
    error: null,
    finished: true,
    ...changes,
  });
}

test("packet report retains actual coverage, source status, calculations, prior comments and offline evidence", () => {
  const html = renderPacketReport(review(), new Map([[identifiers.evidence, pixel]]));

  for (const content of [
    "Electrical review",
    "Review has unresolved coverage or inputs",
    "Document completeness",
    "Code and agency requirements",
    "Plan, calculation and detail coordination",
    "Prior-comment closure",
    "Official text requires access.",
    "unverified",
    "Partly resolved",
    "Result: 10 A",
    "power / voltage",
    "Content SHA-256",
    "fixture-revision",
    "Evidence manifest",
    "E-101",
    "Electrical plans.pdf",
    "governing code edition",
    "Source image opened",
    "reviewer-verified prior-comment closure",
    // Saved camelCase keys are labelled for readers; values keep their casing.
    "<dt>Permit stage</dt><dd>Needs input - submittal date not stated</dd>",
  ])
    expect(html).toContain(content);
  expect(html).not.toContain("permitStage");
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  expect(html).toContain(`src="${pixel}"`);
  expect(html).toContain("https://example.gov/code?edition=2023&amp;section=1");
  expect(html).not.toMatch(/<(?:script|link|iframe|img)[^>]+(?:src|href)="https?:/);
  expect(html).not.toContain("@import");
  expect(html.match(/<script>/g)).toHaveLength(1);
});

test("packet report links a citation's Florida code section for the engineer to confirm", () => {
  const url =
    "https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1004";

  const base = review();

  const html = renderPacketReport(
    review({
      citations: base.citations.map((citation) => ({
        ...citation,
        reference: {
          id: "codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1004",
          document: "FBC Building (Commercial)",
          edition: "2023 8th Edition",
          title: "1004 Occupant Load",
          url,
          access: "open_in_browser",
        },
      })),
    }),
    new Map([[identifiers.evidence, pixel]]),
  );

  expect(html).toContain(
    "<dt>Code section</dt><dd>1004 Occupant Load · FBC Building (Commercial), 2023 8th Edition<br>",
  );
  expect(html).toContain(`<a href="${url}" rel="noopener noreferrer" target="_blank">`);
  // The link is a pointer for the engineer, not retrieved text, so the citation stays unverified.
  expect(html).toContain("unverified");
});

test("packet report escapes model and source text and refuses executable evidence", () => {
  const hostile =
    '</script><img src=x onerror="globalThis.reportInjected=true"><script>alert(1)</script>';

  const input = review({
    projectName: hostile,
    projectConfiguration: { [hostile]: hostile },
    summary: hostile,
    sources: [
      {
        ...review().sources[0],
        id: identifiers.source,
        url: 'javascript:alert("source")',
        title: hostile,
        retrievedAt: hostile,
        status: "unavailable",
        official: false,
        sha256: null,
        text: hostile,
      },
    ],
    findings: review().findings.map((finding) => ({
      ...finding,
      title: hostile,
      observed: hostile,
      correction: hostile,
      evidenceNote: hostile,
    })),
  });

  for (const invalid of [
    'javascript:alert("image")',
    "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=",
    'data:image/png;base64,AA" onerror="alert(1)',
  ]) {
    const html = renderPacketReport(input, new Map([[identifiers.evidence, invalid]]));
    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;/script&gt;&lt;img");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain(`src="${invalid}"`);
    expect(html).toContain(`Evidence ${identifiers.evidence} is unavailable in this report.`);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<img /g) ?? []).toHaveLength(0);
  }
});

test("unrecorded sheet passes and missing issue evidence remain explicit", () => {
  const input = review({
    coverage: [],
    inspectedSheetIds: [],
    findings: review().findings.map((finding) => ({
      ...finding,
      evidenceIds: [],
      evidenceNote: "No legible source image was available for this observed conflict.",
    })),
  });

  const html = renderPacketReport(input, new Map());
  expect(html).toContain("Source image not opened");
  expect(html.match(/No coverage entry recorded\./g)).toHaveLength(4);
  expect(html).toContain("No legible source image was available");
  expect(html).toContain("No image attached");
  expect(html).not.toContain("Requested review recorded");
});

test("completion controls share stable issue ids and isolate saved state by project and revision", () => {
  const input = review();
  const html = renderPacketReport(input, new Map());
  expect(
    html.match(new RegExp(`data-completion-id="finding:${identifiers.finding}"`, "g")),
  ).toHaveLength(2);
  expect(html).toContain(`data-completion-id="prior:${identifiers.prior}"`);
  expect(html).toContain(`for="completed-summary-finding:${identifiers.finding}"`);
  expect(html).toContain(`for="completed-detail-finding:${identifiers.finding}"`);
  expect(
    html.match(new RegExp(`data-completion-id="finding:${identifiers.finding}" checked`, "g")) ??
      [],
  ).toHaveLength(0);

  const initialCompleted = renderPacketReport(
    review({ findings: input.findings.map((finding) => ({ ...finding, completed: true })) }),
    new Map(),
  );

  expect(
    initialCompleted.match(
      new RegExp(`data-completion-id="finding:${identifiers.finding}" checked`, "g"),
    ),
  ).toHaveLength(2);
  const storageKey = `moke:packet-report:${identifiers.project}:${identifiers.review}:v3`;
  expect(html).toContain(`data-storage-key="${storageKey}"`);
  expect(renderPacketReport(review({ version: 4 }), new Map())).not.toContain(
    `data-storage-key="${storageKey}"`,
  );
  expect(
    renderPacketReport(
      review({
        projectId: Schema.decodeUnknownSync(PacketReview.fields.projectId)(crypto.randomUUID()),
      }),
      new Map(),
    ),
  ).not.toContain(`data-storage-key="${storageKey}"`);
  expect(html).toContain("choices are temporary because browser storage is unavailable");
  expect(html).toContain("@media print");
});

test("a finished run does not hide an unresolved finding behind complete coverage", () => {
  const input = review();

  const html = renderPacketReport(
    review({
      coverage: input.coverage.map((entry) => ({ ...entry, status: "checked" })),
      citations: [],
      missingInputs: [],
      findings: input.findings.map((finding) => ({ ...finding, status: "Needs input" })),
    }),
    new Map(),
  );

  expect(html).toContain("Review has unresolved coverage or inputs");
  expect(html).not.toContain("Requested review recorded");
});

test("whole-set reports expose every missing discipline instead of accepting General-only coverage", () => {
  const base = review();
  const scope = PacketScope.cases.WholeSet.make({});

  const coverage = initializePacketCoverage(
    PacketScope.cases.Discipline.make({ discipline: "general" }),
    base.sheets,
  ).map((entry) => ({ ...entry, status: "checked" as const }));

  const html = renderPacketReport(
    review({
      scope,
      coverage,
      findings: [],
      citations: [],
      sources: [],
      priorComments: [],
      missingInputs: [],
    }),
    new Map(),
  );

  expect(html).toContain("Review has unresolved coverage or inputs");
  expect(html).not.toContain("Requested review recorded");
  expect(html).toContain("Civil · Document completeness (missing)");
  expect(html).toContain("Fire alarm · Code and agency requirements (missing)");
  expect(html.match(/No coverage entry recorded\./g)).toHaveLength(40);
});

test("whole-set report coverage settles all disciplines only with explicit exclusion reasons", () => {
  const base = review();
  const scope = PacketScope.cases.WholeSet.make({});

  const coverage = initializePacketCoverage(scope, base.sheets).map((entry) =>
    entry.discipline === "electrical" || entry.discipline === "general"
      ? {
          ...entry,
          status: "checked" as const,
          note: "Reviewed the supplied drawing and its references.",
        }
      : {
          ...entry,
          status: "not_applicable" as const,
          note: "No work in this discipline appears in the supplied electrical-only sheet.",
        },
  );

  const completion = {
    scope,
    coverage,
    findings: [],
    citations: [],
    sources: [],
    priorComments: [],
    missingInputs: [],
  };

  const completed = review(completion);

  expect(renderPacketReport(completed, new Map())).toContain("Requested review recorded");

  const withoutReason = review({
    ...completion,
    coverage: coverage.map((entry) =>
      entry.discipline === "civil" && entry.pass === "requirements"
        ? { ...entry, note: "" }
        : entry,
    ),
  });

  const html = renderPacketReport(withoutReason, new Map());
  expect(html).not.toContain("Requested review recorded");
  expect(html).toContain("Not applicable requires an explicit reason.");
});

test("discipline reports cannot borrow General coverage and do not inherit unrelated scope gaps", () => {
  const base = review();

  const generalRows = initializePacketCoverage(
    PacketScope.cases.Discipline.make({ discipline: "general" }),
    base.sheets,
  ).map((entry) => ({ ...entry, status: "checked" as const }));

  const input = review({
    coverage: generalRows,
    findings: [],
    citations: [],
    sources: [],
    priorComments: [],
    missingInputs: [],
  });

  const absent = renderPacketReport(input, new Map());
  expect(absent).not.toContain("Requested review recorded");
  expect(absent.match(/No coverage entry recorded\./g)).toHaveLength(4);

  const scopedRows = initializePacketCoverage(base.scope, base.sheets).map((entry) => ({
    ...entry,
    status: "checked" as const,
  }));

  const scoped = review({
    findings: [],
    citations: [],
    sources: [],
    priorComments: [],
    missingInputs: [],
    coverage: [
      ...generalRows.map((entry) => ({
        ...entry,
        status: "needs_input" as const,
        note: "An earlier General check still needs its source.",
      })),
      ...scopedRows,
    ],
  });

  const html = renderPacketReport(scoped, new Map());
  expect(html).toContain("Requested review recorded");
  expect(html).toContain("An earlier General check still needs its source.");
});
