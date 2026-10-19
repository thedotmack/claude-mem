---
name: request-progress
description: Group recent conversations into overall requests, review each one's progress from memory, and write the build story, so My Work shows progress meters, shipping velocity and learned working preferences. Use when asked to "group requests", "group by overall request", "review request progress", "refresh progress", "build story", "shipping velocity", or "how do I like to work with agents".
---

# Request Progress

My Work groups records by **conversation**: one session's first substantive ask owns its follow-ups and agent work. People rarely finish a goal in one conversation, though. They `/clear`, switch worktrees, hand off to Codex, come back the next day. This skill works backwards from recorded work to join those conversations into one **overall request**, then reviews each request from memory and writes the build story.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. Every step runs one CLI:

```bash
CLI="bun ${CLAUDE_SKILL_DIR}/scripts/request-groups.mjs"
```

It opens `~/.claude-mem/claude-mem.db` read-only and writes only to `~/.claude-mem/work-view/`. My Work picks up changes within a second: grouped conversations show as one card that starts at the earliest ask, with a progress meter; the request page shows the build story; the **Story** view shows shipping velocity, the narrative and preferences. A review never changes a request's recorded status.

Default window: 14 days. Use the window the user asks for.

## 1. Group conversations into overall requests

```bash
$CLI candidates --days 14 --brief
# narrow a large window one project root at a time:
$CLI candidates --days 14 --brief --project <root>
```

Each candidate is a conversation with a substantive human ask. The output includes:

- `proposedGroups`: conversations already linked by code, because they wrote to the same work-state list or recorded the same `request_id`. Keep these unless the list is obviously a generic bucket.
- `skippedLists`: lists touched by too many conversations to count as proof.
- `currentGroup`: the group a conversation already belongs to. Do not reshuffle settled groups without new evidence.

For every conversation without a deterministic link, decide:

- **continue**: it serves an existing overall request.
- **new**: it starts its own overall request (a group of one).
- **ignore**: it is not a human goal (an automated naming prompt, a bot kickoff, a pasted transcript with no ask).

Evidence for **continue**, strongest first:

1. The ask refers back to earlier work: "this is excellent work, can you now …", "continue the X", a PR or branch name, a pasted handoff.
2. The same named artifact (feature, page, skill, release, bug) appears in both asks, in the same project root, within a few days.
3. Memory confirms it: `mem_search` for the artifact finds observations from both conversations describing the same change.

Similar wording alone is not evidence, and neither is sharing a repo. When unsure, make it **new**: a wrongly merged card hides work, a split card only shows up twice. Link across projects only on evidence 1 or 3.

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

Then run `$CLI pending --days 14 --limit 48`. `ungroupedConversations` should be 0; `groups` lists the overall requests due for a review (new, or active since their last review).

## 2. Review each due request from memory

Split the due groups into batches of about 8 and give each batch to a subagent, in parallel, with this task (fill in the CLI path and groups):

> Review the progress of these overall requests from claude-mem memory. For EACH groupId:
>
> 1. Run `<CLI> show <groupId>` for its conversations, every human ask with times, work lists, dates and any previous review.
> 2. Search memory (`mem_search`, `timeline`, `get_observations`) for the outcome: merged PRs, releases, deploys, work-state items marked done, the owner confirming or rejecting the result, or work that stopped. Search for the named artifacts in the asks, not generic words. Fetch the observations you rely on.
> 3. Decide from the evidence only:
>    - `state`: `shipped` (merged and released or deployed, or the owner confirmed it done) | `in-progress` | `stalled` (no activity for 3+ days and not finished) | `abandoned` (explicitly dropped or replaced) | `unknown` (memory has too little).
>    - `percent`: 0 not started · 10–30 exploring or planning · 40–70 building · 80–95 in review, PR open or awaiting release · 100 shipped only.
>    - `startedAt` (earliest ask), `shippedAt` (only when shipped), `lastActivityAt`, as ISO dates.
>    - `summary` (≤280 chars, what it delivers for the person), `narrative` (≤1200 chars: how the build went, including turns, rework and lessons), `milestones` (≤12, dated, each citing observation ids or PR numbers in `evidence`).
>    - `preferences` (≤10): how the owner likes to work with agents, taken ONLY from the owner's own asks shown by `show`. `quote` is verbatim; `kind` is `directive` | `correction` | `praise` | `frustration`. Skip pasted agent text, secrets, keys and tokens.
> 4. Record it: `<CLI> record-progress - <<'JSON' {...} JSON` with `groupId`, `state`, `percent`, the dates, `summary`, `narrative`, `milestones`, `preferences` and `evidence`. Fix and retry if it rejects. A subtask finishing does not mean the request shipped.
>
> Return the groups you recorded and any you could not, with the reason.

## 3. Write the build story

Run `$CLI story-input`. It returns every review and the previous story. Write:

- `narrative` (markdown, ≤12000 chars, blocks separated by blank lines, `## ` headings for chapters): a chronological build story. Lead with a short paragraph on shipping velocity, then what was set out, what shipped and when, how long ask-to-ship took, where work stalled or was reworked, and what that teaches. Use only the dated facts in the reviews. Refer to the person as "the owner" or "they"; never guess pronouns.
- `preferences` (≤30): merge the per-request preferences into distinct, actionable statements of how the owner likes to work with agents. `supportCount` is how many requests showed it; keep up to 3 verbatim quotes with dates. Drop one-off remarks.

```bash
$CLI record-story - <<'JSON'
{"narrative": "...", "preferences": [{"preference": "...", "kind": "directive", "supportCount": 3, "quotes": [{"quote": "...", "at": "ISO"}]}]}
JSON
```

Finish by telling the user how many requests were reviewed, the shipping velocity in two sentences, and the five strongest preferences.
