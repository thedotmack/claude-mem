---
name: request-progress
description: Group recent conversations into overall requests, review each one's progress from memory, sort each into one of the owner's focus areas, and write the build story, so My Work shows progress meters, shipping velocity and learned working preferences. Use when asked to "group requests", "group by overall request", "review request progress", "refresh progress", "build story", "shipping velocity", or "how do I like to work with agents".
---

# Request Progress

My Work shows one card per **human request**, built from the human's own prompts: a conversation's first substantive ask owns its follow-ups, and agent work, activity and progress sit beneath it, even before any work is recorded. People rarely finish a goal in one conversation, though. They `/clear`, switch worktrees, hand off to Codex, come back the next day. This skill checks each new conversation's opening ask against the open requests in its project to join those conversations into one **overall request**, then reviews each request from memory and writes the build story.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. Every step runs one CLI:

```bash
CLI="bun ${CLAUDE_SKILL_DIR}/scripts/request-groups.mjs"
```

It opens `~/.claude-mem/claude-mem.db` read-only and writes only to `~/.claude-mem/work-view/`, except `record-focus`, which saves through the running claude-mem worker because focus areas sync between computers. My Work picks up changes within a second: grouped conversations show as one card that starts at the earliest ask, with a progress meter; the request page shows the build story, how released work landed (usage, value, regressions, why each change was made) and its work product; each card shows the focus area it sits in; the build story's first paragraph is My Work's recap, and the story sheet shows shipping velocity, the narrative and preferences. A review never changes a request's recorded status.

Default window: 14 days. Use the window the user asks for.

## 1. Group conversations into overall requests

A human request is the top level of My Work: every conversation's opening ask either starts a request or continues one. Grouping decides **once per conversation**, from its opening substantive ask, and decisions already in the ledger are kept. Requests stay inside one project root (the project key before its first `/`, so worktrees of one repo share requests): `apply` refuses a group whose conversations come from different roots unless the decision names the request's `projectRoot`, in which case every conversation it lists joins that request and the request records that root.

Before any batch reaches you, the worker's judge files each new conversation on its own (`$CLI judge --days 14` shows what it would do; `--apply` writes it). A code link (the conversation wrote to the same work-state list, or recorded the same `request_id`, as one open request) joins at once. On a CMEM Pro or OpenRouter install, Jev then checks the opening ask against the root's open requests: a check score of 0.8 or more joins the request (a `judge` link whose evidence names the judge and its score, and the request records its root), 0.5 to 0.8 makes the conversation its own request with a suggestion the owner accepts or declines on its card in My Work ("Looks like part of …"), and below 0.5 it starts its own request. Only conversations the judge could not place (no code link and no Jev, or a refused or failed call) come to `grouping-input`.

```bash
$CLI grouping-input --days 14
```

It returns one batch: up to 20 conversations the ledger has not decided yet, earliest first, all from one project `root`, each with its `openingAsk` and work lists; that root's `openRequests` (title, `anchor` conversation, `anchorAsk`, `recentAsks`; shipped and abandoned requests are left out); and `proposedLinks`, conversations code already linked because they wrote to the same work-state list or recorded the same `request_id` (keep these unless the list is obviously a generic bucket). `remaining` counts the undecided conversations left for later batches. Apply each batch, then run `grouping-input` again until `conversations` is empty.

Decide every conversation in the batch:

- **continue**: it serves one of the `openRequests` (or another conversation in the same batch).
- **new**: it starts its own overall request (a group of one).
- **ignore**: it is not a human goal (an automated naming prompt, a bot kickoff, a pasted transcript with no ask).

Evidence for **continue**, strongest first:

1. The ask refers back to earlier work: "this is excellent work, can you now …", "continue the X", a PR or branch name, a pasted handoff.
2. The same named artifact (feature, page, skill, release, bug) appears in both asks within a few days.
3. Memory confirms it: `mem_search` for the artifact finds observations from both conversations describing the same change.

