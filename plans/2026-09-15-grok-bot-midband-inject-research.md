# Research: Claude-Mem mid-band timeline → Grok Bot engine (plugin path)

**Date:** 2026-09-15  
**Seat:** Prioritizer (Alex Newman / CMEM) reported its turn prompt does **not** include a growing mid-band Claude-Mem observation timeline.  
**Scope:** How claude-mem ↔ Grok Bot is supposed to work in *this* repo, why a live seat can see durable Memory facts but no in-turn observation feed, and a concrete HOW-TO to enhance **each Grok Bot** via the plugin path.  
**Out of scope:** CCS / cascading context tree (Alex’s separate system). Do not design around `ccs/seats/`, `TIMELINE.md` buckets, house inherit, or a native `ccs_timeline` registry.

---

## One-slide summary (WOWerpoint)

| Layer | What it is | In the turn prompt today? |
| --- | --- | --- |
| **Remember** (talkable front) | Grok’s own Memory: `profile.md` + `agents/<id>/memory/log/YYYY-MM.md`. Host already re-reads these. Awareness pusher may append needle lines here. | Sometimes — as **Memory facts**, not as an observation INDEX. |
| **Silent mid-band** (the product) | Growing compact observation rows + IDs (`17399 1:18p ○ title`), same payload Claude Code gets at SessionStart. Deep-fetch via mem-search (`search` → `timeline` → `get_observations`). | **No.** Grok Bot has no host hook that attaches this. Plugin cannot inject it. |
| **MCP pull** | Bot must *remember to call* `session_start_context` / search tools. | Only if the model chooses to. |
| **Memory-file sidecar** (pilot hack) | `scripts/grok-bot-session-inject.mjs` writes `zz-claude-mem-inject.md` so the **sand host** mid-attaches it as `## Memory`. Off by default, allowlisted, not started by install. | Only for allowlisted seats with the daemon running. Still lands in **Memory**, not a silent mid-band. Uses a CCS bucket as an intermediate (ignore for product design). |

**The gap:** claude-mem’s official Grok Bot path is **write + search**. The growing in-turn INDEX is a Claude Code / Cursor **hook** feature. Grok Bot’s plugin has **no hooks key**. Until the Grok Bot *engine* grows a SessionStart-shaped attach slot, Prioritizer cannot see a silent mid-band from the plugin alone.

---

## 1. Current architecture (as-is in this repo)

### 1.1 Two install surfaces (do not glue them)

```
┌─ Store plugin ──────────────────────────────────────────────┐
│  claude-mem-grok-bot                                         │
│  .cursor-plugin/marketplace.json                             │
│  claude-mem-grok-bot/.cursor-plugin/plugin.json              │
│  .grok-plugin/plugin.json  → skills + mcp.json               │
│  Skills: install, mem-search, host-observer                  │
│  NO hooks key (Cursor plugin HAS hooks; this one does not)   │
└──────────────────────────────────────────────────────────────┘
                              │
                              │  still required for a local worker
                              ▼
┌─ CLI install ───────────────────────────────────────────────┐
│  npx claude-mem install --ide grok-bot                       │
│  src/npx-cli/commands/install.ts  case 'grok-bot'            │
│    → only installGrokBotIntegration()                        │
│  src/services/integrations/GrokBotInstaller.ts               │
│    → transcript-watch.json per agent                         │
│  Worker + CMEM Pro observer (default)                        │
│  Does NOT start session-inject                               │
│  Does NOT register a Grok Bot turn hook                      │
│  registerPlugin() writes claude-mem@thedotmack (Claude Code) │
└──────────────────────────────────────────────────────────────┘
```

