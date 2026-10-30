import { Schema } from "effect";

/** Bounds apply only to display summaries, never the retained technical finding. */
export const findingSummaryLimits = {
  title: { characters: 80, words: 12 },
  sentence: { characters: 320, words: 45 },
} as const;

const actions =
  /^(?:Add|Show|Identify|Reconcile|Provide|Revise|Clarify|Confirm|Replace|Remove|Correct|Update|Label|Dimension|Specify|Complete|Document|Submit|Resolve|Move|Size|Locate|Connect|Include|Separate|Obtain|Restore|Route|Supply|Change|Explain|Verify)\s+\S/i;

const singleLine = Schema.isPattern(/^(?![-*•]\s)(?!\d+[.)]\s)[^\r\n\u2028\u2029]+$/u);

const words = (maximum: number) =>
  Schema.makeFilter<string>(
    (value) =>
      value.split(/\s+/u).length <= maximum ||
      `Use at most ${maximum} words in this summary field.`,
    { toJsonSchema: () => ({ description: `At most ${maximum} whitespace-separated words.` }) },
  );

// Protect decimal values, section/detail numbers and internal engineering units.
// Ambiguous abbreviation boundaries must be spelled out instead of guessed.
const oneSentence = Schema.makeFilter<string>(
  (value) => {
    const text = value
      .replace(/(?<=\d)\.(?=\d)|(?<![\p{L}\p{N}])\.(?=\d)/gu, "_")
      .replace(/\b(?:in|ft|sq|dia|min|max)\.(?=\s+[a-z])/g, "_")
      .replace(/\b(?:No|Fig|Eq)\.(?=\s+\d)/g, "_");

    return (
      /^[^.!?。！？]+[.!?。！？]["'”’)]*$/u.test(text) ||
      "Use exactly one sentence with final punctuation; spell out ambiguous abbreviations."
    );
  },
  { toJsonSchema: () => ({ description: "Exactly one sentence with final punctuation." }) },
);

const sentence = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(findingSummaryLimits.sentence.characters),
  singleLine,
  words(findingSummaryLimits.sentence.words),
  oneSentence,
);

/** Executable short-text contract, shared by auto-presentation and the summary tool. */
export const FindingSummaryText = Schema.Struct({
  title: Schema.Trimmed.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(findingSummaryLimits.title.characters),
    singleLine,
    words(findingSummaryLimits.title.words),
  ),
  observed: sentence,
  correction: sentence.check(
    Schema.makeFilter<string>(
      (value) =>
        (actions.test(value) &&
          !/^(?:Verify compliance|Coordinate as required|Revise accordingly)[.!]?$/i.test(value)) ||
        "Start with a concrete action and its object, such as 'Show the relay wiring.'",
      {
        toJsonSchema: () => ({
          description: "One concrete action and its object; no boilerplate.",
        }),
      },
    ),
  ),
});

/** A summary must name the exact saved finding revision it describes. */
export const RecordFindingSummary = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  revision: Schema.String.check(Schema.isUUID()),
  ...FindingSummaryText.fields,
});

/** Authoritative model-facing instructions are generated from the executable bounds. */
export const findingSummaryInstructions = `Save the complete technical finding with record_finding first. Its existing capacity is unchanged; do not omit facts to fit a summary. The host uses the exact text directly when it already satisfies the short-text contract. Otherwise the result returns a Pending summary with id and revision. Call record_finding_summary for that exact id and revision, using a title of at most ${findingSummaryLimits.title.characters} characters and ${findingSummaryLimits.title.words} words, one observed sentence and one concrete action-led correction sentence, each at most ${findingSummaryLimits.sentence.characters} characters and ${findingSummaryLimits.sentence.words} words. Use single lines and final sentence punctuation; spell out ambiguous abbreviations. Preserve values, conditions and uncertainty needed to act correctly. Full supporting detail remains in the original finding and linked evidence. Summary validation never truncates or rewrites the original. Correct rejected summaries; pending summaries block finish_sheet and finish_review. Updating a technical finding invalidates its old summary.`;
