---
name: how-it-works
description: Explain how claude-mem captures observations, when memory injection kicks in, and where data lives. Use when the user asks "how does claude-mem work?" or "what is this thing doing?".
---

# How claude-mem works

## What it does

While you work, an observer (a second agent) watches what your agent reads, edits and runs, and writes short notes about what mattered. Those notes are called observations. When a session ends, the observer writes a summary. When the next session starts, your agent gets a compact index of the observations that matter for this project and fetches full details only when it needs them.

So the next session starts where the last one left off: no re-explaining the codebase, no re-discovering decisions.

## When it kicks in

Memory injection starts on your second session in a project.

The first session seeds memory as you work. To front-load a whole repo in one pass instead, run `/learn-codebase` (~5 minutes on a typical repo, optional).

## Where data lives

Your memory lives in ~/.claude-mem on this machine: the SQLite database, vector index, logs and settings. `npx claude-mem uninstall` removes it.

What leaves the machine:

- What the observer reads goes to the model you chose to run it: your Claude plan unless you picked another provider (Codex, OpenRouter, Gemini, or the claude-mem observer on CMEM Pro).
- During install, cmem.ai is contacted once to create the sign-in link, with a numbers-only usage summary (observation counts and token totals; no prompts, paths, or project names). Nothing else goes to cmem.ai unless you sign in and turn on something that uses it (cloud sync, CMEM Pro's hosted observer, a provider that runs through your cmem.ai account) or choose to upload your prompts during browser setup.
- Anonymous usage analytics (telemetry) are on by default. Turn them off with `npx claude-mem telemetry disable`, or set `DO_NOT_TRACK=1`.
