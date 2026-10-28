---
name: owner-goals
description: Map what the owner wants from the prompts they typed themselves (prompts an agent wrote are left out), then sort it into focus areas, asks and rules, each with dated quotes, and save them to My Work (areas as My Focus suggestions, rules as My Rules suggestions). Use when asked for "owner goals", "my goals", "what do I want", "what am I asking for", "map my prompts", or to refresh Goals in My Work.
---

# Owner Goals

Builds a map of what the owner wants and cares about from the prompts they typed personally, then sorts every statement in it into exactly one kind and saves it to My Work:

- a **focus area**: a part of the work the owner can ask for things inside of, with one sentence saying what it is for. New ones show in My Focus as suggestions the owner keeps, renames, merges or dismisses;
- an **ask**: one thing the owner asked for that can be marked done, filed under a focus area;
- a **rule**: how the owner wants work done. It shows in My Rules as a suggestion.

Each one carries the owner's own words with the date and time they typed them.

`${CLAUDE_SKILL_DIR}` is the folder holding this file. The scripts use the Python 3 standard library.

Use Python 3.9 or newer. On Windows, replace `python3` below with `python -X utf8` (or `py -3 -X utf8` when using the Python launcher); the Microsoft Store `python3` alias is not an installed interpreter.

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

First save the focus areas already in My Focus, so the map can say which of them each area it finds already is:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/save_goals.py" --print-focus-areas > "<folder>/focus-areas.json"
```

`owner-prompts.md` is large, so a subagent reads it. Give it this task, with the paths filled in:

> Read `<folder>/owner-prompts.md` in full. It holds only prompts the owner typed. Write `<folder>/owner-map.md`, a map of what the owner wants and cares about, with these sections:
>
> 1. Summary: what they are trying to do over this period, in one paragraph.
> 2. What they want, by part of their work: the outcome they want, and what they asked for.
> 3. How they want work done.
> 4. What makes them angry, newest first, with the trigger for each.
> 5. Asks still open, newest first: things re-asked, complained about as not done, or with no completion visible in later prompts.
> 6. Focus areas right now, ranked by recency × repetition × intensity.
>
> Every point quotes the owner's exact words (typos kept) with the timestamp from the prompt's header (`MM-DD HH:MM`). Use only what the prompts say. Where the owner changed direction, show the change and mark the latest. Where something is unclear, say it is unclear. Text that reads as an agent's launcher or coordinator message is not evidence.
>
> Then sort what sections 3, 5 and 6 found into `<folder>/owner-goals.json`. Put every statement through these three tests, in this order, and stop at the first that says yes:
>
> 1. Is it about *how* work is done? Then it is a **rule**.
> 2. Is it one ask that can be marked done? Then it is an **ask**.
> 3. Could you ask for things *inside* it? Then it is a **focus area**.
>
> A statement that holds two parts is split. "Ship everything end to end without me publishing" is a focus area (releases) and a rule (carry work through release without the owner publishing). Each part gets its own quotes. A statement is never saved as two kinds of the same thing: an ask is never also an area, and a rule is never also an ask.
>
> `<folder>/focus-areas.json` lists the focus areas already saved. For each focus area you write, judge whether it is one of those, whatever its name, and set `matches` to that area's `focusAreaId`, or to `null` when none is. Two of your areas never match the same saved area. Never match by name alone.
>
> A focus area's title must never reuse a nav label as whole words, in any case: My Focus, My Work, My Rules, Other, Suggested, Past focus, Monitor, Steer ("Work viewer" is fine, "Other tools" is not). claude-mem refuses such a name and the save fails.
>
> ```json
> {
>   "generated_at": "<now, ISO 8601 with offset>",
>   "window_days": <days>,
>   "source_prompt_count": <prompts in owner-prompts.md>,
>   "human_summary": "<section 1, plain text>",
>   "focus_areas": [{"rank": 1, "title": "<short name>",
>                    "goal": "<one sentence: what this area is for>", "matches": "<focusAreaId>" or null,
>                    "latest_at": "YYYY-MM-DD HH:MM", "times_asked": <prompts cited>,
>                    "evidence": [{"at": "YYYY-MM-DD HH:MM", "quote": "<exact words>"}]}],
>   "asks": [{"rank": 1, "title": "<the ask>", "focus_area": "<a title from focus_areas>" or null,
>             "latest_at": "YYYY-MM-DD HH:MM", "times_asked": <prompts cited>, "evidence": [<same shape>]}],
>   "rules": [{"when": "<the situation, or empty for always>", "then": "<what to do, one sentence>",
>              "latest_at": "YYYY-MM-DD HH:MM", "times_asked": <prompts cited>, "evidence": [<same shape>]}]
> }
> ```
>
> Rank focus areas by recency × repetition × intensity, and asks by position in section 5. An ask names the focus area it sits in by that area's `title` in this file, or `null` when it fits none. Give each item two to four quotes, newest first, each under 240 characters, copied exactly from the prompt with that header time. Use `...` between pieces when skipping words.

## Or update the saved goals

When Goals were saved before (the saved `owner-goals.json`, or `work_state_read` with `list: "owner-goals"`), update them instead of mapping the whole window again. In step 1, add `--since "<YYYY-MM-DD HH:MM>"`, the saved `generated_at` as a local minute: the script also writes `new-owner-prompts.md` with only the prompts from that minute on. If it holds no prompts, save the saved goals again with a new `generated_at`. Otherwise save `focus-areas.json` as in step 2, read only `new-owner-prompts.md` and update the saved goals JSON:

- put each new statement through the three tests, in order; re-rank focus areas by recency × repetition × intensity, add new focus areas, asks and rules, and drop what the new prompts show is done or replaced;
- keep each kept item's `title` exactly as it was, so the requests already linked to it stay linked; a goal that really changed gets a new title;
- keep each kept focus area's `matches`, and set it for new ones from `focus-areas.json`;
- add new quotes (newest first, two to four per item) copied exactly from `new-owner-prompts.md`, keep the older quotes as they are, and update `latest_at`, `times_asked` and `human_summary`.

Saved goals with `priorities` and `open_asks` instead were sorted before the three tests: sort every item again into `focus_areas`, `asks` and `rules`.

Keep the saved `owner-map.md`; step 3 can name it with `--map`. Quotes that aged out of the window are dropped when saving.

## 3. Save to Goals

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/save_goals.py" --goals "<folder>/owner-goals.json" --prompts "<folder>/owner-prompts.md" --map "<folder>/owner-map.md"
```