Similar wording alone is not evidence, and neither is sharing a repo. When unsure, make it **new**: a wrongly merged card hides work, a split card only shows up twice. To continue an open request, list its `anchor` first, then the new conversations, keep its title, and add a link with the evidence. List only conversations from the batch (and an open request's anchor first).

Apply the decisions:

```bash
$CLI apply - <<'JSON'
{
  "groups": [
    {
      "title": "Live My Work request cards",
      "conversations": ["[\"conversation\",\"claude\",\"<earliest>\"]", "[\"conversation\",\"codex\",\"<later>\"]"],
      "links": [{ "kind": "agent-judgment", "conversations": ["…", "…"], "evidence": "Oct 16 ask: \"this is excellent work, can you now add request cards\" continues the Oct 15 build" }]
    },
    { "title": "Pricing page copy", "conversations": ["[\"conversation\",\"claude\",\"<id>\"]"] }
  ],
  "ignored": [{ "conversation": "[\"conversation\",\"codex\",\"<id>\"]", "reason": "Automated workspace naming prompt" }]
}
JSON
```

The command fails fast; fix the input and rerun. Its rules:

- List `conversations` **earliest first**. The first one anchors the group id, so reviews survive later merges.
- A group of more than one conversation needs at least one link (`shared-work-list`, `shared-request-id` or `agent-judgment`) with evidence text. Quote the human's words where you can.
- `title` is the goal in plain words (≤120 chars), not the process.
- Every conversation in a group comes from one project root, unless the group gives an explicit `projectRoot` (a root as `grouping-input` reports it), which lets conversations from other roots join and is recorded on the request.

Then run `$CLI pending --days 14 --limit 48`. `ungroupedConversations` should be 0; `groups` lists the overall requests due for a review (new, or active since their last review).

## 2. Review each due request from memory

Split the due groups into batches of about 8 and give each batch to a subagent, in parallel, with this task (fill in the CLI path and groups):

> Review the progress of these overall requests from claude-mem memory. For EACH groupId:
>
> 1. Run `<CLI> show <groupId>` for its conversations, every human ask in full (with prompt ids and times), each conversation's own observations (id, time, type, title), work lists, dates, any previous review and a `reviewBasis`. When `mode` is `"amend"`, the group has the same conversations as its `previousReview`, and `asks` holds only the asks after `amendSince`: start from `previousReview`, search memory only for what happened after `amendSince`, and change only what that new evidence moves (state, percent, dates, summary, new milestones, outcome, preferences). Keep the rest of the previous review as it is. When `mode` is `"full"` (no previous review, or the conversations changed), review from scratch.
> 2. Search memory (`mem_search`, `timeline`, `get_observations`) for the outcome: merged PRs, releases, deploys, work-state items marked done, the owner confirming or rejecting the result, or work that stopped. Search for the named artifacts in the asks, not generic words. Fetch the observations you rely on.
> 3. Decide from the evidence only:
>    - `state`: `shipped` (merged and released or deployed, or the owner confirmed it done) | `in-progress` | `stalled` (no activity for 3+ days and not finished) | `abandoned` (explicitly dropped or replaced) | `unknown` (memory has too little).
>    - `percent`: 0 not started · 10–30 exploring or planning · 40–70 building · 80–95 in review, PR open or awaiting release · 100 shipped only.
>    - `startedAt` (earliest ask), `shippedAt` (only when shipped), `lastActivityAt`, as ISO dates.
>    - `summary` (≤280 chars, what it delivers for the person), `narrative` (≤1200 chars: how the build went, including turns, rework and lessons), `milestones` (≤12, dated, each `text` ≤200 chars, each citing observation ids or PR numbers in `evidence`).
>    - `outcome`, for any request that shipped or released something (omit it otherwise). Research it, then answer from evidence only; "no-evidence" and "unclear" are honest answers:
>      - `landed`: `{text, at, evidence}` where and how it shipped: merged PR, release version, deploy, published page.
>      - `usage`: `{level: in-use | some-use | no-evidence | unknown, text, evidence}`. Look for the owner or users coming back to it in later asks, observations of it running, analytics or logs the agents checked, issues filed against it.
>      - `value`: `{level: high | medium | low | unclear, text, evidence}` for us: did later work build on it, did the owner praise, rely on or replace it, did it remove a cost or a chore.
>      - `regressions` (≤10): `{text, at, fixedBy, evidence}` for anything it broke: later fix PRs or commits that name it, reverts, bug reports, the owner's corrections. `fixedBy` is null while unfixed.
>      - `changes` (≤12): `{what, why, at, evidence}` for each meaningful change, with the WHY from the owner's own ask (quote it), the commit or PR message, or the incident that caused it. Never write a why you cannot cite.
>    - `preferences` (≤10): how the owner likes to work with agents, taken ONLY from the owner's own asks shown by `show`. Each has `preference` (≤200 chars, the statement), `quote` (verbatim, ≤300 chars), `kind` and `at`. `quote` is verbatim; `kind` is `directive` | `correction` | `praise` | `frustration`. Skip pasted agent text, secrets, keys and tokens.
> 4. Record it: `<CLI> record-progress - <<'JSON' {...} JSON` with `groupId`, `state`, `percent`, the dates, `summary`, `narrative`, `milestones`, `outcome`, `preferences`, `evidence` and `reviewBasis` copied verbatim from that group's `show` output (it marks which conversations and activity you reviewed). Pass the JSON through the heredoc; never write review files to disk, because other reviewers run at the same time. Fix and retry if it rejects. A subtask finishing does not mean the request shipped.
>
> Return the groups you recorded and any you could not, with the reason.

## 3. Sort each request into a focus area

A **focus area** is a part of the owner's work you could ask for things inside of. Every request sits in exactly one area, or in **Other** when it fits none. Run this yourself after the reviews. Areas are only ever proposed: the owner keeps, renames, merges or dismisses them.

1. Run `$CLI focus-input`. It returns:
   - `areas`: the owner's kept and suggested focus areas (`focusAreaId`, `name`, `goal`, `about`).
   - `dismissed`: areas the owner dismissed. They take no requests and are never proposed again, under any name.
   - `requests`: one batch of up to 20 requests to place now (new, changed since they were placed, or whose area is gone). Each has its `anchor`, title, first ask, progress state and summary, `repo`, how many `conversations` it holds and each conversation's opening ask (`conversationAsks`). A request may also carry `judgeSuggestion` (`focusAreaId`, `confidence`, `evidence`): Jev's pick among the kept areas, which is only a suggestion; you decide the placement from the request and the areas.
   - `remaining`: requests left for later batches.

   If `requests` is empty, go to step 3. A request the owner moved stays where they put it and is never listed.
2. Place every listed request exactly once, by the exact `focusAreaId` of the area you could ask for it inside of (read the area's goal and about), or `"other"` when no area fits. Sharing a repo is not evidence. Never invent an id. Each placement needs `evidence` (≤300 chars) quoting the request's or the area's words. If a request's conversations hold several separate asks (read `conversationAsks`), it is really an area: you may also **promote** it with a `promote` proposal holding that one request. Record the batch, then run `focus-input` again until `requests` is empty:

```bash
$CLI record-focus - <<'JSON'
{"placements": [{"anchor": "<anchor>", "focusAreaId": "fa_…", "evidence": "…"}, {"anchor": "<anchor>", "focusAreaId": "other", "evidence": "…"}],
 "proposals": [{"kind": "promote", "name": "…", "goal": "…", "about": "…", "anchors": ["<anchor>"], "sameAs": null, "evidence": "…"}]}
JSON
```

3. Run `$CLI focus-input --other`. It lists the requests the router put in Other (`other`, not the ones the owner put there) and `due`. If `due` is false, skip this step: these requests were already looked at. Otherwise propose areas from them, placing nothing:
   - `new`: ask of each Other request whether it is **one step of a larger effort rather than a complete ask that stands on its own**. Two or more requests that are steps of the same larger effort become one proposed area.
   - `promote`: one request whose conversations hold several separate asks.

   Propose nothing when nothing qualifies, and still record the empty answer so the pass is not repeated:

```bash
$CLI record-focus --other - <<'JSON'
{"placements": [], "proposals": [{"kind": "new", "name": "…", "goal": "…", "about": "…", "anchors": ["<anchor>", "<anchor>"], "sameAs": null, "evidence": "…"}]}
JSON
```

Every proposal has `kind`, `name` (a short label, ≤80 chars, that must never reuse a nav label as whole words, in any case: My Focus, My Work, My Rules, Other, Suggested, Past focus, Monitor, Steer ("Work viewer" is fine, "Other tools" is not). claude-mem refuses such a name and the save fails), `goal` (one sentence, ≤300 chars: what the area is for), `about` (≤300 chars: what belongs in it), `anchors` (the requests it holds), `evidence` (≤300 chars, quoting the asks) and `sameAs`: the id of the area in `areas` or `dismissed` that this proposal already is, else `null`. A proposal that is an area in `areas` adds no area: its requests are placed in that area. One that is a dismissed area is refused for good. `record-focus` validates and saves through the claude-mem worker, so fix and retry if it rejects.

My Work shows each request's area, Other, or "Sorting…" until this step places it. Proposed areas wait under Suggested for the owner.

## 4. Write the build story

Run `$CLI story-input`. Without a previous story it returns every review; with one (`update: true`) it returns only the reviews whose facts (state, percent, dates, milestones, preferences or outcome) changed since that story was written. If it lists no reviews, skip this step: the story still holds. Aim for about `narrativeTarget` characters. `narrativeLimit` is a hard cap: a longer story is refused. When updating, `previousParts` lists the previous story's recap and chapters, each with its length in characters and words (`chars`, `words`), a budget counted for you (`budgetChars`, `budgetWords`) and how far it is over that budget (`overBudgetChars`).

- When `condenseChars` is 0, keep the previous story's chapters and wording where they still hold, change only what the listed reviews move, and add at most `roomChars` characters. If the new facts need more room, condense the parts furthest over their budget.
- When `condenseChars` is above 0, the previous story is past the target. Rewrite every part whose `overBudgetChars` is above 0 in at most its `budgetWords` words, the recap and the chapters the listed reviews change included. Keep each chapter's dates, ids and outcomes, fit the listed reviews' new facts into those budgets, and merge finished chapters into one where that reads better. Count the words of each rewritten part before you answer.
- When `mergeOldestChapters` is above 0, the story has more chapters than the budgets fit: merge that many of the oldest chapters into one chapter within its budget first, keeping their dates, ids and outcomes, then follow the rules above.
- If a refusal names parts with their budgets, rewrite each of those parts within its budget, and condense any other part it says is over budget too. If it names the oldest chapters to merge, merge them into one first.

Write:

- `narrative` (markdown, about 8000 chars and never over 12000, blocks separated by blank lines, `## ` headings for chapters): a chronological build story. Lead with a short paragraph on shipping velocity (My Work shows it as the recap), then what was set out, what shipped and when, how long ask-to-ship took, where work stalled or was reworked, and what that teaches. Use only the dated facts in the reviews. Refer to the person as "the owner" or "they"; never guess pronouns.
- `preferences` (≤30): merge the per-request preferences into distinct, actionable statements of how the owner likes to work with agents. `supportCount` is how many requests showed it; keep up to 3 verbatim quotes with dates. Drop one-off remarks.

```bash
$CLI record-story - <<'JSON'
{"narrative": "...", "preferences": [{"preference": "...", "kind": "directive", "supportCount": 3, "quotes": [{"quote": "...", "at": "ISO"}]}]}
JSON
```

Finish by telling the user how many requests were reviewed, how many were placed in focus areas and which areas were proposed, the shipping velocity in two sentences, and the five strongest preferences.
