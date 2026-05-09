---
name: weekly-digests
description: Generate a serial week-by-week narrative digest of a project's full claude-mem timeline. Splits the timeline into per-ISO-week files, then runs one consecutive subagent per week — each receiving the prior week's carry-forward block — to produce one chapter per ISO week of data. Use when asked for "weekly digests", "week-by-week story", "serial timeline", or "narrative chapters" of a project's history.
---

# Weekly Digests

Produce a serial, multi-chapter narrative digest of a project's complete claude-mem history. Differs from `timeline-report` (one long report) — this generates one digest *per ISO week*, with each subagent reading the prior week's carry-forward block so the story stays coherent.

**The chapter count equals the number of ISO weeks the timeline covers.** A project with 2 weeks of data produces 2 chapters; one with 30 weeks produces 30. There is no fixed length — count the weeks first, then drive the pipeline off that count.

## When to Use

Trigger when the user asks for:

- "Weekly digests"
- "Week-by-week story"
- "Serial timeline"
- "Story chapters of [project]"
- "Run a digest for each week"
- "Continue the story week by week"

If the user wants a single sweeping report, use `timeline-report` instead. This skill is for serial chapter format.

## Prerequisites

- claude-mem worker running
- Project has at least one ISO week of observations (the pipeline degenerates gracefully — even N=1 works)
- A clean output directory the user is comfortable writing into

**Resolve the worker port** (do this once, reuse `$WORKER_PORT`):

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

## Workflow

### Step 1: Determine the Project Name

Same worktree-detection pattern as `timeline-report`. In a worktree, the data source is the **parent project**:

```bash
git_dir=$(git rev-parse --git-dir 2>/dev/null)
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$git_dir" != "$git_common_dir" ]; then
  parent_project=$(basename "$(dirname "$git_common_dir")")
else
  parent_project=$(basename "$PWD")
fi
echo "$parent_project"
```

### Step 2: Fetch the Full Timeline and Save It

```bash
mkdir -p .scratch
curl -s "http://localhost:${WORKER_PORT}/api/context/inject?project=PROJECT_NAME&full=true" \
  > .scratch/cm-timeline.md
wc -l .scratch/cm-timeline.md
```

Sanity-check: confirm the file is non-empty and has the expected structure (preamble, then date headers like `### Mon DD, YYYY`, then numeric observation lines `<id> <time> <emoji> <title>` and session boundary lines `S<n> <prompt> (Mon DD at HH:MMpm)`).

### Step 3: Split the Timeline Into Per-ISO-Week Files

Write a Python script to `.scratch/split-timeline.py` that:

1. Parses date headers (`### Mon DD, YYYY`).
2. Groups days into ISO weeks via `date.isocalendar()` (Monday-start).
3. Emits one file per week to `docs/timeline-weeks/<YYYY>-W<NN>-<MonDD>-to-<MonDD>.md`, preserving each day's section verbatim.
4. Runs a dual-pass sanity check: total observations distributed must equal the count in the source file.

Output structure (filenames illustrative):

```
docs/timeline-weeks/
  README.md                       # weekly index table
  YYYY-W<NN>-MonDD-to-MonDD.md    # one per ISO week the timeline covers
  ...
```

Each weekly file should preserve the original daily sections verbatim. Do not paraphrase at this stage — the digest agents need raw fidelity.

**Count the resulting files** before launching the pipeline. That count is `TOTAL` and drives every subsequent step. Empty weeks (zero observations between active weeks) should be skipped — the pipeline only operates on weeks that have content.

### Step 4: Build the Weekly Index README

Write `docs/timeline-weeks/README.md` with a markdown table: Week | Dates | Observations | Sessions | File. This becomes the operator's roadmap and helps the agents understand pacing (peak weeks vs trough weeks).

### Step 5: Run the Consecutive Subagent Pipeline

**Critical: subagents run sequentially, NOT in parallel.** Each agent receives the prior agent's carry-forward block. This is the entire point of the skill — without it you have N disjoint summaries; with it you have an N-chapter serial narrative.

Create the output directory:

```bash
mkdir -p docs/timeline-weeks/digests
```

For each week, in chronological order, dispatch a Task subagent (general-purpose) with this prompt template. **Wait for each agent to complete before launching the next.** Capture the carry-forward block from the result and inject it as `STORY_SO_FAR` into the next prompt.

#### Subagent Prompt Template

