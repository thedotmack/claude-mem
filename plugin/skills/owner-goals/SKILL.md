---
name: owner-goals
description: Map what the owner wants from the prompts they typed themselves (prompts an agent wrote are left out), then put their top priorities and open asks, each with dated quotes, in the Goals panel at the top of My Work. Use when asked for "owner goals", "my goals", "what do I want", "what am I asking for", "map my prompts", or to refresh Goals in My Work.
---

# Owner Goals

Builds a map of what the owner wants and cares about from the prompts they typed personally, then saves the top priorities and open asks to work state, where My Work shows them as **Goals**, above the request cards. Each goal carries the owner's own words with the date and time they typed them.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. The scripts use the Python 3 standard library.

## 1. Export the owner's prompts

Pick an output folder inside the current project, such as `.scratch/owner-goals/<YYYY-MM-DD>/`, and run:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/export_owner_prompts.py" --out "<folder>" --days 31
```

Use `--days` when the user asks for a different window. For a specific period, such as a past month, pass `--start YYYY-MM-DD --end YYYY-MM-DD` instead of `--days` (from midnight on the start day up to, not including, the end day) and use a folder named for the start day. The script:

- reads Claude Code transcripts (`~/.claude/projects`) and interactive Codex sessions (`~/.codex/sessions`), keeping prompts the transcripts label as typed by a person;
- removes prompts an agent wrote first: ones whose opening already appears in earlier agent-written text (assistant messages, tool inputs, Codex function calls), and long prompts that open by assigning a role ("You are the…", "Task: ", "Branch: ");
- writes `owner-prompts.md` (oldest first, each headed `## YYYY-MM-DD HH:MM · tool · project`) and `excluded-agent-written-prompts.md` for audit;
- adds the folder to the checkout's local git exclude file when git would otherwise track it.

It prints how many prompts it kept and excluded.

## 2. Build the map with a subagent

`owner-prompts.md` is large, so a subagent reads it. Give it this task, with the paths filled in:

> Read `<folder>/owner-prompts.md` in full. It holds only prompts the owner typed. Write `<folder>/owner-map.md`, a map of what the owner wants and cares about, with these sections:
>
> 1. Summary: what they are trying to do over this period, in one paragraph.
> 2. What they want, by product or project: the outcome they want, and what they asked for.
> 3. How they want work done.
> 4. What makes them angry, newest first, with the trigger for each.
> 5. Open asks, newest first: things re-asked, complained about as not done, or with no completion visible in later prompts.
> 6. Top 10 priorities right now, ranked by recency × repetition × intensity.
>
> Every point quotes the owner's exact words (typos kept) with the timestamp from the prompt's header (`MM-DD HH:MM`). Use only what the prompts say. Where the owner changed direction, show the change and mark the latest. Where something is unclear, say it is unclear. Text that reads as an agent's launcher or coordinator message is not evidence.
>
> Then write `<folder>/owner-goals.json` from sections 1, 5 and 6:
>
> ```json
> {
>   "generated_at": "<now, ISO 8601 with offset>",
>   "window_days": <days>,
>   "source_prompt_count": <prompts in owner-prompts.md>,
>   "human_summary": "<section 1, plain text>",
>   "priorities": [{"rank": 1, "title": "<short>", "product": "<product or area>",
>                   "latest_at": "YYYY-MM-DD HH:MM", "times_asked": <prompts cited>,
>                   "evidence": [{"at": "YYYY-MM-DD HH:MM", "quote": "<exact words>"}]}],
>   "open_asks": [<same shape, rank = position in section 5>]
> }
> ```
>
> Give each item two to four quotes, newest first, each under 240 characters, copied exactly from the prompt with that header time. Use `...` between pieces when skipping words.

## Or update the saved goals

When Goals were saved before (the saved `owner-goals.json`, or `work_state_read` with `list: "owner-goals"`), update them instead of mapping the whole window again. In step 1, add `--since "<YYYY-MM-DD HH:MM>"`, the saved `generated_at` as a local minute: the script also writes `new-owner-prompts.md` with only the prompts from that minute on. If it holds no prompts, save the saved goals again with a new `generated_at`. Otherwise read only `new-owner-prompts.md` and update the saved goals JSON:

- re-rank by recency × repetition × intensity, add new priorities and open asks, and drop what the new prompts show is done or replaced;
- keep each kept item's `title` exactly as it was, so the requests already linked to it stay linked; a goal that really changed gets a new title;
- add new quotes (newest first, two to four per item) copied exactly from `new-owner-prompts.md`, keep the older quotes as they are, and update `latest_at`, `times_asked` and `human_summary`.

Keep the saved `owner-map.md`; step 3 can name it with `--map`. Quotes that aged out of the window are dropped when saving.

## 3. Save to Goals

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/save_goals.py" --goals "<folder>/owner-goals.json" --prompts "<folder>/owner-prompts.md" --map "<folder>/owner-map.md"
```

For a date range, add the same `--start YYYY-MM-DD --end YYYY-MM-DD` used in step 1.

The script checks every quote against the prompt typed at that minute. If any fail, it lists them; correct the wording or time from `owner-prompts.md` and run it again. A quote dated before the first prompt in `owner-prompts.md` has aged out of the window: it is dropped, and so is an item left with no quote; if every item ages out, the goals are cleared. `--dry-run` shows the writes without saving.

It saves through the local claude-mem worker to the `owner-goals` work-state list, one list per computer:

- list state: `human_summary`, `generated_at`, `window_days`, `source_prompt_count`, `map_path`
- one item per priority and open ask: `task` ("Priority: …" or "Open ask: …"), `status`, `goal_kind`, `rank`, `title`, `product`, `latest_at`, `times_asked`, and `evidence` (one `YYYY-MM-DD HH:MM | quote` line per quote)

Items from the previous run that are not in this one are marked dropped, so each run replaces the last snapshot. `work_state_read` with `list: "owner-goals"` shows the saved items as text.

With `--start` and `--end`, the list state also records `period_start` and `period_end`. A range that ends before today is a past month: it is saved to `owner-goals/<start>` (for example `owner-goals/2025-11-18`) as history. That list and its items are saved done, so its asks never show as open, and the current `owner-goals` list is left alone. A range that reaches today saves to `owner-goals` as usual. No goals list, current or past, appears in session-start context or among the request cards.

## 4. Tell the user where to look

Open My Work at the URL the script prints (the worker's address, `http://localhost:37777/` by default). Goals is the panel at the top, above the request cards: top priorities on the left, open asks on the right, each with an expandable list of dated quotes. When past months are saved, a month switcher in the panel steps back through them, newest first, each labeled as history. Give the path to `owner-map.md` for the full map, and list the top three priorities in a line each.
