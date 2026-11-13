---
name: review-stage
description: Stage one finished request for the owner's review in a chosen format (brief, one-pager, deck, technical walkthrough, or the owner's own), built around the real evidence of the work. Use when asked to "stage this for review", "make a brief of this request", "make a review deck", "walk me through what was built", or when My Work's Stage button or its opt-in automatic setting starts a stage.
---

# Review Stage

A stage is one staged review of one request in one format. The owner did not watch the work happen; the stage is how they check it. So a stage is built around what really needs reviewing: the screens that changed, the files that were made, the code that moved. A stage that only describes the work in words has failed.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. The request is read with the request-progress CLI:

```bash
CLI="bun ${CLAUDE_SKILL_DIR}/../request-progress/scripts/request-groups.mjs"
```

## 1. Read the request

```bash
$CLI show <groupId> --full
```

It returns the request's title, every conversation's asks in the owner's own words, each conversation's observations, and the last progress review (`previousReview`: its summary, milestones, risk, outcome). `--full` asks for all of them: without it, a request whose review is current shows only what happened after that review, which is usually nothing. The asks say what was wanted. The review says what the reviewer concluded. Neither is evidence of the result.

## 2. Gather the real evidence first

Do this before writing a word of the stage. Open each thing; do not work from its name.

- **Screenshots.** The images attached to the request's observations. Read each one. A UI change is reviewed from its screenshots.
- **Made assets.** The files in the request's deliverables bucket (`~/.claude-mem/deliverables/<project>/`): a deck, a report, a page, an image. Open each one.
- **Code.** Each commit's real diff, from git, when the repository is on this computer: `git -C <checkout> show --stat --patch <sha>`. Read the stat for the shape, then the hunks.
- **Links.** A pull request or published page you can open, open. One you cannot open is a link, not evidence.

When the worker starts this skill it has already done steps 1 and 2: it names a file holding the `show` output and an evidence list, where every entry has an id (`E1`, `E2`, …), a kind, a title and the file to open. An entry with no file was not opened, and its note says why.

## 3. Build the stage around the evidence

Follow the format's instructions for length and shape. Whatever the format:

- **Show the evidence as itself.** A UI change shows the actual screenshots. A made asset is shown as itself: an image is shown, a document is quoted from. A code change shows the real diff's shape: which files, how many lines, and the hunks that carry the risk, quoted exactly.
- **Never describe evidence you did not open.** No "the screenshot shows" for an image you did not read, no "the diff adds" for a commit you could not find. What you could not open goes under a plain heading such as "Not opened", by name.
- **Say plainly when there is nothing visual to show.** If the request has no screenshots and no made assets, the stage says so in its first lines, and then reviews what does exist (the diff, the recorded observations). Do not fill the gap with illustration.
- **Quote the owner.** State the ask in the owner's own words, word for word, before saying what was made.
- **Separate what is proven from what is claimed.** "The diff adds the route and its test" is proven by the diff. "It works" is a claim unless the evidence shows it running.
- **End with what the owner must decide or check**, each as one question.

To place a piece of evidence, point at it by id and the worker puts the real file there:

- Markdown: `![what it shows](evidence:E3)`
- HTML: `<img src="evidence:E3" alt="what it shows">`

Only an image can be placed. Quote a diff as text. Pointing at an id that is not in the list, or placing something that is not an image in an HTML stage, refuses the whole stage.

**Language.** Write the stage in the human language most of the owner's asks are written in. Quotes stay as typed.

## 4. Output

Reply with the stage itself and nothing else: Markdown for a `markdown` format, one complete self-contained HTML document (inline CSS and JavaScript, nothing loaded from the network) for an `html` format. No JSON, no code fence around the whole reply.

The worker writes it as one file in the request's deliverables bucket and records it on the ledger under the request and the format: `generating`, then `ready` or `failed` with the reason. Only the worker records a stage. Run by hand in a session of your own, this skill ends at the document: show it to the owner, and start the recorded stage from the request in My Work.

One stage is one run. If it fails, the failure is shown and nothing tries again until the owner asks.

## Formats

The built-in formats are `brief`, `one-pager`, `deck` (HTML) and `technical`. The owner adds their own by putting a Markdown file in `~/.claude-mem/stage-formats/`: the file name is the format's id (lowercase letters, digits, dashes), and the file holds front matter and the instructions.

```markdown
---
name: Release note
output: markdown
---
Write it as a release note for customers: what is new, in two short paragraphs, then one screenshot.
```

`output` is `markdown` or `html`. A file named like a built-in replaces it.
