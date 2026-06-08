---
name: standup
version: 1.0.0
description: Facilitate a read-only standup across git worktrees, branches, or PRs to compare changes and produce one consolidation plan.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Task
  - AskUserQuestion
---

# standup — facilitate a group chat between branch-agents

You're the **facilitator**. Each of the user's git worktrees (and any PRs they
pick) joins a shared markdown chat as its own agent, and the agents reconcile
their scattered work into ONE consolidated worktree. You convene the room, run
the conversation in rounds, and carry the outcome back — the reconciling happens
in the chat, between the agents.

The room is one shared file (default `~/.claude-mem/STANDUP.md`): YAML front
matter holds the `goal` + `prompt`; the body is the transcript. Writes are
atomically locked, so agents speak at once. It is **read-only** — agents decide
how the merge *should* go; nobody commits or merges inside the room. Real git
work happens afterward via `/do`.

## 1. Fill the room

Two ways, mixable:

- **By recency** (common) — worktrees active in a window:
  ```bash
  node "${CLAUDE_SKILL_DIR}/standup.mjs" worktrees --since <1h|4h|24h|7d|all> --json
  ```
  Active = a commit *or* an uncommitted/staged/untracked edit in the window. If
  the user didn't name a window, offer 1h / 4h / 24h / 7d / all.

- **By hand** — specific branches and/or open PRs:
  ```bash
  node "${CLAUDE_SKILL_DIR}/standup.mjs" worktrees --json   # local branches
  node "${CLAUDE_SKILL_DIR}/standup.mjs" prs --json         # open PRs (via gh)
  ```
  Show one numbered list (worktrees + PRs, with age/title); their reply is the
  "checkbox." If `prs` errors (no `gh` / not GitHub), carry on worktrees-only.

Zero or one candidate isn't a standup — say so, offer to widen, stop. Otherwise
echo the roster to confirm before you start.

## 2. Open the room

Set a goal + prompt that invite a conversation, not one-shot status reports:

```bash
node "${CLAUDE_SKILL_DIR}/standup.mjs" open --force --agent facilitator \
  --goal "Collapse these branches/PRs into ONE consolidated worktree: what each changed, where they overlap, which becomes the target, and the merge order." \
  --prompt "Facilitated rounds. Round 1: introduce your branch and its state. Then resolve the conflicts the facilitator surfaces, round by round, until the room lands on one concrete plan (target worktree + merge order + conflict resolutions). Read-only: decide, don't merge. Register AGREE when you back the plan."
```

## 3. Run it as rounds

You drive the turns — if agents watch-loop on their own the room can stall with
nothing decided. Each agent speaks once per round (read → post → return); you
read between rounds and bring back whoever's still needed.

Spawned agents don't inherit `CLAUDE_SKILL_DIR`, so resolve it once and paste the
real path into each brief:
```bash
echo "${CLAUDE_SKILL_DIR}"
```

**Round 1 — intros (everyone, one Task message so they run together).** Brief
each:

> You're **`<branch>`** (a PR is **`pr-<number>`**) in a standup group chat. Read
> `<skill-dir>/agent-brief.md` and play your part by it. The room is
> `~/.claude-mem/STANDUP.md`; speak with `node "<skill-dir>/standup.mjs" post …`,
> catch up with `… read`. Get your bearings (`cd "<path>"`,
> `git log --oneline origin/main..HEAD`, `git status --short`,
> `git diff --stat origin/main...HEAD`; a PR uses `gh pr view/diff <number>`),
> then post ONE turn: your branch, its real state, and how it should fold in.
> Read-only. Then return.

**Reconcile.** Once they've returned, `read` the room and list the **open
items** — overlaps, conflicts, competing implementations, undecided
target/order. None? Skip to the close.

**Resolution rounds (cap ~4).** Per open item, re-spawn only the agents it
implicates, with the specific question. Tell them to `read --since <their-name>`
first, then post their position and `--agree` if convinced. `read` again, update
the list. Repeat.

**Close — you always write it.** Stop when the list is empty, you hit the cap, or
an agent errors (note "didn't report," don't block). Then write the SUMMATION
yourself — don't wait for an agent to volunteer. Write it as plain prose a human
can skim, not a field dump: which worktree is the target and why, the merge order
in a sentence, and what's left for the human:
```bash
node "${CLAUDE_SKILL_DIR}/standup.mjs" summation --agent facilitator \
  --text "Build on <worktree> — it's the only one with real code. Layer <branch>'s changes on top, then drop in the doc-only branches; skip <empty branch>. Your call before it's safe: <the one or two real decisions>. Done when it all sits in <target> and builds clean."
```

## 4. Brief the human in plain language

This is the payoff — don't hand them the raw SUMMATION, **translate it.** A human
who didn't watch the room should understand the outcome without decoding paths,
line counts, or commit hashes. Lead with the answer, then the few choices only
they can make:

- **What you found** — one plain line per branch: who has real code, who's just
  docs, who's empty.
- **The plan** — target + merge order in a sentence or two.
- **Their call** — only the decisions a human must make (which implementation
  wins, what to drop, anything risky), as concrete questions. Use
  `AskUserQuestion` for the clear-cut ones.

Keep git internals out unless they ask. Once they've settled the open calls, hand
the plan to **`/do`** to perform the merges — don't merge anything yourself
outside `/do`.

## CLI

```bash
node "${CLAUDE_SKILL_DIR}/standup.mjs" <command> [--flags]
```
Defaults: agent = git branch, file = `~/.claude-mem/STANDUP.md`. Every write is
atomically locked.

| command | what it does |
|---|---|
| `worktrees [--since 4h] [--json]` | worktrees newest-first; `--since N{m,h,d,w}` keeps those active in the window |
| `prs [--since 4h] [--json]` | open GitHub PRs (via `gh`) newest-first |
| `open --goal "…" --prompt "…" [--force]` | create the room (`--force` rotates an old one aside) |
| `join [--message "…"]` | add yourself + say Hello |
| `post --message "…" [--agree "…"]` | append a turn |
| `agree --deliverable "…"` | append an AGREE turn |
| `watch [--timeout SEC] [--interval SEC]` | block until someone else posts, print it (exit 2 on timeout) |
| `read [--tail N] [--since AGENT]` | print the chat (or only turns after AGENT's last) |
| `status` | participants + AGREEs + consensus check |
| `summation --text "…"` | write the SUMMATION, flip `status: agreed` |

Each spawned agent plays its turns by **`agent-brief.md`** (bundled here) — the
playbook for being one voice in the room.
