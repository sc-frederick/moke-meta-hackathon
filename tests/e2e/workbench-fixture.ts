import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema, Struct } from "effect";
import {
  Artifact,
  Conversation,
  Project,
  ReviewMessage,
  Revision,
  Sheet,
} from "#lib/review/contracts.ts";
import { PacketReview, PacketScope, ReviewPass } from "#lib/review/packet.ts";
import { electron } from "./isolated-electron.ts";

/** Launch options for an offline desktop session whose providers are configured but never dispatched. */
export async function offlineDesktop(
  directory: string,
  providers: ReadonlyArray<"meta" | "baseten">,
) {
  const credentialFile = join(directory, "offline-provider-config.json");

  await writeFile(
    credentialFile,
    JSON.stringify({
      providers: providers.map((provider) =>
        provider === "meta"
          ? {
              provider,
              apiKey: "offline-ui-test-never-dispatched",
              baseUrl: "https://api.meta.ai/v1",
              model: "muse-spark-1.3",
            }
          : {
              provider,
              apiKey: "offline-ui-test-never-dispatched",
              baseUrl: "https://inference.baseten.co/v1",
              model: "meta-models/muse-spark-open-1026",
            },
      ),
    }),
    { mode: 0o600 },
  );

  const options: Parameters<typeof electron.launch>[0] = {
    args: [".", `--user-data-dir=${join(directory, "profile")}`],
    env: { PROJECT_KIT_DATA_DIRECTORY: directory, MOKE_SESSION_CREDENTIAL_FILE: credentialFile },
  };

  if (process.env.PROJECT_KIT_EXECUTABLE !== undefined) {
    options.executablePath = process.env.PROJECT_KIT_EXECUTABLE;
    options.args = [`--user-data-dir=${join(directory, "profile")}`];
    options.cwd = directory;
  }

  return options;
}

/** Open the workbench window at the documented desktop size and collect renderer errors. */
export async function openWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByTestId("review-workbench")).toBeVisible();

  return { page, errors };
}

/** Create a project from either entry point and wait until it can import drawings. */
export async function createProject(page: Page, name: string) {
  const empty = page.getByRole("button", { name: "Create a project", exact: true });

  if (await empty.isVisible()) await empty.click();
  else await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByTestId("project-name-input").fill(name);
  await page.getByTestId("create-project-button").click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(name);
  await expect(page.getByTestId("import-pdf")).toBeEnabled();
}

/** Import a PDF through the native chooser and return to the conversation. */
export async function importPdf(app: ElectronApplication, page: Page, source: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, source);
  await page.getByTestId("import-pdf").click();
  const dialog = page.getByRole("dialog", { name: /^Import (drawings|revision)$/ });
  await dialog.getByRole("button", { name: "Choose PDF…", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Close source panel", exact: true }).click();
}

/** Saved records of one project, read from the closed application's database. */
export interface SeedContext {
  readonly project: Project;
  readonly sheets: ReadonlyArray<Sheet>;
  readonly revisions: ReadonlyArray<Revision>;
  readonly conversations: ReadonlyArray<Conversation>;
  readonly artifacts: ReadonlyArray<Artifact>;
  /** A completed whole-set review in a conversation, with a saved reviewer request. */
  readonly review: (conversation: Conversation, startedAt: number, summary: string) => PacketReview;
}

/** Saved JSON payloads selected by a query, before decoding with their record schema. */
const payloads = (database: DatabaseSync, query: string, ...values: Array<string>) =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload: Schema.String })))(
    database.prepare(query).all(...values),
  ).map((row) => row.payload);

/**
 * Write packet reviews for one project into a closed application's database, with each review's
 * reviewer request and saved answer. Seeded reviews use an engine the service never resumes, so
 * no provider work starts when the application reopens.
 */