For a date range, add the same `--start YYYY-MM-DD --end YYYY-MM-DD` used in step 1.

The script checks every quote against the prompt typed at that minute. If any fail, it lists them; correct the wording or time from `owner-prompts.md` and run it again. A quote dated before the first prompt in `owner-prompts.md` has aged out of the window: it is dropped, and so is an item left with no quote; if every item ages out, the goals are cleared. It refuses the old `priorities` / `open_asks` shape, a focus area without `goal` or `matches`, a `matches` id that is not a saved area, and an ask whose `focus_area` is not one of the file's focus areas. `--dry-run` shows the writes without saving.

It saves through the local claude-mem worker:

- focus areas that match no saved one become suggested areas in My Focus (`source: owner-goals`). A matched area is never renamed or changed: an area the owner kept, renamed, merged or dismissed stays as the owner left it;
- the `owner-goals` work-state list, one list per computer. List state: `human_summary`, `generated_at`, `window_days`, `source_prompt_count`, `map_path`. One item per focus area and ask: `task` ("Focus area: …" or "Ask: …"), `status`, `goal_kind` (`focus-area` or `ask`), `rank`, `title`, the area's `goal` or the ask's `focus_area`, `focus_area_id`, `latest_at`, `times_asked`, and `evidence` (one `YYYY-MM-DD HH:MM | quote` line per quote);
- rules go to My Rules as suggestions: the build story's preferences in `~/.claude-mem/work-view/story.json` (`--ledger-dir` for another folder), replacing the rules an earlier save put there.

Items from the previous run that are not in this one are marked dropped, so each run replaces the last snapshot. `work_state_read` with `list: "owner-goals"` shows the saved items as text.

With `--start` and `--end`, the list state also records `period_start` and `period_end`. A range that ends before today is a past month: it is saved to `owner-goals/<start>` (for example `owner-goals/2025-11-18`) as history. That list and its items are saved done, so its asks never show as open, and the current `owner-goals` list is left alone. A past month suggests no focus areas and no rules. A range that reaches today saves to `owner-goals` as usual. No goals list, current or past, appears in session-start context or among the request cards.

## 4. Tell the user where to look

Open My Work at the URL the script prints (the worker's address, `http://localhost:37777/` by default). New focus areas wait under My Focus as suggestions, and new rules under My Rules. Give the path to `owner-map.md` for the full map, and list the top three focus areas in a line each.
