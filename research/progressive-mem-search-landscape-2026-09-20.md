# Progressive / Cascading AI Memory Search: Competitive Landscape

**Date:** 2026-09-20  
**Scope:** Whether agent-memory / RAG-for-agents products implement *progressive / cascading retrieval* (cheap outline / index → expand by ID → deep-fetch only when needed) versus one-shot top-k dump or full-doc inject.  
**Baseline:** claude-mem / CMEM `mem-search` + Smart Explore.  
**Method:** Public docs, source, papers, and GitHub/npm discovery. Marketing copy treated as a claim, not evidence. Retrieval *architecture* judged from APIs, tool schemas, and (where available) source — not from “token-efficient” slogans.

---

## 1. Executive take: is Alex’s hypothesis largely true?

**Mostly yes for the established memory-API market. No as an absolute “nobody else does this.”**

The products that *own the category name* — Mem0, Zep/Graphiti, SuperMemory, Cognee, Memary, Hindsight’s default `recall()`, LangMem, consumer ChatGPT / Claude / Gemini memory — do **not** implement agent-controlled outline → expand → deep-fetch. They optimize *ranking* (hybrid semantic + BM25 + graph + temporal), then **compose a prompt-ready block** (or return full memory text for top-k). That is the industry default.

What *has* been clocked, mostly in 2025–2026 and mostly in the **coding-agent / skills / markdown-knowledge** niche rather than memory SaaS:

