# Mastra Observational Memory — Analysis, Critique, and Comparison with claude-mem

**Date:** 2026-03-01
**Sources:** [mastra.ai/blog/observational-memory](https://mastra.ai/blog/observational-memory), [github.com/mastra-ai/mastra](https://github.com/mastra-ai/mastra), Mastra docs
**Purpose:** Evaluate Mastra's memory architecture for ideas that could benefit claude-mem

---

## 1. What is Mastra's Observational Memory?

Mastra is an open-source TypeScript AI agent framework (Apache 2.0, 21.5k stars). Its memory system (`@mastra/memory`) implements four tiers:

| Tier | Purpose | Mechanism |
|------|---------|-----------|
| **Message History** | Raw recent messages | FIFO (last N messages) |
| **Working Memory** | Structured user profile / scratchpad | Zod schema or Markdown template, updated by agent tool |
| **Semantic Recall** | RAG retrieval of similar past messages | Vector similarity search (17+ vector DB integrations) |
| **Observational Memory** | Compressed observation log replacing raw history | Two background LLM agents (Observer + Reflector) |

**Observational Memory (OM)** is the newest and most ambitious tier. Its core insight: instead of retrieving relevant fragments (RAG), compress the entire conversation into a dense, append-only observation log that fits directly in the context window.

### Two-Block Context Architecture

```
┌─────────────────────────────────────────────┐
│ Block 1: Observations (compressed history)  │  ← Stable prefix (prompt-cache friendly)
│          Append-only until reflection        │
├─────────────────────────────────────────────┤
│ Block 2: Raw Messages (recent conversation) │  ← Replaced by observations at threshold
└─────────────────────────────────────────────┘
```

### Background Agents

- **Observer Agent**: Triggered when raw messages exceed ~30K tokens. Compresses raw messages into timestamped, priority-tagged observations. 5-40x compression ratio.
- **Reflector Agent**: Triggered when observation log exceeds ~40K tokens. Garbage-collects non-essential observations. Further condenses remaining entries.
- **Default model**: `google/gemini-2.5-flash` (1M context window). Claude models "currently don't work well" for these roles.

### Observation Format

Text-based log with emoji priority tags and three-date temporal model:

```
Date: 2026-01-15
- 🔴 12:10 User building Next.js app with Supabase auth, due January 22nd
  - 🟡 12:12 User asked about middleware for protected routes
- 🟢 12:15 Discussed rate limiting options (chose Redis approach)

Date: 2026-01-16
- 🔴 09:00 User switched auth provider from Supabase to Clerk
```

Three dates per observation:
- **observation date** — when created
- **referenced date** — when the observed event occurred
- **relative date** — contextual temporal info

---

## 2. Head-to-Head Comparison

### Architectural Philosophy

| Dimension | Mastra OM | claude-mem |
|-----------|-----------|------------|
| **Core approach** | Full context injection (no search needed) | Hybrid search + selective injection |
| **Integration** | In-process library (`@mastra/memory`) | Out-of-process worker service (Express on :37777) |
| **Target** | Any AI agent (Mastra, LangChain, Vercel AI SDK) | Claude Code specifically |
| **Observation creation** | Background LLM agents (Observer/Reflector) | Claude Agent SDK compression per-observation |
| **Observation format** | Plain text log (emoji priorities, dates) | Structured SQLite rows (title, narrative, facts, concepts, files) |
| **Storage** | LibSQL, PostgreSQL, MongoDB | SQLite + ChromaDB |
| **Search** | None — everything in context | BM25 + ChromaDB vector + RRF scoring |
| **Context injection** | Stable prefix (entire observation log) | Hook-based selective injection (recent + relevant) |
| **Privacy** | None documented | `<private>` tag stripping at edge |
| **UI** | None | React viewer with search, filters, analytics |
| **Prompt caching** | Designed for it (stable prefix = cache hits) | Not designed for it (dynamic injection per session) |
| **Scope model** | Thread (conversation) / Resource (user) | Session / Project |
| **Token management** | Configurable thresholds + async buffering | Effort level setting |
| **License** | Apache 2.0 | Proprietary |

### Compression Pipeline

| Aspect | Mastra OM | claude-mem |
|--------|-----------|------------|
| **When triggered** | Token threshold exceeded (~30K tokens) | Every PostToolUse hook (per-observation) |
| **Granularity** | Batch compression (many messages → observation log) | Per-tool-call compression |
| **Compression ratio** | 5-40x (tool-heavy) / 3-6x (text chat) | ~2-5x (per observation) |
| **Two-stage** | Yes (Observer → Reflector) | No (single-pass) |
| **Priority tagging** | Yes (🔴/🟡/🟢 with defined semantics) | No (all observations treated equally) |
| **Temporal model** | 3-date system (created, referenced, relative) | Single timestamp (`created_at_epoch`) |
| **State change tracking** | Explicit ("switched from A to B") | Implicit (narrative may mention changes) |
| **Lossy** | Yes (Reflector garbage-collects) | No (all observations persist) |

### Search and Retrieval

| Aspect | Mastra OM | claude-mem |
|--------|-----------|------------|
| **Primary mechanism** | None — full context injection | Hybrid search (BM25 + Chroma vectors + RRF) |
| **Vector search** | Only for Semantic Recall tier (separate from OM) | ChromaDB with cosine similarity |
| **Keyword search** | None | FTS5 with BM25 ranking, per-column weights |
| **Score fusion** | N/A | Reciprocal Rank Fusion (k=60) |
| **Graceful degradation** | N/A | Falls back to available backends |
| **Query language** | N/A | Natural language via MCP tools |

---

## 3. Critique of Mastra OM

### Strengths

1. **Prompt caching alignment** — The stable-prefix design is genuinely clever. Observations form an append-only block that gets prompt-cached, reducing costs 4-10x. This is a real architectural advantage over dynamic injection.

2. **No vector DB needed** — Eliminating ChromaDB/Pinecone removes infrastructure complexity, embedding costs, and cold-start latency. For many use cases, this is a significant operational simplification.

3. **Benchmark results** — 94.87% on LongMemEval with GPT-5-mini is impressive, outperforming Oracle baseline (82.4%) and prior SOTA (80.7%). The system genuinely works.

4. **Async buffering** — Pre-computing observations in the background prevents mid-conversation blocking. The buffer/activate/block-after threshold system is well-engineered.

5. **Priority tagging** — The 🔴/🟡/🟢 system gives the Reflector clear pruning signals. This is more principled than treating all observations equally.

6. **Working memory separation** — Cleanly separating "user facts" (working memory) from "session history" (observations) is a good abstraction.

### Weaknesses

1. **No search** — OM's biggest bet is also its biggest risk. If the Reflector garbage-collects an observation, it's gone permanently. There's no way to recover it. For claude-mem's use case (cross-session architectural memory for coding), this is unacceptable — you need to search months of history, not just what fits in context.

2. **Claude models don't work** — The Observer/Reflector agents specifically fail with Claude models. This is a significant compatibility gap for a Claude Code plugin.

3. **No privacy controls** — "The memory system does not enforce access control." For a system that persists user conversations, this is a serious gap. claude-mem's `<private>` tag stripping is significantly more mature.

4. **Lossy compression** — The Reflector's garbage collection is permanent. No audit trail, no recovery. For development work where a decision made 3 months ago matters, this is problematic.

5. **No search UI** — No viewer, no way to inspect what the system remembers. claude-mem's React viewer with search, filters, and analytics is a major usability advantage.

6. **In-process only** — Mastra memory runs inside your agent process. claude-mem's out-of-process worker allows persistence and viewer access independent of Claude Code sessions.

7. **Token threshold assumption** — The 30K/40K token thresholds assume long, continuous conversations. Claude Code sessions are typically shorter but more numerous. The per-session compression in claude-mem is better suited to this interaction pattern.

---

## 4. What claude-mem Can Learn From Mastra

### High Value — Should Implement

#### 4.1 Priority Tagging for Observations

**Mastra's approach**: 🔴 (critical) / 🟡 (maybe important) / 🟢 (informational)
**claude-mem opportunity**: Add a `priority` field to observations (e.g., `critical`, `important`, `informational`).

**Benefits:**
- Context injection can prioritize high-priority observations when token budget is limited
- The viewer can filter/sort by priority
- Summary generation can weight important observations higher
- Stale observation pruning can target low-priority items first

**Implementation**: Modify the SDK compression prompt to emit a priority tag. Add `priority TEXT DEFAULT 'informational'` column to observations table. Use priority weighting in context injection token budgeting.

#### 4.2 Temporal Anchoring (Referenced Date)

**Mastra's approach**: Each observation has both a creation date AND a referenced date (when the event actually occurred).
**claude-mem opportunity**: Add `referenced_at` to observations for events that refer to past or future dates.

**Example**: "User said the deploy is scheduled for March 15th" — the observation is created today but references March 15th. This enables temporal queries like "what's happening next week?"

**Implementation**: Modify the SDK prompt to extract referenced dates. Add `referenced_at_epoch INTEGER` column. Use in timeline queries and context injection.

#### 4.3 Explicit State Change Tracking

**Mastra's approach**: Observer notes "User switched from A to B" — explicitly superseding prior information.
**claude-mem opportunity**: Currently, when a user changes a decision, both the old and new observations exist with no relationship between them. This causes stale context injection.

**Implementation**: Add a `supersedes_id INTEGER REFERENCES observations(id)` column. When the SDK detects a state change, link the new observation to the old one. Context injection skips superseded observations.

#### 4.4 Working Memory Concept

**Mastra's approach**: Structured scratchpad (Zod schema or Markdown) persisted per-user or per-thread, always in context.
**claude-mem opportunity**: Currently, claude-mem treats all observations equally. A "working memory" layer for stable project facts (tech stack, key decisions, team preferences) would reduce redundant re-injection.

**Implementation**: A small `working_memory` table with per-project key-value entries that are always injected first, before search-based observations. Updated by the agent or manually via the viewer.

### Medium Value — Consider

#### 4.5 Prompt Caching Alignment

**Mastra's approach**: Observations form a stable, append-only prefix → prompt caching gives 4-10x cost reduction.
**claude-mem opportunity**: Context injection currently generates dynamic content per session. If the observation block were structured as a stable prefix that only changes when new observations are added, prompt caching would apply.

**Caveat**: Claude Code hooks inject context via `additionalContext` in the system prompt. Whether Anthropic's prompt caching applies to hook-injected context depends on the Claude Code implementation — this needs investigation.

**Implementation**: Structure context injection as: `[stable project observations prefix] + [session-specific recent context]`. The stable prefix gets cached across tool calls within a session.

#### 4.6 Async Observation Buffering

**Mastra's approach**: Pre-compute observations in the background before thresholds are hit.
**claude-mem opportunity**: Currently, each PostToolUse enqueues an observation and the SDK processes it eventually. If observation processing is slow (e.g., during high-volume sessions), the queue grows. Pre-computation or batching could smooth this.

**Implementation**: Instead of per-tool-call SDK invocations, batch observations in configurable windows (e.g., every 5 minutes or every N observations). Process the batch in a single SDK call for better compression ratios.

#### 4.7 Configurable Token Budgets

**Mastra's approach**: Explicit thresholds for when to trigger compression and reflection.
**claude-mem opportunity**: The `effort` setting controls observation detail level, but there's no explicit token budget for context injection. Adding configurable limits (e.g., "inject at most 4,000 tokens of context") would give users more control.

**Implementation**: Add `contextInjection.maxTokens` to settings. Token-count observations during injection and stop when budget is reached. Priority tagging (4.1) makes this more effective — inject highest priority first.

### Low Value — Not Applicable

#### 4.8 Eliminate Vector Search (Mastra's Core Bet)

**Not recommended for claude-mem.** Mastra's "no search" approach works for continuous conversations within a single agent run. claude-mem's use case is fundamentally different — searching across months of sessions, multiple projects, and diverse topics. The hybrid BM25 + ChromaDB search is a core strength, not a problem to solve.

#### 4.9 Two-Stage Compression (Observer + Reflector)

**Not recommended.** Mastra needs this because observations accumulate in-context until reflection prunes them. claude-mem observations are stored in SQLite and selectively retrieved — there's no context bloat problem. Adding a Reflector would add complexity for minimal benefit.

#### 4.10 Resource Scope (Cross-User Memory)

**Not applicable.** Claude Code is inherently single-user. The project scope in claude-mem already provides cross-session memory within a project.

---

## 5. Suggested Implementation Roadmap

### Phase 1: Priority Tagging (Low effort, high impact)

1. Add `priority` column to observations table (migration)
2. Update SDK compression prompt to emit `<priority>critical|important|informational</priority>`
3. Update XML parser to extract priority
4. Update context injection to sort by priority within time windows
5. Update viewer to show priority badges and filter by priority

### Phase 2: Working Memory (Medium effort, high impact)

1. New `working_memory` table: `project TEXT, key TEXT, value TEXT, updated_at INTEGER`
2. API endpoints: GET/PUT/DELETE `/api/working-memory/:project`
3. Context injection: always inject working memory before search results
4. Viewer: dedicated "Working Memory" panel per project
5. SDK prompt update: extract stable facts into working memory

### Phase 3: Temporal Anchoring (Low effort, medium impact)

1. Add `referenced_at_epoch` column to observations
2. Update SDK prompt to extract referenced dates
3. Update timeline queries to use referenced dates
4. Update viewer to show temporal references

### Phase 4: State Change Tracking (Medium effort, medium impact)

1. Add `supersedes_id` column to observations
2. Update SDK prompt to detect state changes and link to prior observations
3. Context injection skips superseded observations
4. Viewer shows superseded chain

---

## 6. Summary

| Mastra Concept | Applicability to claude-mem | Priority |
|----------------|----------------------------|----------|
| Priority tagging (🔴/🟡/🟢) | **HIGH** — enables smarter pruning and injection | P0 |
| Working memory (structured scratchpad) | **HIGH** — reduces redundant re-injection | P1 |
| Temporal anchoring (referenced dates) | **MEDIUM** — better timeline queries | P2 |
| State change tracking (supersedes) | **MEDIUM** — prevents stale context | P2 |
| Prompt caching alignment | **MEDIUM** — needs Claude Code investigation | P2 |
| Async buffering / batching | **LOW** — current per-observation model works for short sessions | P3 |
| Token budget config | **LOW** — effort setting covers most needs | P3 |
| No vector search | **NOT APPLICABLE** — cross-session search is a core strength | N/A |
| Two-stage compression | **NOT APPLICABLE** — no context bloat problem | N/A |
| Resource scope | **NOT APPLICABLE** — single-user system | N/A |

**Bottom line:** Mastra's OM is an impressive system optimized for long, continuous agent sessions. claude-mem serves a fundamentally different use case (cross-session coding memory with search). The most transferable ideas are priority tagging, working memory, and temporal anchoring — all of which would improve claude-mem's context injection quality without requiring architectural changes to the search system.
