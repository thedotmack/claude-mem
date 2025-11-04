# Your Claude forgets everything after /clear. Mine doesn't.

You know the cycle.

/init to learn your codebase. Claude reads everything, understands your architecture, builds context.

You work for a while. Context window fills up. Eventually you hit /clear.

Everything's gone.

Next session: Claude reads CLAUDE.md again. Does the research again. Re-learns your codebase again.

**Tokens cost money. Research takes time. Claude forgets.**

This cycle is killing productivity.

## I built persistent memory that survives /clear

Not summaries. Not compressed conversations. [Actual persistent memory](https://github.com/thedotmack/claude-mem)—capture everything Claude does, process it with AI, make it instantly recallable across sessions.

Early on I tried vector stores, MCPs, memory tools. ChromaDB for vector search. But documents were massive—great for semantic matching, terrible for context efficiency.

That led to the hybrid approach.

## How it works

SQLite database with semantic chunking. ChromaDB for vector search when you need it—incredibly fast, incredibly relevant. FTS5 keyword search as fallback.

The magic? This loads automatically at every session start. No /init. No research phase.

Here's what I see when I start a new session on my "claude-mem-performance" project:

```
📝 [claude-mem-performance] recent context
────────────────────────────────────────────────────────────

Legend: 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision

💡 Progressive Disclosure: This index shows WHAT exists (titles) and retrieval COST (token counts).
   → Use MCP search tools to fetch full observation details on-demand (Layer 2)
   → Prefer searching observations over re-reading code for past decisions and learnings
   → Critical types (🔴 bugfix, 🧠 decision) often worth fetching immediately

Nov 3, 2025

🎯 #S651 Read headless-test.md and use plan mode to prepare for writing a test (Nov 3, 1:27 PM) [claude-mem://session-summary/651]

🎯 #S650 Read headless-test.md and use plan mode to prepare for writing a test (Nov 3, 1:27 PM) [claude-mem://session-summary/650]

test_automation.ts
  #3280  1:31 PM  ✅  Updated test automation prompts for Kanban board project (~125t)

🎯 #S652 Read headless-test.md and use plan mode to prepare for writing the test (Nov 3, 1:32 PM) [claude-mem://session-summary/652]

General
  #3281  1:33 PM  🔵  Examined test automation script (~70t)

test_automation.ts
  #3282  1:34 PM  🟣  Implemented full verbose output mode for tool execution visibility (~145t)
  #3283  1:35 PM  ✅  Enhanced plan generation streaming with partial message support (~109t)

🎯 #S653 Read headless-test.md and use plan mode to prepare for writing the test (Nov 3, 1:35 PM) 

Completed: Modified the generatePlan function in test_automation.ts to support `includePartialMessages: true` and integrate the streamMessage handler for unified streaming output. This improves the real-time feedback mechanism during plan generation.

Next Steps: 1. Read and analyze headless-test.md to understand test requirements. 2. Use plan mode to generate a test implementation strategy. 3. Write the actual test based on the plan.
```

**What you're seeing:**
- Session summaries (🎯) - what you were working on
- What Claude learned - observations with type indicators (bugfix, feature, change, discovery)
- Token costs - so you know what's expensive to recall
- Chronological flow - recent work, newest first
- Loaded in <200ms at session start

Timeline order: your past sessions, Claude's work, what was learned, what's next.

And when you need something from weeks ago? Natural language search + instant timeline replay gets you there in <200ms.

## The breakthrough: temporal context

Most memories are duplicate knowledge. Your architecture doesn't fundamentally change every session.

But some memories are **changes**. Bugfixes. Refactors. Decisions.

Without timestamps, without knowing what's "newest," your information is stale. And stale information means Claude has to research—the token-heavy work I'm trying to eliminate.

## The paradox

Claude-mem's startup context got so good that Claude rarely uses the search tools anymore.

The last 50 observations at session start is usually enough. /clear doesn't reset anything—next session starts exactly where you left off.

But when you need to recall something specific from weeks ago, the context timeline instantly gets Claude back in the game for that exact task.

**No /init. No research phase. No re-learning.**

Just: start session, Claude knows your codebase, you work.

Development becomes pleasant instead of repetitive. Token-efficient instead of wasteful. Focused instead of constantly re-explaining.

---

**claude-mem v5.0** just shipped: https://github.com/thedotmack/claude-mem

Python optional but recommended for semantic search. Falls back to keyword search if you don't have it.

**Install in Claude Code:**
```
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Anyone else tired of both paying and WAITING for Claude to re-learn their codebase after every /clear?