```
You are writing chapter {N} of {TOTAL} in a serial week-by-week digest of the {PROJECT} project's development history. Chapters 1 through {N-1} are written. {SPECIAL_NOTE: e.g. "This is the LARGEST week", "This is the TROUGH", "This is the FINAL chapter", "This is the ONLY chapter — both first AND final week"}.

**Source file (read in full):**
{ABSOLUTE_PATH_TO_WEEK_FILE}

**Output digest file (write):**
{ABSOLUTE_PATH_TO_DIGEST_FILE}

**Format key for the source file:**
- Numeric lines like `1 7:59p 🔵 Save hook file is empty` are observations (ID, time, type-emoji, title)
- `S##` lines are session boundaries (the user prompt that started the session)
- Emoji legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note

**Story so far (carry-forward from Week {N-1}):**

{STORY_SO_FAR_BLOCK_OR_EMPTY_FOR_WEEK_1}

**Your digest must include:**
1. **Title line** — `# Week {N} ({WEEK_LABEL}): {DATE_RANGE} — [your chosen subtitle]`
2. **One-line tagline** — what this week is about, in plain English
3. **Narrative section** ({BUDGET}) — tell the story. Resolve threads from prior weeks where the data shows resolution. Introduce new arcs. Use specific observation details.
4. **Threads continued / opened / resolved** sections
5. **Cliffhanger / What's next**
6. **Carry-forward block** at the very bottom, fenced as ```carry-forward ... ``` — structured handoff for the next week's agent.

**CARRY-FORWARD DISCIPLINE:**
- Cap at ~350 words.
- AGGRESSIVELY PRUNE: drop arcs that didn't surface this week unless they're actively unresolved cliffhangers.
- Drop cast members absent 2+ weeks unless load-bearing for the long arc.
- Quality over completeness. The next agent inherits what you mention; mention judiciously.

Required carry-forward sub-sections:
- **Active arcs** — ongoing themes/projects the next agent should watch for
- **Cast** — notable named systems/people/tools (continuing + new)
- **Unresolved** — open questions or unfinished work
- **Tone notes** — how the story is being told (voice, perspective, register evolution)

**Tone rules:**
- Third-person narrator, sharp, observational. Not twee.
- AI is "Claude"; human is "{USER_FIRST_NAME}".
- Treat codebase components as characters — whatever the project's recurring named systems are (e.g. a worker, a queue, a process manager, a recurring bug, a flaky migration). Don't import names from another project; use what shows up in this project's observations.
- Don't manufacture drama. Name what's there.
- Track the user's prompt-register evolution week by week (frustration markers, escalation language, shifts in tone).
- Note meta-recursion if the project is reflexive about its own behavior (e.g. a tool that documents its own work, an AI agent debugging itself, a system that catches its own regressions).
- Watch for new villains or co-stars and name them.
- For trough/silent weeks: silence IS the story. Don't pad. Name what didn't happen.
- For surge weeks (>2,000 obs): pick 4-7 spine arcs and tell them well. Don't catalog.

**Important:** Do NOT speculate beyond what's in the source file.

After writing the file, return:
1. Path of the file you wrote
2. The carry-forward block verbatim
3. One-sentence summary of the week
```

#### Narrative Budget by Observation Count

Scale narrative length proportionally to the week's volume:

| Obs count | Narrative section budget |
| --- | --- |
| < 100 | 200–400 words |
| 100–500 | 300–600 words |
| 500–1,500 | 500–900 words |
| 1,500–3,000 | 700–1,100 words |
| 3,000+ | 800–1,300 words |

Pad these into the `{BUDGET}` slot of the prompt for each week.

#### The First Week

For Week 1, pass an empty `STORY_SO_FAR_BLOCK` and an instruction noting it's the origin chapter — the agent should establish initial cast, tone, and arcs for everyone after.

#### The Final Week

The final week gets a different ending: **no carry-forward block**. Instead, instruct the agent to write a `## Where We Are` section (~250 words) naming what's still open at the moment of writing. Tell the agent the project is ongoing — the digest stops; the story doesn't. Don't give the story a false ending.

#### When N = 1 (single-week project)

Apply BOTH treatments to the same chapter: empty `STORY_SO_FAR_BLOCK` AND `## Where We Are` instead of a carry-forward block. The agent is writing both the origin and the close in one pass. Don't reference prior or future chapters that don't exist.

### Step 6: Rename Files for Sortable Order

