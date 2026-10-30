# Florida code index

Moke's `search_code` tool searches this index for the code section, statute or
rule behind a review check. Each entry gives the section number and title, a
one-line plan review note and a link. The index contains no copied code text.

`assets/FBC_2023_plan_review_reference.md` is the owner's plan review reference
for the 2023 Florida Building Code, 8th Edition, last modified 2026-07-09. It
predates the hackathon and is vendored unmodified; the formatter ignores it.
`assets/florida-code-additions.md` was written for this entry on 2026-10-30. It
adds Florida Statutes, Florida Administrative Code rules, the Florida Fire
Prevention Code adoption, the 9th Edition (2026) volumes and the 8th Edition
supplements. `provenance.json` records both files' origin and SHA-256.

## Reading the governing text

Each entry's `access` says how a reviewer reads the text it points to.

- `open_in_browser`: ICC Digital Codes blocks automated clients, and its
  [website user agreement](https://iccsafe.org/website-user-agreement/) does
  not license robots or data extraction tools. Florida rules publish their text
  as Word documents. Moke records these citations as unverified with the
  section and link, and the engineer opens the link to confirm them.
- `read_source`: Florida Statutes pages on leg.state.fl.us return their
  official text, so `read_source` can retrieve them and a citation can be
  verified against the quote.

`read_source` also extracts embedded text from PDF sources, such as county
amendments and agency checklists, through the PDF worker. A `#page=N` fragment
starts at that page. Scanned PDFs without embedded text stay unavailable.

## Changing the index

Both files use the same format: `## Document - Edition`, `### Topic`, then one
line per entry:

```text
- **1004 Occupant Load** - What the reviewer checks. [Link](https://...)
```

Add entries to the additions file, or replace the reference with a newer copy
of the owner's file. Then update the SHA-256 values in `provenance.json` and
change its `version`. The version is part of the cloud worker identity, so a
changed index needs a rebuilt cloud worker image. `tests/smoke/code-index.test.ts`
checks the hashes, parsing, link access and search ranking.
