# Hackathon product audit

Checked 2026-10-30 against `main` at `9bf12bda1`, after PRs #15 and #16 merged.
Sol, gpt-6.1-sol on xhigh, audited the same code and data independently and
then checked this document's claims. Its corrections are included below.

Evidence comes from 15 recorded reviews in five app databases, copied and read
without changes:

- the Audit 3 recheck workspace from October 29, 11 reviews;
- the fast initial review runs from October 30, four reviews of the brewery and
  civil sets, on this computer and in the cloud.

## Where things stand

Since this audit, PR #17 added reviewer decisions on findings, a firm checklist
and jurisdiction leads, and PR #20 added the Florida code index, code search and
PDF source text. The gaps below describe main before those PRs.

Moke is a strong drawing coordination checker built on solid infrastructure. It
does not yet check drawings against requirements, and it does not yet track
its own findings from one revision to the next. Those are the two things the
product is supposed to be about.

The speed problem is mostly solved. On October 30 the 29-sheet brewery set
finished in about 15 minutes for about $11, and the 5-sheet civil set in 6 to 7
minutes. Over 90% of prompt tokens came from the cache.

The strongest impact evidence is a real permit. The owner ran the same Moke
review instructions by hand in Codex for about two weeks of internal revisions
on a 13,000 square foot custom home worth several million dollars. The county
returned 3 comments after one day, where a job like that typically goes through
3 or more rounds of county revisions, and approved the permit one week after
submittal. This is one project, reported by the owner, using the method that
predates the event rather than the Moke application.

The biggest risk to the submission is the video. Raw full-screen recordings of
the four October 30 runs exist, but there is no script, edit or voiceover yet.

## Scorecard

| Criterion           | Weight | Standing                      | Why                                                                                                                                                        | What would move it                                                                                      |
| ------------------- | -----: | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Impact              |    30% | Adequate, close to strong     | The problem is real and expensive, and one real permit came back with 3 comments after a day. The app's own findings have not been checked for accuracy.   | Show the permit dates and comment letter, check a sample of findings, and show one requirements example |
| Meta tooling        |    25% | Strong                        | Muse Spark 1.3 and Muse Spark Open both run full reviews. The model chooses which sheets to open, what to zoom into, what to calculate and what to search. | Show SAM doing useful work once, or say plainly that the review does not need it                        |
| Technical execution |    20% | Strong                        | Durable runs, recovery, offline reports, local and cloud execution, and passing CI on Windows, macOS and Linux.                                            | Little; protect stability through the freeze                                                            |
| Demo                |    25% | Weak today                    | Good raw footage and a polished workbench. No finished video.                                                                                              | A narrated three-minute cut with one clear engineering outcome                                          |
| Eligibility         |   Gate | Pass once the video is posted | The repository is public and identifies the work built during the event. You are the only Git author.                                                      | Post the video, list contributors on the form, and use a drawing set you are allowed to show publicly   |

The Meta tooling and execution scores do not depend on the new features. Impact
and demo do.

## Submission requirements

| Requirement                            | Status                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Deadline                               | November 4, 9 PM Eastern                                                                        |
| Public repository                      | Done                                                                                            |
| Work built during the event identified | Done in the README                                                                              |
| Meta models used                       | Done: Muse Spark 1.3, Muse Spark Open on Baseten, and SAM 3.1 in the count check                |
| Three-minute video                     | Raw footage only                                                                                |
| Contributors listed                    | Fill in on the submission form                                                                  |
| Shareable sample drawings              | Only the authored lighting schematic. The sanitized client sets are not cleared for public use. |
| Installer for judges                   | No GitHub release yet. CI builds all three platforms.                                           |

## Requirements review

Moke is asked to check code, jurisdiction and firm requirements, but in
practice it does not verify any of them.

- **No verified citations.** None of the 15 recorded reviews contains a
  verified citation. The four October 30 runs recorded 226 findings and no
  citations at all. Their 13 findings labeled Code all remain Needs input.
- **The code text is out of reach.** Every code source the model tried was
  unavailable: ICC's Florida codes, Municode, and the Pasco County land
  development code page. The only pages it could read were the Florida Building
  Commission's list of links and the State Fire Marshal's code page.
  `read_source` also rejects remote PDFs.
