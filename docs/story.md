# Claude-Mem's story

This page is for anyone writing words that ship with Claude-Mem: the README, the installer, the viewer, error messages, log lines, docs, release notes, comments. Every one of those tells the same story. This is that story, and the words we use to tell it.

## The one sentence

Your coding agent forgets everything when a session ends. Claude-Mem gives it a second agent that takes notes while it works, so tomorrow's session opens already knowing what yesterday's figured out.

Short form, for headlines: **Your coding agent forgets everything between sessions. Claude-Mem remembers for it.**

## Who it's for

A developer who does real, ongoing work with an AI coding agent. Not someone trying an agent once; someone who comes back to the same project day after day.

What they want: to keep moving. To pick up where they left off without teaching the project to the agent all over again.

The moment that sends them looking: a fresh session (a new day, a compaction, a new terminal) where the agent re-reads the same files, asks the same questions, and walks back into a mistake the two of them already fixed. They're spending their plan's usage to relearn what the agent knew yesterday.

## The one thing it does

**The next session starts where the last one left off.**

Everything else serves that. Search lets the agent pull back the details. The viewer lets you watch the notes being written. Cloud sync and CMEM Pro carry the same memory to your other machines and agents. TeamBrain shares it with your team. None of them is a second headline.

How it pulls that off, in one breath: an observer watches your agent work and writes short notes (observations) about what it read, changed and decided. When a new session starts, the agent gets a compact index of the notes that matter and fetches full details only when it needs them.

## What it's like next to the alternatives

Other approaches ask someone to decide what's worth remembering: you keep a notes file by hand, or the agent saves a fact when it thinks to. Claude-Mem writes the notes itself, from the work as it happens, and hands the next session only what fits.

## How we sound

- **Plain, not simplistic.** Say what happens to the person. Name the mechanism only when they need it.
- **Confident, not loud.** Real numbers with their source, or no number. No "revolutionary", no "seamless".
- **Warm, not cute.** Help comes first. When something breaks, say what happened, why it matters, and the one command that fixes it.

## Where jokes go

Welcome: idle moments, an empty viewer feed, sample data, the install banner, campaign posters.

Never: errors and failed installs, anything about money, trials or billing, privacy and what leaves the machine, deleting, pruning or restoring data, and anything the agent reads (the context block costs the user tokens on every session).

## The words we use

One word for each thing, everywhere it appears.

| Say | Meaning | Avoid in user-facing copy | In the code |
| --- | --- | --- | --- |
| Claude-Mem | The product, in prose | Claude Mem, ClaudeMem | `claude-mem` is the command, package, repo and plugin id |
| memory | Everything Claude-Mem keeps for you | "context compression", "compression system" | `src/services/memory`, settings prefixed `CLAUDE_MEM_` |
| agent | The coding assistant you work with (Claude Code, Codex, Cursor, OpenCode and the rest) | "IDE" or "harness" in prose | The `--ide` flag and `platformSource` both pick the agent; the flag keeps its name |
| observer | The second agent that watches your agent work and writes observations | "compressor", "the SDK agent" | `observer-*` files in `src/services/worker`; one provider class per model source (`ClaudeProvider`, `OpenRouterProvider`, …) |
| observation | One note the observer writes about something the agent did | "tool usage observation", "compressed observation" | `observations` table, `ObservationCard` |
| summary | The recap written when a session ends | — | `session_summaries` table, `SummaryCard` |
| session | One run of your agent, from start to finish | — | `sdk_sessions`, `content_session_id`, `memory_session_id` |
| context | The memory a new session starts with | "injected context" in headlines | `src/services/context`, the SessionStart hook |
| worker | The small local service that stores and serves memory | "daemon", "background server" | `worker-service`, port setting `CLAUDE_MEM_WORKER_PORT` |
| viewer | The page in your browser where you watch observations arrive | "dashboard", "web UI" | `src/ui/viewer`, served at `/viewer` |
| mem-search | The search skill: index first, then timeline, then full details | "Smart Search" as a separate name | MCP tools `search`, `timeline`, `get_observations` |
| CMEM Pro | The paid plan: the hosted claude-mem observer plus cloud sync | "cmem Pro", "Cloud Pro" | `CLAUDE_MEM_PRO_*` settings, `pro-promo.ts` |
| cloud sync | Your memory, backed up to cmem.ai and shared across your devices | "Cloud Sync" mid-sentence | `src/services/sync` |
| TeamBrain | One shared memory for a team; your own memory stays yours | "team memory" as a product name | `src/shared/teambrain.ts` |

Names that can't change, because people's settings, scripts and links depend on them: the `claude-mem` command and its flags, settings keys, MCP tool names, URLs, and database tables. When the product word and the code name differ, this table is where the mapping lives.
