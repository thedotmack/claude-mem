# Zilliz memsearch vs claude-mem / CMEM

**Date:** 2026-09-20  
**Question:** Is [zilliztech/memsearch](https://github.com/zilliztech/memsearch) essentially “claude-mem but not broken / rebuilt with better decisions and cleaner code”? Does either product have “fork to memory” (git-like / branchable / forkable memory sessions)?  
**Method:** Cloned both repos (claude-mem `main` @ `4e98d977`, memsearch `main` @ `a1a6d09`), read READMEs + architecture/docs + retrieval/capture code paths, pulled GitHub metadata. Marketing copy treated as a claim.  
**Sibling note:** [research/progressive-mem-search-landscape-2026-09-20.md](https://github.com/thedotmack/claude-mem/pull/4151) already flagged memsearch as the closest *progressive-retrieval* peer. This file is the product-vs-product deep dive.

---

## Executive answer

**No. memsearch is not a rewrite, soft fork, or hard fork of claude-mem.** It is **convergent evolution** on the same retrieval IA (cheap hits → expand by ID → raw transcript), implemented in a different language, with a different capture object, a different source of truth, and an explicit OpenClaw lineage. They compare themselves to claude-mem in public docs and get several facts wrong or stale.

**On “cleaner / not broken”:** the *core engine* is genuinely smaller and tidier (≈6.8k LOC Python vs ≈83k LOC TypeScript `src/`). That is not the same as “claude-mem rebuilt correctly.” They did not rebuild observation-level capture, ID-gated MCP tools, Smart Explore, the worker/viewer, hosted sync, or the IDE surface area. They rebuilt **markdown journals + Milvus hybrid search + a forked-subagent skill**. Different product, overlapping slogan.

**On “fork to memory”:** **neither product has it.** memsearch’s “fork” is Claude Code `context: fork` (isolate *recall* from the parent chat). claude-mem designed *branch-scoped visibility* (hide sibling-branch observations) in #1246 / #2038 and closed it `not_planned`. No git-like fork/clone of memory state, no parallel timelines, no “fork this session into a memory branch” API exists in either repo.

**Blunt take for Alex:** do not treat memsearch as the clean rewrite you wish you’d written. Steal what is actually better (markdown-canonical files, fused hybrid search, `context: fork` recall, skills-from-memory). Keep what they cannot copy cheaply (typed observations, priced index, forced ID fetch, L4 tool I/O, Smart Explore, ecosystem). Their comparison page will be used against you; several cells are false.

---

## Relationship (what it is / is not)

| Label | Verdict | Evidence |
|---|---|---|
| Same idea | **Partial** | Same *problem*: coding-agent memory with progressive recall. Different *object stored*. |
| Convergent evolution | **Yes** | memsearch created 2026-02-09; claude-mem created 2025-08-31. memsearch docs say “Inspired by OpenClaw,” not claude-mem. Python vs TypeScript. No shared git history. |
| Soft fork / hard fork | **No** | Different license (MIT vs Apache-2.0), org, language, storage, capture path. `search_code` for claude-mem identifiers in memsearch only hits their *comparison docs*. |
| Cleaner rebuild of *progressive mem-search* | **Yes, of the retrieval slogan; no, of the product** | They ship L1 `search` → L2 `expand <chunk_hash>` → L3 `transcript`. They did not ship observation compression, typed index, timeline, or Smart Explore. |
| “claude-mem but not broken” | **No** | memsearch is pre-1.0 (`0.4.20`), 35 open issues + **220 open PRs**, and their own comparison table is stale. Cleaner *core* ≠ healthier *product*. |

Primary sources:

- https://github.com/zilliztech/memsearch
- https://github.com/thedotmack/claude-mem
- https://zilliztech.github.io/memsearch/design-philosophy/
- https://zilliztech.github.io/memsearch/home/comparison/
- https://zilliztech.github.io/memsearch/platforms/claude-code/
- https://docs.claude-mem.ai/progressive-disclosure
- https://docs.claude-mem.ai/architecture/search-architecture

---

## Comparison table

| Axis | claude-mem / CMEM | Zilliz memsearch | Notes |
|---|---|---|---|
| **Created** | 2025-08-31 | 2026-02-09 | memsearch is ~5 months younger. |
| **Stars / forks (2026-09-20)** | 94,338 / 8,331 | 2,626 / 253 | Different scale. |
| **Release** | `13.25.2` (npm), Apache-2.0 | `0.4.20` (PyPI), MIT | memsearch still 0.x. |
| **Shape** | Claude Code / Cursor / OpenClaw / OpenCode / Codex / Grok Bot / Antigravity plugin + local worker + MCP + hosted CMEM Pro | Python CLI/library + native plugins (Claude Code, Codex, DSH, OpenClaw, OpenCode) | memsearch has no MCP server. claude-mem’s platform list is broader than memsearch’s comparison table admits. |
| **Target runtime** | Persistent Bun/Node **worker** (Express, SSE viewer) + MCP tools in the *main* conversation | `memsearch` CLI + hooks; Claude Code recall runs in a **forked skill subagent** | Architectural fork: agency-in-main-context vs hide-intermediates. |
| **Capture object** | Eligible **tool uses** → LLM-compressed **typed observations** + session summary + raw `tool_uses` | Last **conversation turn** → Haiku (or native) **bullet summary** appended to daily `.md` | This is the real product difference. |
| **What is stored** | SQLite rows: sessions, observations (title/narrative/facts/concepts/type/files), prompts, summaries, tool I/O | Daily markdown journals + optional `PROJECT.md` / `USER.md` + skill candidates; Milvus chunk index | memsearch: human-editable files. claude-mem: queryable structured records. |
| **Embeddings** | Optional Chroma; default model `all-MiniLM-L6-v2` (WASM/ONNX) | Required for search; default **ONNX bge-m3**; 8 providers | memsearch’s “pluggable embeddings” claim is fair. |
| **Keyword + dense** | FTS5 + optional Chroma, **application-side** hybrid | Dense + BM25 + **RRF inside Milvus** | Their “fused hybrid” claim is fair. |
| **Retrieval contract** | `search` (priced index) → `timeline` → `get_observations(ids)` → `get_tool_uses(ids)` | `memsearch search` (snippets + hash) → `expand <chunk_hash>` → `transcript` | Both progressive. Different Layer-1 shape. |
| **ID-gated?** | **Yes.** `get_observations` / `get_tool_uses` require IDs. | **Partial.** Expand is hash-gated; L1 already returns snippet *content*. | claude-mem L1 is cheaper and more forager-like. |
| **Cost-visible index** | Token counts on every row | Scores + snippets; no token prices | Distinctive claude-mem UX. |
| **SessionStart inject** | Compact observation **index** (IDs, types, titles, tokens) | Up to 40 lines from each of the 2 most recent daily logs + a “recall available” hint | memsearch injects prose; claude-mem injects a table of contents. |
| **Smart Explore** | `smart_search` / `smart_outline` / `smart_unfold` (AST) | None | Live-code progressive disclosure is unique to claude-mem. |
| **Storage** | `~/.claude-mem/claude-mem.db` (SQLite) + optional Chroma + hosted Postgres path | `.memsearch/memory/*.md` source of truth; `~/.memsearch/milvus.db` (Lite) or server/cloud | memsearch can drop Milvus and rebuild. |
| **Project scoping** | `project` column + `platformSource` filter | Per-project Milvus collection derived from path (`ms_claude_code_<project>`) | Both isolate by default. |
| **Multi-session** | First-class session rows + timeline across sessions | Session UUID anchors in HTML comments; daily files mix sessions | claude-mem’s timeline is a real L2; memsearch L2 is “same heading section.” |
| **Viewer / ops** | React viewer, worker API, cloud sync, export/import | File watcher, CLI `stats`/`reset`, optional DSH dock | Different ops surface. |
| **Procedural memory** | Skills in the plugin, not distilled from sessions | **Skills from memory** (candidates in `.memsearch/skill-candidates/`) | memsearch unique. |
| **Fork / branch memory** | Designed, **not shipped** (#1246 closed; #2038 `not_planned`) | **No.** “Fork” = `context: fork` recall. Markdown is git-diffable as a workaround. | See fork section. |

---

## Progressive search detail

### claude-mem (shipped)

Documented at [docs.claude-mem.ai/progressive-disclosure](https://docs.claude-mem.ai/progressive-disclosure) and implemented in [`src/servers/mcp-server.ts`](../src/servers/mcp-server.ts) + [`plugin/skills/mem-search/SKILL.md`](../plugin/skills/mem-search/SKILL.md).

| Layer | Tool | What the agent sees | Gate |
|---|---|---|---|
| L1 | `search` | Table: ID, time, type icon, title, **~token cost** (~50–100 tok/row) | Query + filters (`project`, `obs_type`, dates) |
| L2 | `timeline` | Chronological neighborhood around an observation ID | Anchor ID or query |
| L3 | `get_observations` | Full typed observation (narrative, facts, files, concepts) | **`ids` required** |
| L4 | `get_tool_uses` | Raw `tool_input` / `tool_response` (up to 64 KB/row) | **`ids` required** |

SessionStart already injects an L1-shaped index so the agent can fetch without searching. `important_workflow` is a permanent MCP tool that restates “never fetch full details without filtering first.”

Smart Explore is the **same IA on live code** ([`plugin/skills/smart-explore/SKILL.md`](../plugin/skills/smart-explore/SKILL.md), [benchmark](https://docs.claude-mem.ai/smart-explore-benchmark)): `smart_search` → `smart_outline` → `smart_unfold`. First-party A/B on this repo: 17.8× discovery / 19.4× targeted reads vs Glob/Grep/Read. memsearch has no analogue.

### memsearch (shipped)

Documented at [design-philosophy § Progressive Disclosure](https://zilliztech.github.io/memsearch/design-philosophy/) and implemented in [`src/memsearch/core.py`](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py) (`MemSearch.search`), [`src/memsearch/cli.py`](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/cli.py) (`expand`, `transcript`), and [`plugins/claude-code/skills/memory-recall/SKILL.md`](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/skills/memory-recall/SKILL.md).

| Layer | Command | What the agent sees | Gate |
|---|---|---|---|
| L1 | `memsearch search "<q>" --top-k 5 --json-output` | Ranked **chunk snippets** + `chunk_hash` + score | Query; optional `source_prefix` |
| L2 | `memsearch expand <chunk_hash>` | Full markdown heading section + session/transcript HTML anchor | Hash lookup in Milvus, then read the `.md` file |
| L3 | `memsearch transcript <jsonl> --turn <uuid>` | Original platform transcript (tool calls included) | Path from the L2 anchor |

On Claude Code, this cascade runs inside `context: fork` (`allowed-tools: Bash`). Only a curated summary is supposed to return to the parent. Codex/OpenCode/OpenClaw do **not** get that isolation (their own docs say so).

### Same slogan, different Layer 1

This is the comparison that matters:

- **claude-mem L1 is an index.** Titles + types + prices. The agent can refuse to spend. Content stays behind `ids`.
- **memsearch L1 is already a dump of snippets.** Progressive only in the sense that *more* text is behind expand/transcript. The first call already spends content tokens.
- **claude-mem L2 is narrative time** (what happened around this observation).
- **memsearch L2 is spatial** (the rest of this markdown section).
- **claude-mem L3/L4 are structured observations + raw tool I/O.**
- **memsearch L3 is the original chat transcript.** Complementary, not identical. Their L3 ≈ our L4’s *spirit* (unsummarized evidence), but the evidence is dialogue, not `tool_uses` rows.

memsearch’s public comparison table at [docs/home/comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md) marks claude-mem **❌** for “Progressive disclosure: search → expand → transcript.” That cell is **false**. Their own Claude Code plugin README contradicts it and admits claude-mem has a 3-layer skill+MCP path. Treat that table as competitor copy, not a source of truth about us.

Other stale cells in the same file (as of 2026-09-20 `main`):

- “claude-mem has no OpenCode / no Codex” — false. Repo description and `src/services/integrations/CodexCliInstaller.ts`, `npx claude-mem install --ide opencode`.
- “claude-mem search is Chroma dense-only, FTS5 not fused” — directionally fair for the local worker; they overstate uniqueness of hybrid.
- “claude-mem embedding is fixed MiniLM” — default is MiniLM; Chroma path is not a provider marketplace like theirs.

---

## Capture model (why they are not the same product)

### claude-mem

Pipeline from [docs/public/architecture/overview.mdx](../docs/public/architecture/overview.mdx):

1. `PostToolUse` → `hook claude-code observation` (every eligible tool call).
2. Worker queues the tool use; SDK/Gemini/OpenRouter compresses it into a **typed observation** (decision / bugfix / feature / refactor / discovery / change / security_alert / …).
3. `Stop` → session summary.
4. Raw bodies land in `tool_uses` for L4.
5. Next `SessionStart` injects a compact index, not the corpus.

This is expensive on the write path (one LLM call per observation, plus worker process) and is the thing Alex feels has accumulated slop. It is also the thing memsearch **did not rebuild**.

### memsearch

Claude Code path from [`plugins/claude-code/hooks/stop.sh`](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/hooks/stop.sh) + README:

1. `Stop` hook parses the **last turn** from the JSONL transcript.
2. One `claude -p --model haiku` (or routed provider) writes third-person bullets.
3. Append to `.memsearch/memory/YYYY-MM-DD.md` with  
   `<!-- session:UUID turn:UUID transcript:/path/to/session.jsonl -->`.
4. `memsearch index` / `watch` chunks headings, SHA-256 dedups, upserts to Milvus.

If summarization fails, they write a diagnostic marker and keep the transcript anchor. No per-tool-use observations. No types. No facts/concepts/files columns. Optional background jobs maintain `PROJECT.md` / `USER.md` and mine skill candidates.

**Write-path philosophy they advertise:** “append-only, no LLM curation that mutates past writes.” That is aimed at mem0/Letta, not at us — we also append. Their savings vs us is **fewer LLM writes** (1/turn vs 1/tool-use).

---

## Fork-to-memory

Alex’s framing: *fork/branch memory state — session fork, memory branch, parallel timelines, or explicit fork-into-memory from a chat/agent run.*

### memsearch: **no** (partial workaround only)

Searched `src/`, `docs/`, plugins for fork / branch / checkpoint / timeline / clone-memory.

What exists:

- **`context: fork`** on Claude Code skills (`memory-recall`, `memory-config`, `memory-to-skill`). This forks the *agent context window* for retrieval. It does **not** fork memory state. Codex explicitly cannot do it ([docs/platforms/codex/memory-recall.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/codex/memory-recall.md)).
- **Git-diffable markdown** as source of truth. You can `git checkout -b` a repo that contains `.memsearch/memory/` and get a branched journal for free. That is filesystem git, not a memory API. Collections are path-derived, so a worktree in another directory gets a different collection automatically — isolation by *cwd*, not by named memory fork.
- **Capture checkpoints** in OpenCode (`opencode-turns.db`) — “how far did the daemon read,” not user-facing memory branches.
- Comparison page row **“Forked-subagent recall (isolated context)”** — they mean the skill isolation above. Easy to misread as fork-to-memory. It is not.

No API: `fork_session`, `branch_memory`, `clone_memory`, parallel timeline, or “save this run as a memory branch.”

**Closest workaround:** copy `.memsearch/memory/` (and optionally `.memsearch.toml`), `memsearch index` into a new `--collection`. Or commit the markdown and use git branches.

### claude-mem: **no** (closest work was visibility filtering, and it did not ship)

What exists today:

- **Project scoping** (`project` column, `platformSource`).
- **Export/import** of observation sets ([docs/public/usage/export-import.mdx](../docs/public/usage/export-import.mdx)) — share/backup, not fork.
- **`timeline` tool** — chronological neighborhood, not a branchable timeline.
- **No `context: fork`** on `mem-search` (skill has no frontmatter fork). Recall stays in the main conversation by design.
- **No `commit_sha` / `git-ancestry` on current `main`.** `src/**/git-*.ts` does not exist. `Grep commit_sha` in `src/` is empty.

What was attempted:

- User request: [#391 Per branch memory](https://github.com/thedotmack/claude-mem/issues/391) (2025-12, closed by bot).
- Implementation: [#1246 feat: branch-scoped memory with git ancestry filtering](https://github.com/thedotmack/claude-mem/pull/1246) (2026-02, +3766/−456, 23 commits, **closed unmerged** 2026-04-15).
- Re-filed: [#2038](https://github.com/thedotmack/claude-mem/issues/2038), closed **`not_planned`** 2026-04-25.

That design tagged observations with `branch` + `commit_sha` and **filtered** SessionStart/search to ancestor commits. Sibling-branch work became invisible. That is **git-aware visibility**, not “fork memory into a parallel timeline you can merge later.” Even if it had merged, it would not be fork-to-memory.

**Closest workarounds today:** new project name / cwd; export a slice and import elsewhere; hosted project isolation. None of these clone a session’s memory graph.

### Scoreboard

| Capability | claude-mem | memsearch |
|---|---|---|
| Fork recall into an isolated subagent | No (MCP in main context) | **Yes** on Claude Code only |
| Git-diffable memory files you can branch | No (SQLite) | **Yes** (workaround) |
| Named memory branch / clone / merge | No | No |
| Session → new memory timeline | No | No |
| Hide other git-branch observations | Designed, **not shipped** | No (path/collection only) |

**If “fork to memory” is a 2026 bet, neither repo is ahead. memsearch’s markdown makes the cheap version (git-branch the journal) trivial; claude-mem’s structured observations make the real version (fork a typed graph) harder and more valuable.**

---

## Code quality notes (evidence, not vibes)

Counts taken 2026-09-20 from local trees unless noted.

### Activity / maturity

| | claude-mem | memsearch |
|---|---|---|
| GitHub | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | [zilliztech/memsearch](https://github.com/zilliztech/memsearch) |
| Stars / forks / open_issues field | 94,338 / 8,331 / 240 | 2,626 / 253 / 255 |
| Open issues vs open PRs (search API) | 47 issues / **193 PRs** | 35 issues / **220 PRs** |
| Top committer | `thedotmack` 2,207 | `zc277584121` (Cheney Zhang, Zilliz) 381 |
| Listed contributors (API page) | many; next is `rodboev` 67 | 27; next is `haosenwang1018` 20 |
| Latest release | v13.24.23 on GitHub releases (repo `package.json` is 13.25.2) | [v0.4.20](https://github.com/zilliztech/memsearch/releases/tag/v0.4.20) 2026-09-12 |
| CI | existing GH workflows + huge local `tests/` | [test.yml](https://github.com/zilliztech/memsearch/actions/workflows/test.yml), ruff, pre-commit, docs |

Both have a **PR pile**, not a quiet tracker. memsearch’s 220 open PRs on a 6.8k-LOC core is not “hygiene win.”

### Structure / size

**claude-mem `src/`:** 355 TS/TSX files, **83,414 lines**. Largest files:

- `services/sqlite/SessionStore.ts` — 3,784
- `npx-cli/commands/install.ts` — 2,547
- `server/routes/v1/ServerV1PostgresRoutes.ts` — 2,139
- `services/sync/CloudSync.ts` — 1,684
- `services/worker-service.ts` — 1,683
- `servers/mcp-server.ts` — 1,085 (worker vs server-beta branching in `search` alone)

Plus: `tests/` 350 files / **77,084 lines**; `CHANGELOG.md` **388,820 bytes** (auto-generated); 32 i18n READMEs; worker + hosted server + viewer + sync + installer + many skills. `package.json` runtime `dependencies` is only `better-auth` + `@better-auth/api-key`; **54 `devDependencies`**. Dual runtime (local SQLite worker vs server-beta Postgres) is visible in MCP `search` and is the kind of path that accumulates slop.

Internal receipt that the house already knows this: [`docs/anti-pattern-cleanup-plan.md`](../docs/anti-pattern-cleanup-plan.md) lists **132 error-handling anti-patterns**, 36 in `worker-service.ts` and 28 in `SearchManager.ts`, all still unchecked.

**memsearch `src/memsearch/`:** 28 Python files, **6,759 lines** (core modules 5,895). Largest: `cli.py` 1,499, `maintenance.py` 716, `skills.py` 585, `config.py` 621, `core.py` 500, `store.py` 363. Tests: 37 files / 10,967 lines / **367** `test_*` functions — more test lines than core. Plugins add shell + duplicated-but-synced skills (`scripts/sync-skills.sh`). Ruff is enforced; **no mypy/pyright config**. `Any` appears in config/maintenance/skills (dozens of hits), but the public `MemSearch` class is typed.

Fair statement: **memsearch’s retrieval engine is a small, readable library. claude-mem’s `src/` is a product monorepo that outgrew a plugin.** That is not the same as “memsearch is better-engineered claude-mem.” They never took on SessionStore, CloudSync, the installer, or the viewer.

### Dead paths / fluff

- **claude-mem:** generated changelog + i18n copies are large but mechanical. Real slop risk is *live* dual paths (worker vs server-beta), Chroma optional vs FTS5, and god-files above 1.5k LOC. `BranchManager.ts` is named in the anti-pattern plan and **is not on current `main`** — leftover plan, not leftover module.
- **memsearch:** plugin skill trees are copies of `_shared/` (intentional sync). `docs/testfile` exists. `compact` config is marked deprecated in architecture.md in favor of `[llm]`. Comparison docs are the sloppiest artifact (false ❌ on our progressive disclosure).

### Dependency weight

- **memsearch default:** `pymilvus` + `milvus-lite` + click + watchdog + openai (even if you use ONNX). Optional `memsearch[onnx]` pulls ~558 MB bge-m3 on first run. Scale path is also a sales path to Zilliz Cloud.
- **claude-mem default:** Bun worker + SQLite. Chroma/uv/Python is the optional vector sidecar. Heavier *process* (always-on worker), lighter *default ML*.

---

## What each still uniquely has

### claude-mem still has (memsearch does not)

1. **Observation-level capture** — tool use → typed, dated, file-linked records. Their unit is a turn summary.
2. **Cost-visible, ID-gated contract** — `get_observations(ids)` / `get_tool_uses(ids)`. Their L1 already ships snippet text.
3. **`timeline` as L2** — narrative neighborhood, not “rest of the heading.”
4. **L4 raw tool I/O** in a table, not “go read the JSONL.”
5. **Smart Explore** for live code, with a published A/B.
6. **SessionStart as a priced index**, not “last 80 lines of journal.”
7. **Ecosystem** — viewer, hosted CMEM Pro / cloud sync, Cursor/Grok/Antigravity/Gemini surfaces, modes, privacy tags, export/import, 94k stars / existing install base.
8. **Queryability** — filter by `obs_type`, project, platform, date in the tool schema.

### memsearch does better / has that we do not

1. **Small, reviewable core** — one `MemSearch` class, heading chunker, Milvus store, CLI. A new engineer can finish `core.py` in an afternoon.
2. **Markdown as source of truth** — editable, greppable, rebuildable, git-diffable. SQLite is not that.
3. **Fused hybrid search in one engine** — dense + BM25 + RRF in Milvus. Our hybrid is two systems glued.
4. **Pluggable embeddings** — ONNX default, no key; OpenAI/Voyage/Ollama/etc.
5. **`context: fork` recall** — intermediates stay out of the parent window (Claude Code only). Honest counter to “MCP tax.”
6. **One journal, five agents** — Claude Code / Codex / DSH / OpenClaw / OpenCode write the same `.md` format. We have more *installers*, not one shared file format.
7. **Skills from memory** — distill a session into an Agent Skill candidate. We do not.
8. **Lite → server → managed vector** on one URI. Our hosted path is a different stack (worker vs server-beta), not “change the URI.”

---

## Messaging implications

### Say (true)

- “memsearch is the closest shipped peer on **cascading retrieval**. They store daily journals; we store **what the agent did**.”
- “Progressive disclosure is no longer a secret. The remaining wedge is **observation granularity + priced index + forced filter-before-fetch + Smart Explore**, not the three-layer slogan.”
- “Their ‘fork’ is a **subagent context fork**, not fork-to-memory. We also do not have fork-to-memory. If we ship it, we would be first in this pair.”
- “Their comparison table is competitor copy. We do have progressive disclosure, OpenCode, and Codex. Cite our docs, not theirs.”
- “A 6.8k-LOC engine can look cleaner than an 83k-LOC product monorepo without having solved observation capture, sync, or the installer.”

### Do not say (false or easy to puncture)

- “Nobody else does progressive memory search.” — they do; we already said so in PR #4151.
- “memsearch is a clone / stolen rewrite / unofficial fork.” — no git or code evidence; they cite OpenClaw and then *compare* to us.
- “We are cleaner / they are slop.” — inverted on core size; we have the god-files and 132-item anti-pattern list.
- “We have branch memory.” — #1246/#2038 did not ship.
- “MCP is strictly better than a forked skill.” — tradeoff. They win on parent-context isolation; we win on agent agency and an audit trail in the main thread.
- “10× vs memsearch.” — our 10× is vs fetching full observations, not vs their snippet search.

### If asked publicly “are they the rewritten claude-mem?”

Suggested one-liner:

> They’re a well-executed **OpenClaw-style markdown memory** with the same *progressive recall* idea we use. Not a rewrite of claude-mem. Different write path, different source of truth, smaller engine. We still uniquely remember tool-level work with a priced, ID-gated index.

---

## Appendix: file / URL index

**memsearch (cloned 2026-09-20, commit `a1a6d09`)**

- https://github.com/zilliztech/memsearch/blob/main/README.md
- https://github.com/zilliztech/memsearch/blob/main/docs/design-philosophy.md
- https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md
- https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md
- https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md
- https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/skills/memory-recall/SKILL.md
- https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/hooks/stop.sh
- https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py
- https://github.com/zilliztech/memsearch/blob/main/src/memsearch/cli.py
- https://zilliztech.github.io/memsearch/platforms/claude-code/memory-recall/

**claude-mem (`main` @ `4e98d977`)**

- [`README.md`](../README.md)
- [`docs/public/progressive-disclosure.mdx`](../docs/public/progressive-disclosure.mdx)
- [`docs/public/architecture/overview.mdx`](../docs/public/architecture/overview.mdx)
- [`docs/public/architecture/search-architecture.mdx`](../docs/public/architecture/search-architecture.mdx)
- [`docs/public/smart-explore-benchmark.mdx`](../docs/public/smart-explore-benchmark.mdx)
- [`src/servers/mcp-server.ts`](../src/servers/mcp-server.ts)
- [`plugin/skills/mem-search/SKILL.md`](../plugin/skills/mem-search/SKILL.md)
- [`plugin/skills/smart-explore/SKILL.md`](../plugin/skills/smart-explore/SKILL.md)
- https://github.com/thedotmack/claude-mem/pull/1246
- https://github.com/thedotmack/claude-mem/issues/2038
- https://github.com/thedotmack/claude-mem/issues/391
- https://github.com/thedotmack/claude-mem/pull/4151 (landscape sibling)

**Limits**

- No private Zilliz roadmap. No install-and-run bake-off. No LongMemEval.
- GitHub language-byte totals include generated JS in claude-mem; LOC above is `src/*.ts` + memsearch `src/memsearch/*.py`.
- memsearch comparison docs were used only as *their* positioning, then fact-checked against this repo.
