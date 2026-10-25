---
name: request-progress
description: Group recent conversations into overall requests, review each one's progress from memory, link each to the owner goals it serves, and write the build story, so My Work shows progress meters, shipping velocity and learned working preferences. Use when asked to "group requests", "group by overall request", "review request progress", "refresh progress", "build story", "shipping velocity", or "how do I like to work with agents".
---

# Request Progress

My Work shows one card per **human request**, built from the human's own prompts: a conversation's first substantive ask owns its follow-ups, and agent work, activity and progress sit beneath it, even before any work is recorded. People rarely finish a goal in one conversation, though. They `/clear`, switch worktrees, hand off to Codex, come back the next day. This skill checks each new conversation's opening ask against the open requests in its project to join those conversations into one **overall request**, then reviews each request from memory and writes the build story.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. Every step runs one CLI:

```bash
CLI="bun ${CLAUDE_SKILL_DIR}/scripts/request-groups.mjs"
```

It opens `~/.claude-mem/claude-mem.db` read-only and writes only to `~/.claude-mem/work-view/`. My Work picks up changes within a second: grouped conversations show as one card that starts at the earliest ask, with a progress meter; the request page shows the build story, how released work landed (usage, value, regressions, why each change was made) and its work product; each card shows the owner goal it serves; the build story's first paragraph is My Work's recap, and the story sheet shows shipping velocity, the narrative and preferences. A review never changes a request's recorded status.

Default window: 14 days. Use the window the user asks for.

## 1. Group conversations into overall requests

A human request is the top level of My Work: every conversation's opening ask either starts a request or continues one. Grouping decides **once per conversation**, from its opening substantive ask, and decisions already in the ledger are kept. Requests stay inside one project root (the project key before its first `/`, so worktrees of one repo share requests); a conversation never joins a request from another root, and `apply` refuses one that does.

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
- Every conversation in a group comes from one project root.

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

## 3. Link each request to the goals it serves

Run this yourself after the reviews (it needs the reviews' summaries):

1. Run `$CLI align-input`. It returns the owner's current goals (each with an exact `goal` key, title, product and the owner's own quotes, from the owner-goals list), the request groups still to align (title, first ask, progress state and summary: groups this step has not seen, groups whose request changed since their decision, or every group when the goals changed) and their previous links. If it lists no groups, skip this step: every group is already aligned, or the owner-goals skill has not run and every card keeps "Goal not linked yet".
2. For each listed group, pick the goals it directly advances: usually one, at most three. A request serves a goal when delivering it moves that goal forward. The same product area alone is not enough. Groups that serve no current goal go in `unaligned`. Keep a previous link unless the goals or the request changed.
3. Each link needs `evidence` (≤300 chars): name what in the request advances the goal, quoting the goal's or the request's words.
4. Record it. Every listed group must appear in `links` or `unaligned`; groups it did not list keep their earlier links. The command validates, so fix and retry if it rejects:

```bash
$CLI record-alignment - <<'JSON'
{"links": [{"groupId": "g_…", "goal": "<exact goal key>", "evidence": "…"}], "unaligned": ["g_…"]}
JSON
```

My Work shows the linked goal on each card, "No goal" for an unaligned group, and "Goal not linked yet" for a group this step has not seen.

## 4. Write the build story

Run `$CLI story-input`. Without a previous story it returns every review; with one (`update: true`) it returns only the reviews whose facts (state, percent, dates, milestones, preferences or outcome) changed since that story was written. If it lists no reviews, skip this step: the story still holds. When updating, keep the previous story's chapters and wording where they still hold and change only what the listed reviews move. The updated story must still fit in `narrativeLimit` characters. `previousNarrativeChars` is the previous story's length, and `roomChars` is how many characters you can add. For every character you add beyond `roomChars`, first cut one from the oldest finished chapters: shorten each to a few sentences. Never cut the recap or the chapters the listed reviews change. If a refusal says to cut N characters, cut at least N from those older chapters. Write:

- `narrative` (markdown, ≤12000 chars, blocks separated by blank lines, `## ` headings for chapters): a chronological build story. Lead with a short paragraph on shipping velocity (My Work shows it as the recap), then what was set out, what shipped and when, how long ask-to-ship took, where work stalled or was reworked, and what that teaches. Use only the dated facts in the reviews. Refer to the person as "the owner" or "they"; never guess pronouns.
- `preferences` (≤30): merge the per-request preferences into distinct, actionable statements of how the owner likes to work with agents. `supportCount` is how many requests showed it; keep up to 3 verbatim quotes with dates. Drop one-off remarks.

```bash
$CLI record-story - <<'JSON'
{"narrative": "...", "preferences": [{"preference": "...", "kind": "directive", "supportCount": 3, "quotes": [{"quote": "...", "at": "ISO"}]}]}
JSON
```

Finish by telling the user how many requests were reviewed, how many were linked to goals, the shipping velocity in two sentences, and the five strongest preferences.