export function seedPacketReviews(
  directory: string,
  projectName: string,
  build: (context: SeedContext) => ReadonlyArray<PacketReview>,
) {
  const database = new DatabaseSync(join(directory, "app.sqlite"));

  try {
    const project = payloads(database, "SELECT payload FROM review_projects")
      .map((payload) => Schema.decodeUnknownSync(Schema.fromJsonString(Project))(payload))
      .find((item) => item.name === projectName);

    if (!project) throw new Error(`Missing project ${projectName}`);

    const records = (kind: string) =>
      payloads(
        database,
        "SELECT payload FROM review_records WHERE project_id=? AND kind=? ORDER BY rowid",
        project.id,
        kind,
      );

    const sheets = records("sheet").map((payload) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Sheet))(payload),
    );

    const revisions = records("revision").map((payload) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Revision))(payload),
    );

    const messages: Array<ReviewMessage> = [];

    const context: SeedContext = {
      project,
      sheets,
      revisions,
      conversations: records("conversation").map((payload) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Conversation))(payload),
      ),
      artifacts: records("artifact").map((payload) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Artifact))(payload),
      ),
      review: (conversation, startedAt, summary) => {
        const request = new ReviewMessage({
          id: crypto.randomUUID(),
          projectId: project.id,
          conversationId: conversation.id,
          role: "reviewer",
          text: `Seeded request at ${startedAt}`,
          createdAt: new Date(startedAt).toISOString(),
        });

        messages.push(request);

        return Schema.decodeUnknownSync(PacketReview)({
          id: crypto.randomUUID(),
          projectId: project.id,
          projectName: project.name,
          conversationId: conversation.id,
          requestId: request.id,
          request: request.text,
          scope: PacketScope.cases.WholeSet.make({}),
          model: "muse-spark-1.3",
          provider: "meta",
          state: "completed",
          version: 0,
          startedAt,
          changedAt: startedAt + 1000,
          maxCalls: null,
          admittedCalls: 0,
          promptVersion: "offline-desktop-fixture",
          instructionRevision: "offline-fixture-no-model-call",
          sheets: sheets.map((sheet) => {
            const revision = revisions.find((item) => item.id === sheet.revisionId);

            if (!revision) throw new Error("Missing source revision");

            return {
              id: sheet.id,
              revisionId: sheet.revisionId,
              label: sheet.label,
              pageIndex: sheet.pageIndex,
              box: sheet.box,
              sha256: revision.sha256,
              documentName: revision.name,
            };
          }),
          inspectedSheetIds: [],
          evidenceIds: [],
          projectConfiguration: {},
          coverage: sheets.flatMap((sheet) =>
            ReviewPass.literals.map((pass) => ({
              sheetId: sheet.id,
              pass,
              discipline: "general",
              status: "unreviewed",
              note: "Offline UI fixture; no model inspection is asserted.",
            })),
          ),
          sources: [],
          citations: [],
          calculations: [],
          findings: [],
          priorComments: [],
          summary,
          missingInputs: [],
          error: null,
          finished: true,
        });
      },
    };

    const reviews = build(context);

    for (const review of reviews) {
      database
        .prepare(
          "INSERT INTO packet_reviews (id,project_id,conversation_id,command_id,fingerprint,source_version,owner_generation,journal_id,engine,payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          review.id,
          review.projectId,
          review.conversationId,
          crypto.randomUUID(),
          "offline-ui-fixture",
          project.sourceVersion,
          crypto.randomUUID(),
          crypto.randomUUID(),
          "offline-fixture-never-resumed",
          JSON.stringify(Schema.encodeSync(PacketReview)(review)),
        );

      if (review.summary)
        messages.push(
          new ReviewMessage({
            id: crypto.randomUUID(),
            projectId: project.id,
            conversationId: review.conversationId,
            role: "application",
            text: review.summary,
            createdAt: new Date(review.changedAt).toISOString(),
          }),
        );
    }

    for (const message of messages)
      database
        .prepare("INSERT INTO review_records(project_id,id,kind,payload) VALUES (?,?,?,?)")
        .run(project.id, message.id, "message", JSON.stringify(message));

    return { ...context, reviews };
  } finally {
    database.close();
  }
}

/** Messages saved in the closed application's database with this text. */
export function savedMessages(directory: string, text: string) {
  const database = new DatabaseSync(join(directory, "app.sqlite"));

  try {
    return payloads(
      database,
      "SELECT payload FROM review_records WHERE kind='message' AND json_extract(payload,'$.text')=? ORDER BY rowid",
      text,
    ).map((payload) => Schema.decodeUnknownSync(Schema.fromJsonString(ReviewMessage))(payload));
  } finally {
    database.close();
  }
}

/** A running copy of a seeded review, for flows that only appear while a review is active. */
export const running = (review: PacketReview) =>
  new PacketReview(
    Struct.assign(review, {
      state: "running" as const,
      finished: false,
      activeDurationMs: 0,
      activeSince: review.startedAt,
    }),
  );