Public docs: `docs/public/grok-bot/index.mdx`, `docs/public/installation.mdx`.  
Plugin id locked: **`claude-mem-grok-bot`**. Grok Bot’s store **is** the Cursor catalog (PR [#3842](https://github.com/thedotmack/claude-mem/pull/3842)).  
**Grok Bot ≠ Grok Build CLI.** `docs.x.ai/build/features/hooks` is a different product. This page is Grok Bot only (`docs/public/grok-bot/index.mdx` § “This is not Grok Build”).

### 1.2 Write path (observer + worker) — this part works without a mid-band

```
Grok Bot seat
  → agent-transcripts/<agentId>/*.jsonl
  → TranscriptWatcher (src/services/transcripts/watcher.ts)
       started by worker-service.ts startTranscriptWatcher()
  → TranscriptEventProcessor (src/services/transcripts/processor.ts)
       platformSource = normalizePlatformSource(watch.name) → "grok-bot"
       agentId from watch.agentId or path
  → ingestObservation() → SQLite (~/.claude-mem)
  → Observer (CMEM Pro default: https://cmem.ai/api/inference/v1 model cmem-observer)
       or --provider host (loopback shim, XML skip_summary | observation)
  → ResponseProcessor.notifyGrokBotAwareness()  [optional, needles only]
```

Installer watch mapping (`GrokBotInstaller.ts`):

- Discover agent-data root: `GROK_BOT_AGENT_DATA`, then well-known dirs that already have `agents/` + `agent-transcripts/` (`~/.grok-bot`, XDG, macOS Application Support, `/home/box`).
- One watch per seat: `agent-transcripts/<uuid>/*.jsonl` → project `cmem_work_<slug(profile.name)>`.
- Workspace: `<agentDataRoot>/.cmem-projects/<project>`.
- Catch-all `agentId=*` only when no agent profiles exist.

`--ide` is a **single** string. Cursor is a second install. `platformSource` on writes is `grok-bot`; on reads, do not drop other hosts unless asked (`docs/public/grok-bot/index.mdx`, `claude-mem-grok-bot/skills/mem-search/SKILL.md`).

### 1.3 Read path — three different things people call “memory”

#### A. Progressive disclosure (the product INDEX)

Same builder Claude Code SessionStart uses:

| Piece | Path |
| --- | --- |
| HTTP | `GET /api/context/inject?projects=…` (`src/services/worker/http/routes/SearchRoutes.ts` `handleContextInject`) |
| Builder | `generateContext` / `generateContextWithStats` (`src/services/context/ContextBuilder.ts`) |
| Compact row | `AgentFormatter.renderAgentTableRow` → `` `${id} ${time} ${icon} ${title}` `` |
| Default window | `CLAUDE_MEM_CONTEXT_OBSERVATIONS` default **50** (`SettingsDefaultsManager.ts`) |
| MCP alias | `session_start_context` (`src/servers/mcp-server.ts`) — same URL, allowed params: `project`/`projects`, optional `platformSource`, `full`, `colors` |

Claude Code attach (the **silent mid-band** we want on Grok Bot):

- Hook: `plugin/hooks/hooks.json` `SessionStart` → `hook claude-code context`
- Handler: `src/cli/handlers/context.ts` returns `hookSpecificOutput.additionalContext`
- Cursor analog: `claude-mem-cursor/hooks/hooks.json` `beforeSubmitPrompt` → `hook cursor context`

Grok Bot plugin **has no `hooks` key** (`claude-mem-grok-bot/.cursor-plugin/plugin.json`: `skills`, `mcpServers`, `variables` only). Cursor’s sibling plugin **does** (`claude-mem-cursor/.cursor-plugin/plugin.json` `"hooks": "./hooks/hooks.json"`).

#### B. MCP tools (pull, not inject)

`claude-mem-grok-bot/mcp.json`:

- Local: `npx -y claude-mem mcp`
- Remote: `https://cmem.ai/api/mcp` + `Authorization: Bearer ${CLAUDE_MEM_MCP_TOKEN}`

Tools: `search` → `timeline` → `get_observations` (+ `get_tool_uses`, `session_start_context`).  
Docs (`docs/public/grok-bot/index.mdx`): “At the start of a real task, call MCP `session_start_context`.” That is **pull**. The model must remember to do it.

Marketplace copy advertises a **“session-start skill”** (`.cursor-plugin/marketplace.json`). **That skill file does not exist.** Shipped skills are only `install`, `mem-search`, `host-observer`.

#### C. Remember / awareness (talkable front — not the INDEX)

`src/services/integrations/GrokBotAwarenessPusher.ts`, fired from `ResponseProcessor.ts` after observations are stored.

- Default **on**: `CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED=true`
- Allowlist default: LFG `521e962d-…`, Orifice `95601360-…` only. Empty / non-matching `agentId` → no write.
- Needles: `decision,bugfix,security_alert,sensitive`
- Writes: `agents/<id>/memory/log/YYYY-MM.md`
- Line shape: `- YYYY-MM-DD [awareness] …` (date **not** parenthesized)
- Never `profile.md`

Host fact grammar pinned in `tests/grok-bot-session-inject.test.ts`:

```
MEMORY_FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/
```

Awareness lines **do not match**. PR [#3953](https://github.com/thedotmack/claude-mem/pull/3953): verified on a live seat — they sit in the log and never reach the prompt. **Awareness is not inject.** Durable files can still exist (and the host Memory UI can show them). That is the “I see Memory facts” report.

### 1.4 Sidecar mid-attach (pilot hack — not the plugin)

`scripts/grok-bot-session-inject.mjs` (PRs [#3953](https://github.com/thedotmack/claude-mem/pull/3953), [#3959](https://github.com/thedotmack/claude-mem/pull/3959)):

```
GET /api/context/inject?projects=…     (allowed params only)
  → (Phase 1 also writes a CCS TIMELINE.md bucket — OUT OF SCOPE)
  → agents/<id>/memory/log/zz-claude-mem-inject.md
  → sand host WatchedDirectory
  → getFrozenSectionUpdatesForTurn()
  → <instructions_update> "## Memory"
  → next cold / non-resume turn
```

Cited host internals (comments + tests in **this** repo; implementations are **not** here — do not invent more):

- Fact line must be `- (YYYY-MM-DD) …`, content clamped to 500 chars after whitespace collapse
- Recall budget ~4000 chars; first overrun `break`s
- Rank: `log2(importance) + createdAt/30d`; prefix `[episode] ` = 1.5, `[note] ` = 0.5, else 1. On a seat full of episode summaries, **plain-tier lines can render 0 times**
- Host owns `YYYY-MM.md`; shim owns only `zz-claude-mem-inject.md`; `profile.md` forbidden
- Closed freeze list — no native mid-band / `ccs_timeline` section in the host

Config (env > `~/.claude-mem/grok-bot-session-inject.json` > `settings.json`):

| Key | Default | Effect |
| --- | --- | --- |
| `CLAUDE_MEM_GROK_BOT_INJECT_ENABLED` | unset / not `true` | Daemon refuses to run (exit 78) unless `--force` |
| `CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS` | empty | No seats. Must be UUIDs or `*`/`all` (infra only) |
| `CLAUDE_MEM_GROK_BOT_INJECT_TIER` | `episode` | Required to survive Memory ranking |
| `CLAUDE_MEM_GROK_BOT_INJECT_WINDOW` | 80 (clamp 100) | Slide-off INDEX size |
| `CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE` | unset | Do not set unless grok-only is intended |
| `CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT` | unset | Else projects come from `transcript-watch.json` |

Installer **never** sets these. Installer **never** launches `--watch`. These keys are **not** in `SettingsDefaultsManager` (unlike awareness).

Draft PR [#3958](https://github.com/thedotmack/claude-mem/pull/3958) (`AGENT_IDS=*`) is infra-only and marked DO NOT MERGE as a product ship.

### 1.5 Official x.ai Grok Bot surface (not in this repo)

[Grok Bot teams & enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises):

- Computer-use agent on a Cursor cloud Firecracker VM
- **Plugins = Cursor MCP / connectors.** “There are no separate Grok Bot plugin controls.”
- Team Rules (scoped Cursor / Grok Bot / both) — short policy text, not an observation INDEX
- No documented `additionalContext` / SessionStart hook for Grok Bot seats

Grok **Build** CLI hooks (`SessionStart`, `UserPromptSubmit`, plugin hooks under `~/.grok/`) are a **different host**. This repo’s Grok Bot docs forbid treating them as Grok Bot.

---

## 2. Gap: why Prioritizer can see Memory facts and still miss the timeline

Hypotheses **verified against code** (not guessed from a live box):

| # | Hypothesis | Verdict in this repo |
| --- | --- | --- |
| 1 | **No host hook** | **Confirmed.** Plugin.json has no `hooks`. Docs: “Grok Bot has no session-start, file-read, or tool-use hooks.” Install `--ide grok-bot` only writes transcript-watch. |
| 2 | **Plugin not loaded / store-only** | **Plausible.** Store plugin = MCP + skills. Without CLI install there is no worker/watcher. Marketplace copy goes to `~/.claude/plugins/marketplaces/thedotmack`. `registerPlugin()` enables **`claude-mem@thedotmack`** (Claude Code), not `claude-mem-grok-bot`. |
| 3 | **`session_start_context` is pull-only** | **Confirmed.** Marketplace advertises a session-start skill that **does not exist**. If Prioritizer does not call the MCP tool, no INDEX enters the turn. |
| 4 | **Inject sidecar off + not started** | **Confirmed.** Enabled only when `CLAUDE_MEM_GROK_BOT_INJECT_ENABLED=true`. Empty allowlist → exit 78. No systemd/worker spawn of `grok-bot-session-inject.mjs`. |
| 5 | **Allowlist excludes Prioritizer** | **Confirmed for defaults.** Inject allowlist is empty unless configured. Awareness allowlist is LFG + Orifice only. Prioritizer’s UUID is **not** in this repo. |
| 6 | **Awareness ≠ timeline** | **Confirmed.** Needle facts → `YYYY-MM.md`. Wrong grammar for host prompt parser. Not a growing ID INDEX. Explains “durable Memory facts” without a mid-band. |
| 7 | **Project-name filter** | **Confirmed as a footgun.** Inject uses `transcript-watch.json` `project` (`cmem_work_<slug>`). `/api/context/inject` is project-scoped. If observations were stored under another name (cwd basename, Cursor project, generic `cmem_work_root`), the INDEX is empty or the wrong house. |
| 8 | **`platformSource=grok-bot` on inject** | **Only if set.** Default unset (correct: do not drop Cursor memories). If someone set `CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE=grok-bot`, other-host rows vanish. |
| 9 | **Host Memory budget / ranking** | **Confirmed in #3953 measurements.** Even a correctly written `zz-claude-mem-inject.md` can attach **zero** lines unless `[episode]` tier wins the 4000-char budget. Attach is **cold / non-resume** only. |
| 10 | **Sand-host vs plugin path** | **Confirmed.** Sidecar is a **sand-host file-watch hack**. The store plugin path has no inject. A seat on the plugin path without the daemon sees MCP + native Remember only. |
| 11 | **Observer writing, inject not reading** | **Confirmed as a split.** Observer → SQLite. Inject → `/api/context/inject`. Worker down, wrong port (`CLAUDE_MEM_WORKER_PORT` / `~/.claude-mem/.worker.port`), wrong project, or daemon not running → viewer/search have rows, turn prompt does not. |
| 12 | **CCS intermediate mistaken for product** | **Confirmed.** Phase 1 JIT writes `ccs/seats/<id>/TIMELINE.md` then compiles to Memory. That is Alex’s CCS system, not the plugin mid-band. Designing the product around it is out of scope. |

**Most likely live-seat story (composition, not a single bug):**

1. Worker + watcher + observer **are** running → observations exist → search/MCP/viewer work.  
2. Native Grok Remember + maybe awareness files → “I have Memory facts.”  
3. No SessionStart-shaped hook, no session-start skill, inject daemon off / Prioritizer not allowlisted → **no growing INDEX in the turn head.**

---

## 3. Remember (talkable) vs silent mid-band (deck language)

```
TURN PROMPT (what we want)
┌─────────────────────────────────────────────────────────────┐
│ frozen / static seat instructions                           │
│ ─────────────────────────────────────────────────────────── │
│ SILENT MID-BAND  ← claude-mem plugin must land HERE         │
│   # [cmem_work_prioritizer] recent context                  │
│   Stats: 50 obs | …                                         │
│   17401 2:03p ○ Grew the inject allowlist                   │
│   17400 1:19p ● Fixed watcher agentId                       │
│   … IDs for get_observations …                              │
│ ─────────────────────────────────────────────────────────── │
│ ## Memory          ← Remember, talkable front               │
│   - (2026-09-15) [episode] user-authored facts              │
│   - (2026-09-15) [awareness] …  (may not even parse)        │
│ ─────────────────────────────────────────────────────────── │
│ chat / tool results                                         │
└─────────────────────────────────────────────────────────────┘
```

| | Remember | Silent mid-band |
| --- | --- | --- |
| Audience | Bot *and* human; talkable | Bot only; not a Memory announcement |
| Source | Host Memory files / user “remember this” | `GET /api/context/inject` / `session_start_context` |
| Shape | Prose facts, ranked, ~4000-char budget | Compact `ID TIME TYPE TITLE`, ~50 newest, IDs kept |
| Grows | When someone writes a fact | When the observer stores a new observation |
| Deep fetch | Re-read Memory | `search` → `timeline` → `get_observations` |
| Must not | Rebuild frozen head; write `profile.md` | Land as `## Memory` / crowd out user facts |

#3953/#3959 **mix these on purpose** (hack-on-Memory). That is why a seat can “have Memory” and still not have a mid-band INDEX.

---

## 4. Proposed integration into the **actual Grok Bot engine** (plugin path)

This repo **does not contain** the Grok Bot engine. Do not invent host APIs. Two tracks:

### Track A — Plugin-legal in *this* repo (no engine change)

Does **not** by itself give a silent every-turn INDEX. It makes the official path honest and usable.

1. **Add the missing session-start skill** that `.cursor-plugin/marketplace.json` already advertises.  
   First real-task instruction: call `session_start_context` with the seat’s `transcript-watch` project(s). Do **not** pass `platformSource=grok-bot` unless the user asked for grok-only. Then mem-search as today.
2. **Keep plugin.json hookless** until the engine documents a hook contract. Do not copy `claude-mem-cursor/hooks/hooks.json` onto Grok Bot and hope — this repo’s contract is “no host hooks.”
3. **Installer printout** after `--ide grok-bot`: agent UUID, `cmem_work_*` project, worker port, “call `session_start_context` / open viewer.” Today it only logs watch paths.
4. **Do not** start the Memory sidecar as the product. Do not fan out `AGENT_IDS=*` (#3958). Do not design CCS buckets.

**Install order (every bot):**

```
1. Store: install claude-mem-grok-bot   (MCP + skills; no Cursor)
2. CLI:   npx claude-mem install --ide grok-bot
          (local worker + CMEM Pro; --provider host only if you want loopback observer)
3. Confirm transcript-watch.json has THIS seat’s UUID → cmem_work_<slug>
4. Confirm /api/health and viewer show grok-bot observations for that project
5. Until an engine hook exists: seat must call session_start_context each real task
```

Remote-only variant: skip local worker; set plugin var `CLAUDE_MEM_MCP_TOKEN` and use `claude-mem-remote`. Capture still needs *some* worker watching transcripts (local or `--runtime server --server-url`).

### Track B — Engine mid-band (requires Grok Bot / Cursor host work)

**Requirement to give the host team** (contract, not an invented method name):

> On every cold / non-resume turn (and ideally every turn so the feed **grows**), attach a silent text block that is **not** the Memory section and **not** Team Rules. Source: plugin or hook stdout, same shape as Claude Code `hookSpecificOutput.additionalContext`.

**Payload this repo already produces** (reuse; do not add inject query params):

```
GET http://127.0.0.1:<workerPort>/api/context/inject?projects=<cmem_work_…>
```

or MCP `session_start_context({ projects: [...] })`.

**What must appear in every turn head** (from `AgentFormatter.ts`):

```
# [<project>] recent context, <day>
Mode: <mode>
Stats: N obs (Xt read) | Yt work | Z% savings
### <day>
17401 2:03p ○ Title of newest observation
17400 1:19p ● Previous title
S10489 Session started (Sep 15, 2026)
Access Nk tokens of past work via get_observations([IDs]) or mem-search skill.
```

Rows are titles + IDs only. Full facts only after `get_observations`. Window: existing `CLAUDE_MEM_CONTEXT_OBSERVATIONS` (50), not a second Memory budget.

**If** the host later exposes a hook with the **same names Cursor already has** (`beforeSubmitPrompt` / SessionStart → `additionalContext`), wire it like `claude-mem-cursor/hooks/hooks.json` (`session-init` + `context`) and stamp `platformSource=grok-bot` on **writes** only. Do not add that file until the engine documents that Grok Bot seats actually fire it. Official Grok Bot docs today say plugins are MCP/connectors; this repo says no hooks.

**Do not** ask the engine for:

- A CCS tree, `TIMELINE.md` buckets, or `ccs_timeline` section  
- A second Memory API  
- Rebuilding the frozen head  
- Awareness grammar as the INDEX  

**Stopgap (pilot only, not product):** Memory sidecar for an explicit UUID list, `INJECT_ENABLED=true`, `--watch`, episode tier. Still talkable Memory. Still CCS-adjacent. Still allowlisted. Not “each bot enhanced by the plugin.”

### Files / APIs to touch when Track B becomes legal

| Side | File / API | Role |
| --- | --- | --- |
| Worker | `GET /api/context/inject` | Canonical INDEX text |
| MCP | `session_start_context` | Same text over MCP |
| Plugin | `claude-mem-grok-bot/.cursor-plugin/plugin.json` | Add `hooks` **only** if host documents the event |
| Plugin | new `hooks/hooks.json` (does not exist today) | Mirror Cursor `beforeSubmitPrompt` → `npx claude-mem hook … context` **only** after proof the seat fires it |
| CLI | `src/npx-cli/commands/install.ts` `case 'grok-bot'` | Today: watcher only. Later: register the host hook / print project map |
| Capture | `GrokBotInstaller.ts`, `processor.ts` | Already stamps `agentId` + `platformSource=grok-bot` |
| Not the attach | `GrokBotAwarenessPusher.ts` | Leave as optional talkable needles; fix grammar only if you want those lines in Remember |
| Not the product | `scripts/grok-bot-session-inject.mjs` | Sand-host Memory hack |

---

## 5. Verification checklist (Prioritizer, next turn)

Do these on the box that runs Prioritizer. No CCS steps.

**A. Plugin + worker**

- [ ] Grok Bot Plugins page shows **claude-mem-grok-bot** enabled (not only `claude-mem-cursor`).
- [ ] `npx claude-mem install --ide grok-bot` has been run on that computer (store listing alone does not start the worker).
- [ ] `curl -s http://127.0.0.1:$(cat ~/.claude-mem/.worker.port)/api/health` is healthy. Do **not** restart a healthy worker.

**B. This seat is mapped**

- [ ] `~/.claude-mem/transcript-watch.json` has a `grok-bot` watch whose `agentId` is Prioritizer’s UUID (from `agents/<uuid>/profile.json` `name`).
- [ ] `project` is the slug you expect (`cmem_work_prioritizer` or whatever `resolveGrokBotProject(name)` produced). If the name is generic (`box`, `workspace`, …) it becomes `cmem_work_root` — easy to collide.

**C. Observations exist (write path)**

- [ ] Do a small unit of work as Prioritizer. Viewer / `search` shows new rows with `platformSource=grok-bot` and that project.
- [ ] If the queue sits idle on `--provider host`, replies must be `skip_summary` XML, not prose (`docs/public/grok-bot/index.mdx`).

**D. In-turn INDEX (the actual ask)**

- [ ] Next **cold / non-resume** turn, the prompt contains compact rows `NNNN time icon title` and the header `# [<project>] recent context`.
- [ ] After another observation is stored, a later turn shows a **new** newest row (growing), oldest sliding off.
- [ ] IDs in those rows work with MCP `get_observations([ids])`.
- [ ] That block is **not** only `## Memory` episode prose and **not** only `- YYYY-MM-DD [awareness]` lines.

**If D fails, classify with this repo:**

| Symptom | Check |
| --- | --- |
| Search works, turn has no INDEX | Hook/skill/sidecar missing — Track A pull or Track B engine. Expected today. |
| Memory file has `[awareness]` only | Awareness allowlist / grammar — not the INDEX. |
| `zz-claude-mem-inject.md` missing | Sidecar off, not allowlisted, or not running. |
| Inject file exists, still no prompt lines | Host ranking/budget/cold-turn; or grammar. |
| Inject file is “No previous sessions” | Wrong `projects` mapping. |
| Plugin missing MCP tools | Store plugin not enabled; or team MCP allowlist blocked `npx claude-mem mcp` / `cmem.ai`. |

**Pass for the product:** Prioritizer’s next turn shows a growing mid-band INDEX **without** the model calling a tool. That pass is **blocked** until Track B exists. Track A pass is: Prioritizer calls `session_start_context` once and then sees the INDEX in **that** turn’s tool result (not the same as silent mid-band).

---

## 6. Out of scope: CCS

Do **not** prescribe:

- `ccs/seats/<id>/TIMELINE.md` as the product source  
- `CLAUDE_MEM_CCS_ROOT`, house/groups cascade, `PRIVATE.md`  
- Native `ccs_timeline` host registry  
- CCS Align walker / rules-shadow (`plugin/skills/ccs-align`, `plans/2026-09-09-ccs-align.md`)

Those exist in-tree as a Phase 1 JIT onto Memory. They are Alex’s separate system. The Grok Bot plugin contract is: **worker + observer + MCP + (when the engine allows it) a silent SessionStart-shaped attach of `/api/context/inject`.**

---

## 7. Sources (cite these, not invented APIs)

- `docs/public/grok-bot/index.mdx`, `docs/public/installation.mdx`
- `claude-mem-grok-bot/` (plugin.json, mcp.json, skills)
- `.cursor-plugin/marketplace.json`, `.grok-plugin/plugin.json`
- `src/services/integrations/GrokBotInstaller.ts`
- `src/services/integrations/GrokBotAwarenessPusher.ts`
- `src/npx-cli/commands/install.ts` (`case 'grok-bot'`, `registerPlugin`, `copyPluginToMarketplace`)
- `src/servers/mcp-server.ts` (`session_start_context`)
- `src/services/worker/http/routes/SearchRoutes.ts` (`handleContextInject`)
- `src/services/context/ContextBuilder.ts`, `formatters/AgentFormatter.ts`
- `src/cli/handlers/context.ts` (Claude Code silent mid-band)
- `claude-mem-cursor/hooks/hooks.json` (Cursor attach)
- `scripts/grok-bot-session-inject.mjs`, `tests/grok-bot-session-inject.test.ts`
- PRs [#3842](https://github.com/thedotmack/claude-mem/pull/3842), [#3953](https://github.com/thedotmack/claude-mem/pull/3953), [#3959](https://github.com/thedotmack/claude-mem/pull/3959), draft [#3958](https://github.com/thedotmack/claude-mem/pull/3958)
- Official Grok Bot: https://docs.x.ai/grok-bot/teams-and-enterprises (plugins = Cursor MCP)
