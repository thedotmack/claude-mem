# Claude-Mem: The Story

---

## Slide 1: The Problem

**AI agents forget everything between sessions.**

Every time you start a new Claude Code session, it's a blank slate. The architectural decisions you made yesterday, the bugs you fixed last week, the patterns you established over months — all gone.

You re-explain context. You re-discover solutions. You watch your AI assistant make the same mistakes it already learned from.

**You're training an assistant that forgets everything overnight.**

---

## Slide 2: The Insight

> "What if Claude could remember what it learned — without you doing anything?"

Observe what Claude does during a session. Compress it intelligently. Serve it back at the right time in the next session. Zero configuration, zero manual effort.

**Persistent, compressed, searchable memory — that just works.**

---

## Slide 3: v1 — The Naive Approach

The first attempt: dump everything.

```
PostToolUse Hook --> Save raw tool outputs --> Retrieve everything on startup
```

**What happened:**
- 150 file reads, 80 grep searches, 45 bash commands
- 35,000 tokens injected at session start
- Only 500 tokens were relevant (1.4%)
- Context pollution made Claude *worse*, not better

**But it proved the concept: memory across sessions is valuable.**

---

## Slide 4: v3 — The Breakthrough

The key realization: **use Claude itself to compress observations.**

Instead of storing raw tool outputs, a background worker uses the Claude Agent SDK to extract structured learnings — facts, decisions, insights — from every tool execution.

```
PostToolUse Hook --> Queue --> SDK Worker --> AI Compression --> Structured Storage
```

**Results:**
- 10:1 to 100:1 compression ratios
- Semantic understanding, not just keyword extraction
- Background processing — hooks stayed fast

**But we were still loading everything upfront.**

---

## Slide 5: v4 — The Architecture That Works

Three realizations shaped the current system:

**1. Progressive Disclosure** — Show an index first, fetch details on-demand. Don't decide relevance for the agent — let it choose.

**2. One Session, Not Many** — One long-running SDK session per Claude Code session. Context accumulates naturally. No orphaned observations.

**3. Graceful Cleanup** — Let processes finish before terminating. No more interrupted summaries or lost data.

**The lifecycle:**
```
Session Start  -->  Inject context index from previous sessions
User Prompt    -->  Create session record, save raw prompt
Tool Use       -->  Queue observation for AI compression (100+ times per session)
Session End    -->  Generate summary, mark complete, ready for next session
```

Everything runs in the background. Open localhost:37777 to watch memories form in real-time.

---

## Slide 6: What Makes It Different — Progressive Disclosure

**Traditional RAG:** Fetch 50 observations upfront. 8,500 tokens. 6% relevant.

**Claude-Mem:** Show index of 50 observations (800 tokens). Agent fetches 2-3 relevant ones (300 tokens). **100% relevant. 87% less context waste.**

```
Traditional:  System --[decides relevance]--> Agent
              "Hope this helps!"

Progressive:  System --[shows index]--> Agent --[decides relevance]--> [fetches details]
              "You know best!"
```

The agent knows the current task. We don't. So we give it the map and let it choose the path.

**The 3-Layer Workflow:**
1. **Search** — Get compact index with IDs (~50-100 tokens/result)
2. **Timeline** — Get chronological context around results
3. **Get Observations** — Fetch full details only for filtered IDs

This makes it structurally difficult to waste tokens.

---

## Slide 7: What Makes It Different — AI Compression

Every tool execution flows through the Claude Agent SDK for semantic compression.

**Before (raw tool output):**
```
Read file src/hooks/context-hook.ts (847 lines)
[full file contents, imports, functions, comments...]
~2,400 tokens
```

**After (compressed observation):**
```
Hook timeout: 60s too short for npm install
Type: gotcha | Files: plugin/hooks/hooks.json
"Default 60-second hook timeout is insufficient for npm install
with cold cache (~90 seconds). Configured to 120 seconds."
~120 tokens
```

**10:1 to 100:1 compression** — with semantic understanding, not truncation. The AI extracts what matters and discards the noise.

---

## Slide 8: By The Numbers

The journey from v3 to v5 in hard metrics:

| Metric | v3 | v5 | Improvement |
|--------|----|----|-------------|
| Context per session | ~25,000 tokens | ~1,100 tokens | 96% reduction |
| Context relevance | 8% | 100% | 12x more useful |
| Hook execution | ~200ms | ~10ms | 20x faster |
| Search latency | ~500ms | ~12ms | 40x faster |
| MCP server code | 2,718 lines | 312 lines | 88% smaller |

**Smart Explore** (v10.5): Tree-sitter AST parsing for structural code search. A/B benchmarked at **17.8x cheaper** than standard file reading for codebase discovery.

---

## Slide 9: The Skill System

Claude-Mem ships with four skills that extend Claude's capabilities:

**mem-search** — "What bugs did we fix last week?" Natural language queries across your entire project history.

**smart-explore** — AST-based code exploration, 17.8x cheaper than reading full files. Index first, fetch on demand — applied to code itself.

**make-plan** — Create phased implementation plans with automatic documentation discovery.

**do** — Execute plans using parallel subagents. Turns a plan document into working code.

---

## Slide 10: What's Coming Next

**Claude-Mem Pro: Your memory, everywhere.**

Cloud-synchronized memory across devices. Local SQLite stays the source of truth — Pro syncs it to Supabase and Pinecone for cross-device access and cloud-powered semantic search. Same real-time streaming. Pro extends the open-source core, never replaces it.

**On the roadmap:**

- **Adaptive Context** — Vary memory injection based on session type. Resumed sessions get minimal context; fresh starts get comprehensive history.
- **Multi-Project Memory** — Cross-project pattern recognition. Find how you solved rate limiting in one project while building another.
- **Collaborative Memory** — Team-shared observations with scoped visibility. Your team's institutional knowledge, searchable.
- **OpenClaw Gateways** — Claude-Mem as a persistent memory layer for autonomous AI agents, with observation feeds to Telegram, Discord, and Slack.

---

## Slide 11: The Philosophy

**Context is finite.** Treat it as a precious resource with an attention budget. More context is not always better.

**AI is the compressor.** Semantic understanding beats keyword extraction. Let Claude compress Claude's work.

**Agents are intelligent foragers.** Don't pre-decide what's relevant. Show the map, let the agent choose the path.

**Graceful beats aggressive.** Let processes finish their work. Clean state transitions prevent data loss.

**Invisible by default, visible on demand.** Users never notice it working — Claude just gets smarter over time. But if you want to watch, open localhost:37777.

---

## Slide 12: Get Started

**Claude-Mem is a persistent memory compression system that makes Claude Code smarter across sessions — automatically, invisibly, and with 100% context relevance.**

Install in 30 seconds:
```
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code. That's it.

Open source (AGPL 3.0). 28 languages. Cross-platform. Featured in Awesome Claude Code. Available on OpenClaw gateways.

**docs.claude-mem.ai**