- **Code claims slip through as drawing conflicts.** The host requires a
  verified citation only for findings labeled Code, Permit condition or Agency
  request, at `backend/packet-review/service.ts:1137`. In the October 30 brewery
  run, 24 confirmed findings labeled Drawing conflict or Recommendation cite
  NEC, FBC or NFPA without a citation. One says a note on E-1 references the
  wrong NEC table. Sol found this; the first version of this audit missed it.
- **There is no place for supplied requirements.** A reviewer can import a
  jurisdiction checklist or firm standard as a PDF, but Moke treats its pages as
  drawing sheets. It cannot read them as governing text or cite them.
- **Firm standards are not supported.** The firm memory plan, uncommitted on
  branch `research/aec-firm-memory-system`, recommends waiting on the full memory system
  and starting with a firm checklist and a per-jurisdiction requirements record.
- **The instructions are written for Florida only.**

### Built on October 30

Branch `feat/florida-code-index` addresses the access problem:

- **Code search.** A new `search_code` tool searches a Florida code index of 307
  entries: the owner's 2023 FBC plan review reference, plus Florida Statutes,
  Florida Administrative Code rules, the Fire Prevention Code adoption and the
  9th Edition volumes. A citation names an index entry, and the host attaches
  the section's link to the citation, the review panel and the HTML report.
- **PDF text.** `read_source` now extracts embedded text from PDFs, starting at
  a `#page=N` fragment. A live check read pages 2 to 17 of an 85-page Florida
  Building Commission PDF.
- **Readable statutes.** Statute links resolve to the Florida Legislature's
  official text, which `read_source` can retrieve and verify against.
  `flrules.org` replaces a misspelled domain in the official-source list.
- **Still unverified:** ICC section text, which the engineer opens from the
  citation's link, and Florida rule text, which is published only as Word
  documents. Sol's labeling gap above is not fixed yet.

## Revisions

The count check handles revisions properly: the engineer confirms which new
sheet replaces which old one, and affected results are rechecked with history
kept. The main packet review does not use any of that.

- Packet review counts a sheet as unchanged only when it comes from the same PDF
  file, at `src/lib/review/packet-coverage.ts:35`. Any revised PDF makes every
  sheet count as new.
- In the civil Rev 2 follow-up, review `29364835`, all 7 findings carried over
  from Rev 1. Six still point at Rev 1 sheets, and one refers to sheet C-4,
  which Rev 2 removed. The review had four confirmed unchanged sheet links and
  used none of them.
- A finding is either Confirmed or Needs input. There is no way to record that
  a revision fixed it, partly fixed it or left it open.
- The engineer cannot mark a finding as wrong. The only control is the
  Completed checkbox, which means the drafter made the correction.
- Closure does exist for earlier agency comments, gated on inspecting the
  revised sheet. No recorded review has used it.
- A reissue of 3 sheets cannot be reviewed together with the 26 unchanged
  sheets from the earlier set.

## What remains

Ranked by effect on the score. Sol's effort estimates add up to more than the
four working days left, so the order matters.

1. **Video.** Script it around one engineering outcome, cut the existing
   footage, record the final build, add the voiceover and captions, and post it.
   About 1 to 1.5 days. This gates eligibility.
2. **Check 10 to 20 findings by hand.** Mark each as correct, wrong or
   overstated against the drawings. This gives the impact claim a real number.
   About half a day of engineering time, and it can run in parallel with the
   build work.
3. **Finish the requirements path.** The code index and PDF text are built.
   Still to do: a "confirmed by engineer" step for ICC citations, a citation
   requirement for any confirmed finding that names a code section, and the
   firm checklist from `Discipline_Review_Checklists.md`. Then run one real
   review to measure how many citations it records. About half a day to a day.
4. **Revision closure.** Pass the confirmed sheet links into packet review.
   Each open finding from the earlier review is checked on its replacement
   sheet and marked fixed, partly fixed, still open or no longer applicable.
   Add a way for the engineer to mark a finding as wrong and say why. The report
   then reads like "Rev 1 had 7 issues; Rev 2 fixed 4." About 1 to 1.5 days.
5. **Judge package.** Publish a release build with a shareable sample set, and
   reuse the video for the open-weight, agentic, viral and community bonuses.
   A few hours.

Freeze the build early enough to record the version you submit.

## Decisions needed

- Which of items 3 and 4 to build, or both with a hard freeze date.
- Which drawing set can appear in the public video and repository.
- Who scripts and voices the video, and the date for the final recording.
- Whether you will check the 10 to 20 findings yourself.
