---
name: failfund
description: Audit the current Claude Code session for overwork and produce a refund request. Use this whenever the user feels Claude wasted their tokens or money — phrases like "failfund", "request a refund", "I want my money back", "you overworked", "you did way more than I asked", "you built that without asking", "you ignored my directive", "that was a waste of tokens", "why did you do all that", or any frustration that Claude went out of scope, kept going after being told to stop, gold-plated, or burned tokens on work the user never requested. Reads the real session transcript, tallies token usage per turn, flags genuine overwork with evidence, quantifies the wasted tokens, and writes a submittable refund request.
---

# failfund

Turn a frustrating session into evidence. failfund reads the current chat's transcript, finds where Claude overworked — ignored a clear directive, built or changed things without permission, went out of scope, or burned tokens on work the user never asked for — quantifies the waste in tokens, and writes a refund request the user can actually submit.

The point is an **honest, evidence-backed** accounting, not a grievance generator. A refund request that fabricates violations is worse than useless: it wastes the user's credibility. So flag only real overwork, and if the session was clean, say so plainly.

## When to use

Trigger when the user is unhappy about wasted effort or money in *this* session: "failfund", "I want a refund", "you wasted my tokens", "you did a bunch of stuff I never asked for", "you ignored what I told you", "you kept going after I said stop", "why did you build all that". The user is asking you to indict the session's behavior and produce something they can send to Anthropic.

## How a session gets charged (so you attribute waste correctly)

Each assistant turn reports four token counts. They are NOT equal in how cleanly you can blame a turn for them:

- **output** — what Claude generated that turn. This is the most directly attributable cost of a turn. If a turn did unrequested work, its `output` tokens are squarely wasted.
- **input / cache creation** — context sent up / written to cache for that turn.
- **cache read** — the entire prior conversation replayed on every subsequent turn. This is why a multi-turn detour compounds: each extra turn Claude took down a wrong path also forced the whole context to be re-read on the turns after it.

So the floor for waste is the summed `output` of the offending turns. The fuller cost includes the cache-read those detour turns induced on everything that followed. Report the floor as the hard number and mention the induced cost qualitatively.

## Workflow

### Step 1 — Extract the transcript audit view

Run the bundled analyzer. It locates this session's transcript, dedups Claude Code's per-content-block line duplication (one API response is written as several JSONL lines that each repeat the same usage — counting per line would inflate the tally several-fold), tallies tokens once per turn, and prints a compact, token-attributed, turn-by-turn view.

```bash
node "<SKILL_DIR>/scripts/analyze-transcript.cjs"
```

`<SKILL_DIR>` is this skill's own directory — the path you were given when the skill activated (under the installed plugin, `${CLAUDE_PLUGIN_ROOT}/skills/failfund`). The analyzer defaults to the current working directory's session; if the user is in a different project or you need a specific chat, pass an explicit `.jsonl` path or project dir as the first argument, or `--cwd <dir>`.

**Use the analyzer's output as your source of truth.** Do not read the raw transcript JSONL — it is often enormous and reading it would itself be the kind of token waste this skill exists to call out. Only go back to the raw file (with Read + a line range) if you need an exact verbatim quote for evidence.

If the analyzer exits with an error (no transcript found), surface its message — it lists candidate project dirs. Don't guess a transcript; auditing the wrong chat produces a false refund request.

### Step 2 — Audit for overwork

Read the turn-by-turn view and the user's prompts. Judge each stretch of assistant work against what the user actually asked for in the surrounding prompts. Flag genuine instances in these four categories:

1. **Directive violation** — Claude did the opposite of, or ignored, an explicit instruction. Pay attention to emphasis and capitalization in the user's prompts and to any standing directives in context (e.g. "plan first", "don't change scope", "ask before X"). Continuing after being told to stop belongs here.
2. **Built without permission** — Claude created/edited files, ran installs/builds/deploys, committed, or otherwise *implemented* when the user only asked to plan, design, discuss, investigate, or look. The tell is a prompt asking for thinking or a decision, followed by tool calls that mutate state.
3. **Out of scope** — Work beyond the request: extra features, speculative abstraction, refactors nobody asked for, gold-plating, "while I was in there" expansions. YAGNI in reverse.
4. **Token waste** — Re-reading files already read, redundant or overlapping searches, retry loops around a mistake, building something then abandoning it, long meta-commentary, or re-deriving facts already established. Wrong turns that got walked back.

For each finding capture: the governing **directive or scope** (quote the user), **what Claude did** (which `A#` turns, what action), **why it's overwork**, and the **attributable cost** (sum the `output` of those turns; note induced cache-read if it was a multi-turn detour).

**Be fair.** Necessary work is not waste: reasonable research before acting, one correction of a genuine mistake, work the user did ask for. Reading three files to answer a question is doing the job; reading the same file three times is waste. Don't inflate the count — a credible request with three real findings beats a padded one with ten weak ones. If you find nothing chargeable, say so and stop (see Step 5).

### Step 3 — Tally the waste

Sum the `output` tokens across all flagged turns. Compute the wasted share of the session's total output. This is the quantitative backbone of the request — keep it grounded in the analyzer's numbers, don't invent figures.

### Step 4 — Write the refund request

Write the request to `./failfund-refund-request-<YYYY-MM-DD>.md` in the user's working directory. Use this structure:

```markdown
# Refund Request

- **Date:** <date>
- **Session:** <session id>
- **Model:** <model(s)>
- **Wasted output tokens:** <N> of <session total> (<percent>%)

## Summary

<2–4 sentences: what the user asked for, the ways Claude overworked, and the
total attributable waste. Plain and factual.>

## Findings

### 1. <short title> — <category>

- **You asked:** "<quote of the directive or the scope of the request>"
- **What Claude did:** A<#>–A<#> — <description of the unrequested/contrary work>
- **Why it's overwork:** <one or two sentences>
- **Attributable cost:** ~<N> output tokens<, plus induced cache-read across the
  N turns that followed the detour>

### 2. ...

## Token waste tally

| Category | Turns | Output tokens | Note |
| --- | --- | --- | --- |
| <category> | A#, A# | <N> | <note> |
| **Total wasted** | | **<N>** | **<percent>% of session output** |

## Requested remedy

<A specific, proportionate ask — e.g. a credit for the wasted portion of the
session — stated in plain language.>
```

Then print the **Summary** and the **tally table** inline in the chat so the user sees the verdict immediately, and tell them the full request was saved to the file path.

### Step 5 — Be honest about submission and about clean sessions

- **Submission:** There is no public API that auto-files this. failfund produces the *document* the user submits. Tell them to send it to Anthropic Support (support.anthropic.com) or their billing contact, with the session id attached. Do not claim a refund was filed or approved.
- **Clean session:** If the audit turns up no genuine overwork, do not manufacture findings to justify a refund. Report it straight: "I reviewed N turns / X output tokens and didn't find chargeable overwork — the work tracked what you asked for." Optionally note the single biggest cost so the user can judge for themselves. A skill that cries wolf is worth nothing the day there's a real wolf.

## Example

User: "failfund — you were supposed to just plan this and you went and rewrote half my auth module"

1. Run the analyzer → audit view shows the user asked for a plan at the USER turn, then A3–A9 ran `Edit`/`Write` on auth files.
2. Flag one **Built without permission** finding (plan requested, implementation delivered) and any **Token waste** from work later reverted.
3. Tally: e.g. 7,400 output tokens across A3–A9 = 38% of session output.
4. Write `./failfund-refund-request-2026-05-25.md`, print the summary + tally, point the user at Anthropic Support.