The agents write digests with names like `YYYY-W<NN>-digest.md`. These already sort chronologically by ISO week (until a project crosses a year boundary inside one project name), but **add a zero-padded numeric prefix** so the order is unambiguous to humans browsing or scripting against the directory:

```bash
cd docs/timeline-weeks/digests
total=$(ls *.md | wc -l | tr -d ' ')
width=${#total}                  # 1 for N<10, 2 for N<100, 3 for N<1000
[ "$width" -lt 2 ] && width=2    # always pad to at least 2 for readability
i=0
for f in *.md; do
  printf -v prefix "%0${width}d" $i
  mv "$f" "${prefix}-$f"
  i=$((i+1))
done
```

Result for N=30: `00-...md` through `29-...md`. For N=4: `00-...md` through `03-...md`. For N=120: `000-...md` through `119-...md`. **Always zero-pad** — `1-...md` and `10-...md` sort wrong without it.

Do NOT also prepend the order number to the digest title line inside each file. The filename prefix is for sorting; the title stays clean: `# Week N (W##): Date — Subtitle`.

### Step 7: Report Completion

Tell the user:
- Total weeks digested (N)
- Output directory path
- Date range covered
- Any silent/trough weeks worth flagging
- A one-sentence capstone summarizing the arc — written by the final-chapter agent, or composed by the operator from the final agent's `## Where We Are` section.

## Pipeline Discipline

These rules emerged from running the pipeline end-to-end. Encode them every time:

1. **Sequential, not parallel.** The whole point is the carry-forward chain. Parallelism breaks it.
2. **Carry-forward is bounded.** It will bloat without active pruning. Tell every agent: cap ~350 words, drop dormant arcs, drop absent cast.
3. **Track register evolution explicitly.** The user's prompt-style across weeks is a story arc. Frustration markers shift over time (whatever they happen to be in this project's data). Name the shifts.
4. **Treat components as characters.** Whatever recurring named systems show up in the observations are this project's villains and co-stars. Stable cast across weeks builds narrative coherence.
5. **Honor silence.** Trough weeks (10–100 obs) are real chapters. Name what didn't happen. Don't pad.
6. **Don't manufacture drama.** Just observe the data. If the project is reflexive, the recursion is the drama; you don't need to add more.
7. **Final week: no false ending.** The digest stops; the project doesn't. Write `## Where We Are`, not "the end."

## Error Handling

- **Empty timeline**: project name wrong, or worker not running. `curl -s "http://localhost:${WORKER_PORT}/api/search?query=*&limit=1"` to verify.
- **Worker not running**: start it via your usual method or check `ps aux | grep worker-service`.
- **Subagent returns malformed carry-forward**: extract the carry-forward block by regex (` ```carry-forward ... ``` `) and pass forward verbatim. If missing, ask the agent to retry with the explicit instruction "your reply MUST include the carry-forward block fenced as ```carry-forward ... ``` at the very end."
- **One agent fails mid-pipeline**: retry that week with the same carry-forward. Don't skip — the chain breaks.
- **Carry-forward growing past ~500 words**: tighten the discipline instruction in subsequent prompts. Force pruning explicitly.

## Examples

### Long-running project (~30 weeks)

User: "Make weekly digests for [project] from beginning to end"

1. Resolve worker port, detect project name.
2. Fetch full timeline → `.scratch/cm-timeline.md`.
3. Run `.scratch/split-timeline.py` → N weekly files in `docs/timeline-weeks/` (e.g. 30).
4. Generate `docs/timeline-weeks/README.md` index.
5. Launch N subagents consecutively, one per week. Each gets the prior week's carry-forward. The first chapter starts with empty carry-forward; the final chapter writes `## Where We Are` instead of a carry-forward block.
6. Rename digests with zero-padded order prefix (`00-...md` through `29-...md`).
7. Report total chapters, date range, any troughs/peaks, and the one-line capstone the final agent produced.

### Short-lived project (~3 weeks)

Same flow, just smaller. N=3, so:
- Chapter 1: empty carry-forward, establish cast/tone/arcs.
- Chapter 2: receives chapter 1's carry-forward, builds on it.
- Chapter 3: receives chapter 2's carry-forward, BUT gets the final-chapter treatment (`## Where We Are` instead of carry-forward block).
- Filenames: `00-...md`, `01-...md`, `02-...md`.

### Single-week project (N=1)

Apply both first-and-final-chapter treatment to the only chapter: empty carry-forward, `## Where We Are` close, no inter-chapter references. Filename: `00-...md`.
