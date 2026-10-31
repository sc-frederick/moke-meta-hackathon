import { Schema } from "effect";
import type { Revision, RevisionCorrespondence } from "./contracts.ts";
import type { PacketReview, StartPacketReview } from "./packet.ts";

/**
 * The preset first-submittal request sent by the Initial Review button. The text is part of the
 * identity: change it only with a new version so recorded runs stay comparable. It names no
 * project, date or count, so every project sends the same bytes and the request stays cacheable;
 * project facts come from tools and the setup record.
 */
export const initialReview = {
  id: "initial-review-v1",
  text: [
    "Run the initial QA review of the whole drawing set for this first submittal.",
    "1. Project facts first. Before reviewing sheets, record the project configuration from the cover, code-analysis and life-safety sheets: jurisdiction, adopted code editions and local amendments, occupancy and use, construction type, sprinkler status, building and story areas, height, and electrical service size. Record a fact the drawings do not state as Needs input instead of assuming it.",
    "2. Every sheet. Open each sheet in the inventory and check it for completeness (title block, sheet index, scale, revision and date, legible notes, resolved sheet and detail references) and for the requirements of each discipline that applies to it. Record every pass and discipline in coverage, with the reason for each Not applicable. This is a first submittal, so the prior-comment pass is Not applicable unless the set includes jurisdiction comments.",
    "3. Cross-sheet coordination last. After the sheets are reviewed, compare facts that repeat across sheets, such as areas, occupant loads, electrical service and loads, equipment tags and ratings, fire protection responsibilities and referenced details, and record each conflict with its location on both sheets.",
    "Rank findings by severity, Critical first. For each finding, state what the drawings show, what governs, and the specific correction. State uncertainty explicitly: an item you cannot confirm from the drawings or the governing text stays Needs input, with the missing source named. Do not mark a sheet or pass reviewed without inspecting it. End with a short summary of the most serious items and what the design team needs to provide.",
  ].join("\n\n"),
} as const;

/**
 * The fixed settings the Initial Review button sends with its saved message. There is no sheet
 * selection: the first set can span several PDFs, and every one of its sheets is in scope. The
 * composer's model, scope and optional call budget do not apply.
 */
export const initialReviewRequest = {
  model: "muse-spark-1.3",
  discipline: "auto",
  maxCalls: null,
  preset: initialReview.id,
} as const satisfies Pick<
  typeof StartPacketReview.Type,
  "model" | "discipline" | "maxCalls" | "preset"
>;

/** Recorded with a review started from a preset, beside its prompt version and instruction revision. */
export const ReviewPreset = Schema.Literal(initialReview.id);

/**
 * The initial review phase lasts while the project holds only its first drawing set. Each PDF
 * import is a Revision, and a first set can span several PDFs, so a later import alone does not
 * end the phase. A revised set is a PDF linked to earlier sheets through RevisionCorrespondence,
 * or one imported after the project's first drawing-set review started.
 */
export function inInitialReviewPhase(project: {
  readonly revisions: ReadonlyArray<Pick<Revision, "importedAt">>;
  readonly correspondence: ReadonlyArray<Pick<RevisionCorrespondence, "revisionId">>;
  readonly reviews: ReadonlyArray<Pick<PacketReview, "startedAt">>;
}) {
  if (project.revisions.length === 0 || project.correspondence.length > 0) return false;

  const firstReview = Math.min(...project.reviews.map((review) => review.startedAt));

  return project.revisions.every((revision) => Date.parse(revision.importedAt) <= firstReview);
}