| Who clocked it | What they clocked | Same as claude-mem? |
|---|---|---|
| [Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | Progressive disclosure for *skills* (name+description → SKILL.md → linked files) | Related pattern, different surface |
| [Zilliz memsearch](https://zilliztech.github.io/memsearch/design-philosophy/) | Explicit L1 search → L2 expand → L3 transcript; they [compare themselves to claude-mem](https://zilliztech.github.io/memsearch/platforms/claude-code/) | Closest shipped peer |
| [OKF Agent Memory](https://github.com/okf-memory/okf-agent-memory) | `index.md` / `okf_search` snippets → `okf_show` / `read_concept` | Closest *knowledge-bundle* peer |
| [Bonsai Memory](https://github.com/felixsim/bonsai-memory) | Slim trunk index on boot, domain files on demand | Progressive *boot*, not mem-search |
| [Hermes-agent #59576](https://github.com/NousResearch/hermes-agent/issues/59576) | Proposed three-tier memory; **explicitly cites Claude-Mem** | Unshipped copy of the idea |
| [xMemory, arXiv 2602.02007](https://arxiv.org/pdf/2602.02007) | Top-down groups → expand raw messages when uncertainty is high | Closest *paper* |
| [Ratel](https://github.com/ratel-ai/ratel) | Search capabilities → load skill/tool body on demand | Progressive for *tools*, not memories |

**So the honest version of the hypothesis:**

> The default agent-memory stack still dumps ranked facts. Agent-controlled, cost-visible, ID-gated cascading retrieval is *not* how Mem0/Zep/SuperMemory/Letta archival search work. A handful of coding-agent plugins (memsearch, OKF) and Anthropic’s *skills* system have independently landed on the same information-architecture idea. The industry has started to name it; it has not made it the default memory API.

claude-mem’s remaining white space is not “we invented progressive disclosure.” It is: **observation-granular session memory** (every tool use compressed, typed, dated, priced) **plus** a forced 3-layer (now 4-layer) search contract **plus** Smart Explore for *live code* (search / outline / unfold) with published A/B multiples. That combination is still rare.

---

## 2. What “progressive / cascading” means here

Used as a **strict test**, not a vibe:

1. **Layer 1 — Outline / index:** cheap hit list (IDs, titles, types, dates, *retrieval cost*). Agent can refuse to fetch.
2. **Layer 2 — Expand:** fetch summaries / neighborhood / timeline for *selected IDs*.
3. **Layer 3 — Deep fetch:** full observation / section / raw evidence only after the agent filters.

**Not enough to count as “yes”:**

- Hybrid ranking that still returns full memory text (Mem0 v3, Zep auto-search).
- Hierarchical *storage* (core vs archival, user vs session) if search still dumps passages.
- Pagination / `top_k` / token budgets that still inject the selected full items.
- Skills progressive disclosure (unrelated surface).
- An Explore *subagent* that hides intermediate tokens from the parent (context isolation ≠ priced index).

**claude-mem baseline** (docs, not marketing):

- SessionStart injects a compact observation **index** with IDs, types, titles, token counts — not full history.  
  Source: [docs.claude-mem.ai/progressive-disclosure](https://docs.claude-mem.ai/progressive-disclosure)
- Search workflow: `search` → `timeline` → `get_observations` → (rare) `get_tool_uses` for raw tool I/O.  
  Source: [docs.claude-mem.ai/architecture/search-architecture](https://docs.claude-mem.ai/architecture/search-architecture)
- Claimed **~10×** token savings vs fetching full observations up front (workflow math, not an independent third-party eval).
- **Smart Explore** (`smart_search` / `smart_outline` / `smart_unfold`) vs naive Glob/Grep/Read: published A/B on this repo — **17.8×** discovery, **19.4×** targeted reads, **~10–12×** end-to-end.  
  Source: [docs.claude-mem.ai/smart-explore-benchmark](https://docs.claude-mem.ai/smart-explore-benchmark)

---

## 3. Comparison table

| Product | Retrieval pattern | Progressive? | Evidence | Notes |
|---|---|---|---|---|
| **claude-mem / CMEM** | Index (IDs, titles, types, token costs) → timeline → `get_observations` → optional raw `get_tool_uses`. Parallel Smart Explore for live code. | **Yes** | [Progressive disclosure](https://docs.claude-mem.ai/progressive-disclosure), [search architecture](https://docs.claude-mem.ai/architecture/search-architecture), [Smart Explore benchmark](https://docs.claude-mem.ai/smart-explore-benchmark) | Baseline. Cost-visible index is the distinctive UX. 10× search claim is first-party workflow math; Smart Explore multiples are a documented A/B on this codebase. |
| **Mem0** | Hybrid semantic + BM25 + entity + temporal → fused **top-k full memories**. Layers = *scope* (conversation / session / user / org), merged into prompt. | **No** | [Search memories (v3)](https://docs.mem0.ai/api-reference/memory/search-memories), [memory types](https://docs.mem0.ai/core-concepts/memory-types), [architecture.md](https://github.com/mem0ai/mem0/blob/HEAD/integrations/mem0-plugin/skills/mem0/references/architecture.md) | Best-in-class *ranking*, then dump. Example app code concatenates search hits into `context`. Cloud MCP adds `get_memory(id)` ([mem0-mcp.mdx](https://github.com/mem0ai/mem0/blob/3e6ab394/docs/platform/mem0-mcp.mdx)) but default path is `search_memories` returning content. |
| **OpenMemory MCP** (Mem0 local) | `search_memory` / `list_memories` return stored memory objects. | **No** | [Introducing OpenMemory MCP](https://mem0.ai/blog/introducing-openmemory-mcp) | Four tools: add / search / list / delete. Search is semantic top-k, not outline-then-fetch. |
| **Zep** | Graph search (semantic + BM25 + optional BFS) → **compose a single `context` string** sized to a character budget. `scope=auto` searches facts/nodes/episodes/observations/thread summaries in one call. | **No** | [Searching the graph](https://help.getzep.com/searching-the-graph.mdx), [arXiv 2501.13956](https://arxiv.org/pdf/2501.13956) | Paper literally defines retrieval as \(f: query \rightarrow prompt-ready context\). Opposite of agent foraging. `return_raw_results` is for debugging rank, not a second disclosure layer. |
| **Graphiti** (Zep OSS engine) | Concurrent BM25 + vector + BFS → RRF/MMR/cross-encoder → `search_results_to_context_string()`. | **No** | [Graphiti searching](https://help.getzep.com/graphiti/working-with-data/searching.mdx) | Configurable *search methods*, not disclosure layers. Context string is the product. |
| **SuperMemory** | One `search()` call; `searchMode` = memories / documents / hybrid. Optional `include` extras (documents, summaries, related, forgotten) and rerank/rewrite. | **No** (include flags = **partial-ish**) | [Recall search](https://supermemory.ai/docs/recall/search), [query rewriting](https://supermemory.ai/docs/memory-api/features/query-rewriting) | Still one-shot. `include` is “opt into more payload on the same request,” not agent-picked IDs after seeing an index. |
| **Letta / MemGPT** | Core memory blocks **always in context**. Archival + conversation search are on-demand tools that return **full passage `content`**. | **Partial** | [Archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory/index.md), [passage search API](https://docs.letta.com/api/typescript/resources/agents/subresources/passages/methods/search/), [MemGPT writeup](https://www.leoniemonigatti.com/blog/memgpt.html) | Hierarchical *storage* (RAM vs disk) is real and important. It is **not** outline→expand. `archival_memory_search` dumps matching passages. Paging exists; an index-of-titles does not. |
| **Cognee** | `recall()` auto-routes to GRAPH/RAG/SUMMARIES/AGENTIC completion; typically retrieve subgraph/chunks then LLM-complete. | **No** for memory; **partial** for skills | [Search basics](https://docs.cognee.ai/guides/search-basics), [recall](https://docs.cognee.ai/core-concepts/main-operations/recall), [agentic_retriever.py](https://github.com/topoteretes/cognee/blob/a22320c9/cognee/modules/retrieval/agentic_retriever.py) | Source comment: skill *procedure bodies* use progressive disclosure (`load_skill`). Memory triplets/context are retrieved and formatted in one pass. Escalating `GRAPH_COMPLETION` → COT is cost escalation, not ID-gated fetch. |
| **Memary** | LlamaIndex `KnowledgeGraphRAGRetriever`: extract entities → 2-hop subgraph → **build context** → answer. Web fallback if KG miss. | **No** | [README](https://github.com/kingjulio8238/Memary/blob/main/README.md), [concepts](https://kingjulio8238.github.io/memarydocs/concepts/) | “Recursive retrieval” = graph expansion *inside one query*, then dump the subgraph. Not agent-visible outline. |
| **Hindsight** | 4-arm recall (semantic, BM25, graph, temporal) → RRF + rerank → ranked **structured facts**. `include_chunks` / `include_source_facts` opt-in. | **Partial** | [Recall API](https://hindsight.vectorize.io/developer/api/recall), [retrieval](https://hindsight.vectorize.io/developer/retrieval) | Best “smarter dump.” Token *budget* + optional source expansion. Agent does not scan a priced index of IDs first. `list_memories` is admin listing, not the recall path. |
| **LangMem** | `create_search_memory_tool` / store search: embed query → similar memories (full entries). | **No** | [langmem README](https://github.com/langchain-ai/langmem), [API ref](https://langchain-ai.github.io/langmem/reference/memory/) | Hot-path search returns memories. Background manager also retrieves then writes. Library, not a disclosure protocol. |
| **Cursor Memories** | Small saved facts the agent (or auto-generate) writes; surfaced from Settings → Rules. Public docs on *how* they are retrieved are thin / missing. | **No** (as documented) | [Forum: memories](https://forum.cursor.com/t/about-cursors-memory-record-feature/107355), [Rules vs Memories](https://forum.cursor.com/t/best-way-to-provide-context-rules-vs-memories/132960), [Cloud automations MEMORIES.md](https://cursor.com/docs/cloud-agent/automations) | Official memories page is not a durable public spec (docs URL currently resolves to the generic docs hub). Behavior looks like ChatGPT-style saved facts, not cascading search. Automations persist a `MEMORIES.md` file (flat inject). |
| **Cursor Notepads** | Reusable notes **always included** on AI requests. **Deprecated** (superseded by Rules / Memories / Commands). | **No** | [Deprecating Notepads](https://forum.cursor.com/t/deprecating-notepads-in-cursor/138305) | Staff note: always-included notes were a token problem. Replacement is more fine-grained — still not outline→fetch memory search. |
| **Cursor Rules** | `alwaysApply` = inject; globs = attach when files in context; **description-only** = agent reads description and pulls when relevant. | **Partial** (instructions, not memory) | [cursor.com/docs/rules](https://cursor.com/docs/rules) | Same IA as skills: metadata first, body on demand. Not session-memory search. |
| **Cursor codebase retrieval** | Instant Grep + Read; optional Explore **subagent** that searches in a forked window and returns a summary. Historical semantic index; staff have said newer builds lean on grep + reads. | **Partial** (code, not memory) | [Agent search](https://cursor.com/docs/agent/tools/search), [Understanding your codebase](https://cursor.com/learn/understanding-your-codebase), [semsearch blog](https://cursor.com/blog/semsearch), [forum on index change](https://forum.cursor.com/t/codebase-indexing-not-working-in-v-3-12-onwards/167527) | Agentic read loop, not a priced outline. Explore subagent = context isolation (same idea memsearch uses). No public outline→unfold contract like Smart Explore. |
| **ChatGPT Memory** | Saved memories + “reference chat history.” System retrieves/synthesizes and **applies** to the next reply. Memory summary is a high-level view, not a searchable archive. | **No** | [Memory + controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/), [Memory FAQ](https://help.openai.com/en/articles/8590148) | User-facing personalization, not agent-foraging. Retrieval algorithm unpublished. Treat tertiary “Dreaming V3” writeups as unverified. |
| **Claude Projects / Memory** | (1) Project knowledge: files + instructions; RAG when near context limit. (2) Memory: topic list injected into later chats. (3) **Chat search**: RAG tool that “pulls together the appropriate context.” | **No** (chat search = **partial-ish** RAG tool) | [Chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects) | Memory is a curated topic store. Chat search is one-shot RAG with citations — not an ID index the model expands. Project knowledge is closer to “inject until full, then RAG.” |
| **Gemini memory** | Past-chat personalization + connected apps. Can show “Previous chats” as a source. Cloud **Memory Bank**: extract → similarity search → **insert into prompt**. | **No** | [Gemini past-chat memory](https://support.google.com/gemini/answer/16598469), [Memory Bank](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank) | Memory Bank explicitly: retrieve all *or* similarity top-k, then insert. Consumer product does not expose outline→fetch. |
| **DeusData / codebase-memory-mcp** | Graph tools: `search_graph` / `semantic_query` → `get_code_snippet` / `trace_path`. Scout / Verify / Auditor are **verification tiers**, not disclosure layers. | **Partial** (code graph) | [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md), [site](https://deusdata.github.io/codebase-memory-mcp/) | Search-then-snippet is outline-ish for *symbols*. Not session memory. Verification tiers are about claim strength. |
| **arXiv 2603.27277 (Codebase-Memory)** | Tree-sitter KG + 14 MCP structural tools vs file-explore agent. | **Partial** (code, paper) | [arXiv 2603.27277](https://arxiv.org/abs/2603.27277v1) | **Not** conversational mem-search. Reports ~10× fewer tokens / 2.1× fewer tool calls vs file explorer at 83% vs 92% quality. Peer of Smart Explore / DeusData, not Mem0. |
| **Zilliz memsearch** | L1 `search` (chunk snippets + hash) → L2 `expand <chunk_hash>` (full markdown section) → L3 transcript. Claude Code plugin runs this in a **forked subagent**. | **Yes** | [Design philosophy](https://zilliztech.github.io/memsearch/design-philosophy/), [memory-recall](https://zilliztech.github.io/memsearch/platforms/claude-code/memory-recall/), [ccplugin README](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md), [npm memsearch-core](https://www.npmjs.com/package/memsearch-core) | **Closest shipped peer.** They name claude-mem and argue forked-subagent + markdown-source-of-truth vs MCP-in-main-context + SQLite. L1 is *snippets*, not a cost-visible typed observation table. Capture is session-end Haiku summary, not per-tool-use observations. |
| **OKF Agent Memory** | Dual memory: tiny always-on AGENTS.md “codex” + 0-token `knowledge/` bundle. `okf_search` (BM25 snippets) → `okf_show` / `read_concept`. Hierarchical `index.md`. | **Yes** | [README](https://github.com/okf-memory/okf-agent-memory), [okf-memory.dev](https://okf-memory.dev/), [okf-gem search skill](https://okfgem.com/docs/skill/search/) | Closest *knowledge-bundle* peer. Progressive disclosure of authored concepts, not auto-captured coding-session observations. Created 2026-09; claims 80% token cut vs monolith docs. Treat latency/token tables vs Mem0/Letta as vendor bench. |
| **Bonsai Memory** | Replace flat `MEMORY.md` with trunk index (~400 tokens) → domain `_index.md` → leaf files. Optional semantic search over leaves. | **Partial** (boot hierarchy) | [README](https://github.com/felixsim/bonsai-memory) | Solves *always-inject MEMORY.md*, not query-time mem-search. Token estimates on index. 30 GitHub stars; OpenClaw-oriented. |
| **Ratel** | `search_capabilities` over tool/skill catalogs → `get_skill_content` / `invoke_tool` by id. | **Partial** (tools/skills) | [README](https://github.com/ratel-ai/ratel), [docs.ratel.sh](https://docs.ratel.sh) | Anthropic-skills pattern as a product. Memory “facts” are always-pushed constants, not cascading observations. |
| **mcp-structured-memory** | `list_memories` → `get_memory_summary` → `get_section` → `get_full_memory`. | **Yes** (docs/notebooks) | [fastmcp-me/mcp-structured-memory](https://github.com/fastmcp-me/mcp-structured-memory) | Living markdown notebooks, not auto session memory. Pattern match is strong; product scale is small. |
| **mcp-memory-server** (jordan23wagner) | Vector search returns **summaries by default**; `include_full_text=true` for originals. | **Partial** | [README](https://github.com/jordan23wagner-ops/mcp-memory-server) | One toggle, not a three-layer ID workflow. Honest token-saving default. |
| **Hermes-agent (proposal)** | Proposed: always-on essentials + injected **index with token costs** + `memory_fetch(entry_id)`. | **Yes (unshipped)** | [Issue #59576](https://github.com/NousResearch/hermes-agent/issues/59576) | Cites MemGPT **and Claude-Mem**. Review notes say a partial PR hid tier-2 memories without a fetch path. Evidence the idea is spreading by imitation. |
| **xMemory (paper)** | Hierarchy: messages → segments → components → groups. Retrieve groups first; expand to raw messages only if uncertainty remains. | **Yes (research)** | [arXiv 2602.02007](https://arxiv.org/pdf/2602.02007) | Closest academic formulation of outline-then-detail for *conversational* memory. Not a shipping coding-agent product. |
| **AgentIR (paper)** | Confidence cascade: skip dense retrieval when BM25 margin is high. | **No** (wrong axis) | [arXiv 2605.25092](https://arxiv.org/abs/2605.25092) | Cascade is **latency/compute** (BM25 vs dense), not token disclosure to the agent. |
| **Anthropic Agent Skills** | Startup: name + description only. On trigger: read SKILL.md. Then linked files. | **Yes** (skills) | [Engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), [platform docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Industry-standard *name* for the pattern. Claude.ai memory still does not use this for chat history. Implementation bugs have loaded full skills at startup ([#15286](https://github.com/anthropics/claude-code/issues/15286)). |
| **Claude Code native memory** | `CLAUDE.md` + small auto-memory files loaded at session start. | **No** | memsearch’s comparison (adversarial but consistent with public behavior): [memsearch vs native](https://zilliztech.github.io/memsearch/platforms/claude-code/) | Monolith / recency inject. No search. This is the failure mode claude-mem and memsearch both sell against. |

---

## 4. Closest peers / near-misses

### 4.1 True peers (yes)

**1. Zilliz memsearch — closest product peer**

Shipped 3-layer recall: snippet search → expand section by `chunk_hash` → original transcript. Claude Code integration runs the cascade inside `context: fork` so the parent only sees a curated summary.

They have already productized a comparison with claude-mem ([platform overview](https://zilliztech.github.io/memsearch/platforms/claude-code/)):

| They emphasize | claude-mem counter |
|---|---|
| Forked subagent keeps intermediates out of main context | MCP tools give the *main* agent agency and a visible audit trail; skill+HTTP path also exists |
| Markdown as source of truth, Milvus as rebuildable index | SQLite + typed observations is queryable (type, file, concept, branch) in ways daily `.md` logs are not |
| Hybrid dense + BM25 + RRF in one engine | FTS5 + optional Chroma; not the same fused hybrid |
| Session-end Haiku summary | Per-`PostToolUse` observation compression — finer grain, more write cost |

**Do not dismiss them.** If an investor asks “does anyone else do cascading memory,” the honest answer is “memsearch, yes — different storage philosophy, weaker observation model.”

**2. OKF Agent Memory — closest knowledge-bundle peer**

`okf_search` then `okf_show` / `read_concept`, plus hierarchical `index.md`. Dual-memory: a 100–150 token always-on *codex* and a 0-token pull corpus. This is progressive disclosure of **authored knowledge**, not auto-captured tool traces. Created September 2026; already marketing “progressive disclosure” against Mem0/Letta.

**3. mcp-structured-memory**

Textbook tool split: list → summary → section → full. Domain is living project notebooks (travel, research), not coding-session telemetry.

### 4.2 Near-misses (partial)

| Near-miss | Why it looks similar | Why it is not the same |
|---|---|---|
| **Letta / MemGPT** | Agent *decides when* to page archival memory | Search returns full passages; no cheap title index |
| **Hindsight** | Facts vs optional source chunks; token budget | One `recall()`; ranking-then-dump |
| **Bonsai Memory** | Index on boot, files on demand | Fixes MEMORY.md bloat, not query-time search |
| **Ratel / Agent Skills** | Catalog stub → load body | Tools/skills, not observations |
| **Cursor Rules (description)** | Agent pulls by metadata | Instruction files, tiny N |
| **Cursor Explore subagent** | Hide intermediate reads from parent | Subagent still greps/reads; no priced outline |
| **SuperMemory `include`** | Extra context is opt-in | Same request, not ID cascade |
| **DeusData / 2603.27277** | Graph first, snippet by qualified name | Code intelligence, not session memory |
| **Cognee `load_skill`** | Progressive skill bodies | Memory path is graph/RAG complete |
| **mcp-memory-server** | Summary default | Boolean, not layered IDs |

### 4.3 Academic / proposed

- **xMemory ([2602.02007](https://arxiv.org/pdf/2602.02007)):** “decoupling before aggregation” + uncertainty-gated expansion to raw messages. Cite as the research rhyme; it is not a competitor in the Claude Code plugin market.
- **Hermes #59576:** the cleanest evidence that claude-mem’s *wording* (index + token cost + `memory_fetch`) is being copied.
- **AgentIR ([2605.25092](https://arxiv.org/abs/2605.25092)):** do not cite as a peer. Wrong cascade (IR latency).

### 4.4 GitHub / npm sweep (2026-09-20)

GitHub repo search for `progressive disclosure memory agent` is no longer empty. Notable hits beyond the table:

- [okf-memory/okf-agent-memory](https://github.com/okf-memory/okf-agent-memory) — 707★, Sept 2026  
- [ratel-ai/ratel](https://github.com/ratel-ai/ratel) — 441★  
- [felixsim/bonsai-memory](https://github.com/felixsim/bonsai-memory) — 30★  
- [lxgicstudios/progressive-memory](https://github.com/lxgicstudios/progressive-memory) — 2★, tagline “scan index first, fetch details on demand”  
- [kjaylee/openclaw-mem](https://github.com/kjaylee/openclaw-mem) — 2★, “Progressive Disclosure, 3-Layer Archive”

Code search for `"get_observations" mem-search` still overwhelmingly hits **this repo** (`thedotmack/claude-mem`). The *workflow names* have not been copied; the *philosophy words* have.

npm: [memsearch-core](https://www.npmjs.com/package/memsearch-core) is the TypeScript library under Zilliz memsearch. No crowded “mem-search” package category.

---

## 5. Gaps / white space for claude-mem messaging

**Own this (true, and under-claimed by peers):**

1. **Observation-level capture.** Most “memory” products store user facts, session summaries, or daily markdown. claude-mem stores *what the coding agent did* (tool use → compressed observation → optional raw evidence). That is a different object than Mem0’s “Alice is vegetarian.”
2. **Cost-visible index.** Token counts on every row. memsearch L1 is snippets; OKF indexes concepts; almost nobody prints retrieval *price* next to the title. This is the forager interface.
3. **Forced filter-before-fetch.** `get_observations` requires IDs. The tool schema makes the anti-pattern (fetch 20 full records) awkward. Letta/Mem0 make the dump the easy path.
4. **Four depths, including raw evidence.** Index → timeline → observation → `tool_uses`. memsearch’s L3 is the original chat transcript; claude-mem’s L4 is the literal tool I/O. Different, complementary, rare.
5. **Live code + past work as one philosophy.** Smart Explore (AST outline/unfold) is the same IA applied to the current tree. Published A/B vs Explore-agent Glob/Grep/Read. DeusData/2603.27277 compete on *code graphs*; they do not also do session memory.

**Do not own this (false or stale):**

- “We invented progressive disclosure.” Anthropic skills docs and Nielsen Norman got there first as IA; memsearch ships the same 3-layer slogan.
- “Nobody else does cascading retrieval.” memsearch and OKF do.
- “10× vs all RAG.” First-party workflow arithmetic vs a straw-man “fetch 20 full observations.” Fine as an *illustration*; not a third-party bake-off against Mem0/Zep/Hindsight on LongMemEval.
- Hybrid fused retrieval as a lead claim. Zep, Mem0 v3, SuperMemory, Hindsight, and memsearch all advertise denser hybrid stacks.

**Competitive risk:**

- memsearch is already in the same Claude Code marketplace conversation and will tell the story as “we do progressive disclosure *without* MCP tax.” Answer with observation granularity, typed search, timeline, raw tool evidence, and Smart Explore — not “they don’t get it.”
- OKF will tell the story as “git-native concepts, 80% fewer tokens than AGENTS.md monoliths.” Different job (authored knowledge vs captured work). Stay out of a false fight; partner-position: they store decisions you write, we store work the agent did.
- If Hermes (or others) ship `memory_index` + `memory_fetch`, the *wording* commoditizes. The dataset (observations + tool_uses + file-grouped index) is harder to copy.

**Unfair-to-claim gaps in *their* products (useful contrast, keep receipts):**

- Mem0/Zep/Hindsight optimize **answer quality on memory benchmarks**, not **agent token agency**. Different objective function.
- Consumer memories (ChatGPT, Claude, Gemini) optimize **personalization** and hide retrieval. The user cannot see a priced index.
- Cursor memories / deprecated notepads / `MEMORIES.md` are small-N facts or files, not a growing observation corpus with search layers.

---

## 6. Suggested investor / marketing claims (honest)

Stay inside evidence. Prefer these five; drop any that grow into “unique in the industry.”

1. **“The default memory API still dumps top-k facts. We give the agent a table of contents — IDs, types, and token prices — and make it buy the pages.”**  
   True against Mem0, Zep auto-search, SuperMemory, Hindsight `recall()`, ChatGPT/Claude/Gemini memory. Cite their search docs, not their homepages.

2. **“Filter-before-fetch is in the tool contract, not the prompt.”**  
   `search` returns ~50–100 tokens/row; `get_observations` requires IDs. First-party workflow math: ~10× vs fetching the same N observations in full ([search architecture](https://docs.claude-mem.ai/architecture/search-architecture)). Do not say “10× vs Mem0.”

3. **“Same idea for live code: outline, then unfold.”**  
   Smart Explore A/B on this repo: **17.8×** cheaper discovery, **19.4×** cheaper targeted reads, **~11×** end-to-end vs a Glob/Grep/Read Explore agent ([benchmark](https://docs.claude-mem.ai/smart-explore-benchmark)). Qualify: first-party, Opus 4.6, this codebase, Explore agent forbidden from using Smart tools.

4. **“We remember what the agent *did*, not just what the user *prefers*.”**  
   Per-tool-use observations + optional raw `tool_uses` vs Mem0/ChatGPT fact stores and memsearch’s end-of-session markdown summary. This is the product wedge, not the retrieval slogan.

5. **“Progressive disclosure is starting to show up in skills and a couple of coding-agent plugins. It is still not how the memory platforms retrieve.”**  
   Accurate as of 2026-09-20. Names the exception (memsearch, OKF) so the claim survives a skeptical associate.

**Avoid:**

- “Industry hasn’t clocked this” — they have, in skills and in memsearch/OKF/Hermes.
- “Only cascading memory product” — false.
- LongMemEval / BEAM crown — those boards belong to Hindsight/Zep-style systems unless you run the eval.

---

## 7. Methodology and limits

- Checked on **2026-09-20** via public docs, GitHub, npm, and arXiv. No vendor private APIs, no product accounts.
- Cursor Memories official docs were **not stably fetchable** (docs hub, not a memories spec). Classification uses forum + automations docs + Rules docs. Flag as low-confidence.
- ChatGPT “Dreaming V3” secondary articles were not treated as primary evidence.
- memsearch’s claude-mem comparison is **competitor copy** (MCP port, Chroma-only, etc. can lag this repo). Used for *their* architecture, not as a source of truth about claude-mem.
- GitHub `search_code` for `"progressive disclosure" memory agent` is extremely noisy (AGENTS.md boilerplate). Repo-metadata search was the useful signal.
- This file is research, not a promise that unpublished internals match public docs.

---

## 8. Source list (primary)

**claude-mem**

- https://docs.claude-mem.ai/progressive-disclosure
- https://docs.claude-mem.ai/architecture/search-architecture
- https://docs.claude-mem.ai/architecture/overview
- https://docs.claude-mem.ai/smart-explore-benchmark
- https://docs.claude-mem.ai/file-read-gate

**Memory platforms**

- https://docs.mem0.ai/api-reference/memory/search-memories
- https://docs.mem0.ai/core-concepts/memory-types
- https://docs.mem0.ai/core-concepts/memory-evaluation
- https://mem0.ai/blog/introducing-openmemory-mcp
- https://help.getzep.com/searching-the-graph.mdx
- https://help.getzep.com/graphiti/working-with-data/searching.mdx
- https://arxiv.org/pdf/2501.13956
- https://supermemory.ai/docs/recall/search
- https://docs.letta.com/v1-sdk/memory/archival-memory/index.md
- https://docs.cognee.ai/guides/search-basics
- https://github.com/kingjulio8238/Memary
- https://hindsight.vectorize.io/developer/api/recall
- https://github.com/langchain-ai/langmem

**Consumer / IDE**

- https://openai.com/index/memory-and-new-controls-for-chatgpt/
- https://help.openai.com/en/articles/8590148
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://support.google.com/gemini/answer/16598469
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank
- https://cursor.com/docs/rules
- https://cursor.com/docs/agent/tools/search
- https://cursor.com/learn/understanding-your-codebase
- https://forum.cursor.com/t/deprecating-notepads-in-cursor/138305

**Code / peers / papers**

- https://github.com/DeusData/codebase-memory-mcp
- https://arxiv.org/abs/2603.27277v1
- https://zilliztech.github.io/memsearch/design-philosophy/
- https://zilliztech.github.io/memsearch/platforms/claude-code/
- https://www.npmjs.com/package/memsearch-core
- https://github.com/okf-memory/okf-agent-memory
- https://github.com/felixsim/bonsai-memory
- https://github.com/ratel-ai/ratel
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://github.com/NousResearch/hermes-agent/issues/59576
- https://arxiv.org/pdf/2602.02007
- https://arxiv.org/abs/2605.25092
- https://github.com/fastmcp-me/mcp-structured-memory
