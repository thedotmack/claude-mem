---
name: ccs-align
description: Run the CCS Align seat's hourly breathing cycle — prove the local claude-mem worker is healthy, pull needle observations through search → timeline → get_observations, land them in a seat-owned middle cache via atomic grab → append → filter exclude-marks → replace, manage exclude marks, and walk house → project → seat rules to detect conflicts (SHADOW_HOUSE, DENY_ALLOW, DRIFT, CLOCK_HEADER) with an append-only rules-report.md. Use when asked to run CCS Align, breathe the alignment seat, refresh the middle cache, exclude or restore an observation, walk rules, check rules conflicts, or check the Worker Watch board.
---

# CCS Align — Worker Watch seat (Phases 0–2 shipped; Phase 3 = verify / sign-off)

CCS Align is a **standing seat**, not a bird's-eye planner. Its one job, once an hour: talk to the **local** claude-mem worker, pull recent needle observations through the existing three-layer disclosure ladder, and land them in a **seat-owned middle cache** using grab → append → replace.

This skill implements the Phase 0 breathing slice, Phase 1 exclude marks, and Phase 2 rules alignment from the plan of record, `plans/2026-09-09-ccs-align.md`. Phases 0–2 are **shipped and merged** ([#3934](https://github.com/thedotmack/claude-mem/pull/3934), [#3935](https://github.com/thedotmack/claude-mem/pull/3935), [#3936](https://github.com/thedotmack/claude-mem/pull/3936)); Phase 3 is **verify / sign-off** (this loop) — no new product surface. It is **not** a context compiler, **not** Focus/mouth, and **not** Grok Memory Phase 2. When you speak to the human, address them as **Alex**.

## What is implemented (Phases 0–2 shipped)

- **Phase 0 — Breathing slice** ([#3934](https://github.com/thedotmack/claude-mem/pull/3934)): health check → `search` → `timeline` → `get_observations` → append records to `~/.claude-mem/ccs-align/<viewerId>/middle.jsonl` (atomic, deduped).
- **Phase 1 — Exclude marks** ([#3935](https://github.com/thedotmack/claude-mem/pull/3935)): mark observations (and linked tool-use ids) as excluded from the compiled middle cache. "Purge" means the compiled `middle.jsonl` no longer contains the record — the diary / SQLite stay authoritative. Unmarking + rebuild restores the observation. `DELETE /api/observation/:id` is **forbidden**.
- **Phase 2 — Rules alignment** ([#3936](https://github.com/thedotmack/claude-mem/pull/3936)): walk house → project → seat layers, detect conflicts (`SHADOW_HOUSE`, `DENY_ALLOW`, `DRIFT`, `CLOCK_HEADER`), emit an append-only `rules-report.md`. Optionally dry-run/apply `SHADOW_HOUSE` leaf patches when `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true`. Runs every 6th hour of the hourly Worker Watch cycle (D4). This is a **checklist**, not a parser — no `.cas` compiler.
- **Phase 3 — Verify / sign-off** (this loop): re-run the regression tests and anti-pattern greps, prove the boundary (a scripted cycle dedupes, an exclude drops from the middle cache but not the diary, the rules report is produced or a MISS is recorded), and keep the skill + plan honest about what this seat is not. Phase 3 adds **no** new runtime behavior.
- **Does not:** delete history, write `profile.md`, write LFG/Orifice `[awareness]` logs (that seam belongs to [#3931](https://github.com/thedotmack/claude-mem/pull/3931)), add a sixth `processAgentResponse` consumer, restart the worker, run a per-turn drip update, enforce Focus/mouth/standing rules, or copy house text into seats.

## What this is NOT (honest boundary)

CCS Align is deliberately small. It does **not** ship, and this loop does **not** add, any of the following — these are future work or a different agent, called out so no one reads more into the seat than is there:

- **No context compiler.** There is no `.cas` parser, no `compileAwareness()`, no JIT compile, no computed-styles UI. The CCS Notion page types (`Bucket`, `canRead`) are teaching copy quoted as comments — never a runtime parser.
- **No brainbeat product.** The "regenerate awareness once per finished unit of work" door is not built. Align *pulls* on an hourly cadence; it is not a per-turn drip and it is not a brainbeat.
- **No attention trough / curse-salience.** No salience decay, no trough scoring. Explicitly out of every phase.
- **No Focus / mouth enforcement.** Standing rules (always / never / danger) are never enforced or decayed here. Align may *list* a conflict; egress filtering belongs to a different agent.
- **No second writer on LFG/Orifice `[awareness]` logs.** [#3931](https://github.com/thedotmack/claude-mem/pull/3931) owns `agents/**/memory/log/YYYY-MM.md`. Align writes only its seat-owned middle cache.
- **No history rewrite.** Exclude marks filter the *compiled* cache; the diary / SQLite stay authoritative and rebuildable. No `DELETE /api/observation`, no A-MEM row rewrite.

### Ops MISS — worker plugin version lag

As of this sign-off, the repo (package, plugin, marketplace) is at **13.24.5** (this Phase 3 PATCH), but the **running worker plugin on the house box may still be 13.24.1**. That is an **operational MISS to record, not fix here**: this seat does not restart or upgrade the worker (a hard forbid). If the live box still shows 13.24.1, note it when rolling status up to the Prioritizer so the worker gets restarted onto the current plugin out-of-band. If the running worker already matches the package version, this MISS is closed.

## Prerequisites

The claude-mem worker must be running locally. This seat talks to the **local worker** (per-UID port ~`37700`), never the cloud CMEM MCP — cloud `observation:<base64>` ids are a different API and must not be mixed in.

**Resolve the worker port** once and reuse `$WORKER_PORT` in every curl below. This snippet is copied from the `timeline-report` skill and honors `CLAUDE_MEM_WORKER_PORT` → `~/.claude-mem/settings.json` → the per-UID default `37700 + (uid % 100)`:

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

Do **not** hardcode port `37777` — ports are per-UID.

## Settings

Defaults live in `SettingsDefaultsManager.ts`; override in `~/.claude-mem/settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `CLAUDE_MEM_CCS_ALIGN_ENABLED` | `true` | Master switch for the seat. |
| `CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS` | `ccs-align` | Comma-separated viewer ids the seat maintains a cache for. |
| `CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES` | `decision,bugfix,security_alert,sensitive` | Needle observation types to pull (copied from #3931's list, D6). |
| `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS` | `false` | Phase 2 rules-shadow patch gate. When `true`, the rules walker removes `SHADOW_HOUSE` duplicate lines from leaf files (atomic temp+rename). Default **off** — report-only. |

Pilot viewer id is `ccs-align`. The seat **may read** LFG observations (agent id `521e962d-2ec3-4488-bfbc-54d5209ce118`) as a project filter, but **must not write** LFG/Orifice monthly logs or any `profile.md`.

## Hourly cycle (Appendix A runbook)

Run this every hour on a weekday house board. One purpose. No watercooler. No "while I was here I also…".

```
every hour (weekday house board):
  1. Resolve WORKER_PORT (snippet above)
  2. GET /api/health || GET /health   → abort with a one-line miss if down
  3. search(obs_type=needles, limit=20) since cursor.lastObservationId
  4. timeline(anchor=newest)          → collect neighbor ids
  5. get_observations(ids=…)
  5b. (Phase 1, mark-time only) If excluding: get_tool_uses for tool ids → record on mark
  6. grab middle.jsonl → append new → filter exclude-marks → replace atomic
  7. if original-cache path set and not writable: append-only to middle.jsonl (already done)
  8. update cursor.json
  9. every 6th hour: rules walk → append rules-report.md   (Phase 2 — see below)
 10. Speak to Alex only on red (worker down, write refused, unexpected profile.md touch)
```

### Step 1 — Resolve the port

Use the `$WORKER_PORT` snippet above.

### Step 2 — Prove worker health (prefer `/api/health`)

Prefer `GET /api/health`; also accept the viewer alias `GET /health`. The public worker docs still show `GET /health` and a `port` field — both are stale. Health does **not** return a port; use `GET /api/stats` (`worker.port`) if you need it.

```bash
curl -sS "http://127.0.0.1:${WORKER_PORT}/api/health" || curl -sS "http://127.0.0.1:${WORKER_PORT}/health"
# expect a JSON body with "status":"ok". If the worker is down, abort with a
# one-line miss — do NOT start it, do NOT retry aggressively.
```

If health cannot be proven (e.g. no live worker in a cloud VM), record a **MISS** and stop. Do not fabricate a cache cycle.

### Step 3 — Pull through the three-layer ladder (in order)

The disclosure order is **`search` → `timeline` → `get_observations`**. Never jump straight to `get_observations`, and do **not** call `get_tool_uses` in Phase 0 (that is Phase 1).

1. **`search`** with the needle `obs_type` list (`CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES`), `limit` ≤ 20, optionally scoped by `project`. Use the cursor's `lastObservationId` to avoid re-pulling the whole diary.

   ```bash
   curl -sS "http://127.0.0.1:${WORKER_PORT}/api/search?query=*&type=decision&limit=20&format=json"
   ```

2. **`timeline`** anchored on the newest hit. The worker's **code default depth is 10** (`SearchManager.ts`) — the MCP text that says "3" is stale, so omit the depths (worker applies 10) or pass `10` explicitly.

   ```bash
   curl -sS "http://127.0.0.1:${WORKER_PORT}/api/timeline?anchor=<newestObservationId>"
   ```

3. **`get_observations`** for the ids you will actually cache.

   ```bash
   curl -sS -X POST "http://127.0.0.1:${WORKER_PORT}/api/observations/batch" \
     -H 'content-type: application/json' \
     -d '{"ids":[12345,12346]}'
   ```

The MCP twins are `search` → `timeline` → `get_observations`. Worker `get_observations` ids are **numbers**; do not pass cloud `observation:<base64>` ids into `/api/observations/batch`.

### Step 4 — Grab → append → filter exclude-marks → replace (atomic middle cache)

Land the observations with the seat helper `src/services/integrations/CcsAlignMiddleCache.ts`
(`landObservationsInMiddleCache`). It copies the #3931 atomic primitive
(`appendAwarenessLineAtomic` + `awarenessLineBody`) with exactly three changes:
the tag is `[ccs-align]`, the path root is `~/.claude-mem/ccs-align/<viewerId>/`,
and the file is `middle.jsonl`.

Phase 1 adds an exclude-marks filter inside the atomic pipeline:

```
grab:    read middle.jsonl if it exists, else empty
filter:  load exclude-marks.json; drop any record whose id is marked
append:  for each new observation id not already present AND not marked, append one record
replace: write temp + rename (copy appendAwarenessLineAtomic; never appendFileSync)
fallback: if an OPTIONAL original-cache path is set and not writable, skip grab/replace
          on that path and append timeline items to middle.jsonl only
```

There is **no compiled laminate file in-repo**, so the fallback resolves to
"append to the seat file" — never invent a laminate.

Each line of `middle.jsonl` is one record. The shape is **locked** for Phase 0 (do not add fields):

```json
{
  "v": 1,
  "id": 12345,
  "type": "decision",
  "title": "…",
  "created_at": "2026-09-09T00:00:00.000Z",
  "project": "claude-mem",
  "agent_id": null,
  "source": "worker",
  "line": "- 2026-09-09 [ccs-align] decision — …"
}
```

`line` is `formatCcsAlignLine` — the #3931 `formatAwarenessLine` with the tag
swapped and the same 500-char truncation. Dedupe is by observation `id` **and**
by body (the line from `[ccs-align]` onward, date excluded), so the same fact on
a new day is still skipped and the file does not grow on a repeat cycle.

A minimal invocation (bun/node):

```ts
import { landObservationsInMiddleCache } from '../../src/services/integrations/CcsAlignMiddleCache.js';

landObservationsInMiddleCache({
  viewerId: 'ccs-align',
  observations: rowsFromGetObservations, // [{ id, type, title, subtitle, facts, created_at, project, agent_id }]
});
```

It **never throws** into the caller — a broken write path is logged and swallowed.

### Step 5 — Update the cursor

Write `~/.claude-mem/ccs-align/<viewerId>/cursor.json` so the next hour does not re-pull the whole diary:

```json
{ "lastRunAt": "…", "lastObservationId": 12345, "healthPath": "/api/health", "workerPort": 37700 }
```

Use `writeCursor` from the helper (atomic temp + rename).

### Step 6 — Speak only on red

Roll status **up** to the Prioritizer. Only speak to Alex on red: worker down, a write was refused, or an unexpected `profile.md` touch. Otherwise stay quiet.

## Phase 1 — Exclude marks

"Purge" means the compiled `middle.jsonl` no longer contains the observation or its tool I/O for that viewer. The diary stays. This is Secure Isolated Awareness + context-stripper — **not** delete.

### Exclude-marks file

Each viewer has `~/.claude-mem/ccs-align/<viewerId>/exclude-marks.json`:

```json
{
  "v": 1,
  "marks": [
    {
      "observationId": 12345,
      "toolUseIds": ["toolu_01abc", 678],
      "reason": "sibling-wall|manual|stripper|secure-isolation",
      "markedAt": "2026-09-09T00:00:00.000Z",
      "markedBy": "ccs-align"
    }
  ]
}
```

Marks are managed by `addExcludeMark` / `removeExcludeMark` in `CcsAlignMiddleCache.ts`, or by manual JSON edit.

### How marks get created (v1)

1. **Manual JSON edit** — open `exclude-marks.json` and add a mark entry.
2. **Skill flag** — `exclude <observationId> --reason …` (manual, sibling-wall, stripper, secure-isolation).
3. No auto-promotion from chat text (poison surface — see Memory dig findings).

### Purge tools (compiled only)

When recording tool-use ids on a mark:

1. After `get_observations`, if you need tool ids, call `get_tool_uses` / `POST /api/tool-uses/batch` (layer 4).
2. Record those ids on the mark's `toolUseIds` array.
3. **Never persist raw `tool_input` / `tool_response` into `middle.jsonl`** — layer 4 stays out of the laminate.
4. **Do not** call `DELETE /api/observation/:id` — that tombstones the diary and breaks rebuild-from-history.

> **Warning:** `get_tool_uses` is **layer 4** of the progressive disclosure ladder. It returns raw tool I/O and should only be called at mark-time to capture tool-use ids for an exclude mark. Never call it during the normal hourly cycle. Never persist its `tool_input` / `tool_response` payloads into any cache file.

### Unmark + rebuild

To restore a previously excluded observation:

1. Remove the mark from `exclude-marks.json` (`removeExcludeMark` or manual edit).
2. Re-pull the diary through the three-layer ladder (`search` → `timeline` → `get_observations`).
3. Call `rebuildMiddleCache` to clear and re-land the compiled file from the authoritative diary.

The observation reappears in `middle.jsonl` on the next cycle because the diary was never touched.

### Viewer isolation

Each viewer's middle cache is independent:

- `~/.claude-mem/ccs-align/viewer-a/middle.jsonl`
- `~/.claude-mem/ccs-align/viewer-b/middle.jsonl`

Observations landed for viewer A never appear in viewer B's compiled file. Exclude marks for viewer A do not affect viewer B. This implements the Secure Isolated Awareness property: inject a unique eval token into viewer A's cache → run viewer B → assert A's token never appears in B's compiled file.

### Programmatic usage

```ts
import {
  addExcludeMark,
  removeExcludeMark,
  rebuildMiddleCache,
  ccsAlignExcludeMarksPath,
  readExcludeMarks,
} from '../../src/services/integrations/CcsAlignMiddleCache.js';

const marksPath = ccsAlignExcludeMarksPath(dataRoot, 'ccs-align');

// Mark an observation as excluded (with optional tool-use ids)
addExcludeMark(marksPath, 12345, ['toolu_01abc'], 'manual');

// Unmark and rebuild
removeExcludeMark(marksPath, 12345);
rebuildMiddleCache({
  viewerId: 'ccs-align',
  observations: allObservationsFromDiary,
  dataRoot,
});
```

## Hard forbids (every phase)

- ❌ `DELETE /api/observation/:id` — tombstone ≠ exclude mark; breaks rebuild-from-history.
- ❌ Writing LFG/Orifice `[awareness]` logs, or into any `agents/**/memory/log/` path.
- ❌ Writing `profile.md`, user-memory, or project memory.
- ❌ A top-of-prompt clock (timestamps belong on facts, not a cache header).
- ❌ `POST /api/context/semantic` (per-turn drip the awareness design forbids).
- ❌ A sixth `processAgentResponse` consumer — CCS Align **pulls**; #3931 owns that seam.
- ❌ Restarting the worker, or `POST /api/settings`.
- ❌ Addressing the human as "Az". Always **Alex**.
- ❌ Claiming a context compiler / brainbeat shipped. Those are future work.
- ❌ "Fixing" deny/allow by flipping rules — report only.
- ❌ Copying house text into seats — that is the bug this phase detects.
- ❌ Building a `.cas` compiler so the report looks smarter.
- ❌ Patching standing / Focus / always / never / danger files.
- ❌ Attention trough / curse-salience experiments (Phase-N backlog only).

## Phase 2 — Rules alignment (house → project → seat)

Every 6th hour of the hourly Worker Watch cycle (D4), the seat walks house → project → seat layers to detect and report rules conflicts. This is a **checklist**, not a parser. No `.cas` compiler.

### Cascade rules (from Notion CCS)

- Write once at HOUSE; seats inherit
- A leaf copy **shadows** the cascade (bug, not feature)
- Deny beats allow
- Siblings deny heavy buckets (`obs`, `note`, `person`) by default
- Fail closed: if no rule exists, deny

### Layer walk

| Layer | Where to look (house box) | Bucket |
|---|---|---|
| House | `user-memory/` shared profile; Notion CCS `:root` | `profile`, `standing`, `owns` |
| Project | `.cmem-projects/<project>/`, repo `CLAUDE.md` | project overrides |
| Seat | `agents/<uuid>/profile.md`, `agents/<uuid>/memory/` | leaf — must not duplicate house |

On a box with no agent-data tree, the report records `MISS: house-box paths` and exits cleanly.

### Conflict classes (v1)

| Code | Pattern | Agency |
|---|---|---|
| `SHADOW_HOUSE` | Leaf file contains a line that also exists at house (or starts with `House rule`) | Dry-run remove-from-leaf; apply only if `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true` |
| `DENY_ALLOW` | Same bucket allow at one layer, deny at another | Report only |
| `DRIFT` | House text changed; leaf still has old wording (partial prefix match) | Report only |
| `CLOCK_HEADER` | Top-of-prompt clock / "current time is" in a profile | Report only (house rule: no clock in the prefix) |

### Rules report

Output: `~/.claude-mem/ccs-align/<viewerId>/rules-report.md` — dated, append-only sections. Each run appends a new section with a timestamp, a table of conflicts, any MISS entries, and a patches-applied count. Status rolls **up** to Prioritizer (never peer spam).

### Limited patch (D8 default off)

When `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true`:

1. Only `SHADOW_HOUSE` conflicts are patched — never `DENY_ALLOW`, `DRIFT`, or `CLOCK_HEADER`.
2. The would-be diff is written into the report **before** any patch is applied.
3. The leaf file is copied, duplicate lines are stripped, and the file is replaced atomically (temp + rename, same primitive as `CcsAlignMiddleCache`).
4. **Never patches `standing` / Focus / `always.md` / `never.md` / `danger.md` / `profile.md`.**
5. House files are never modified.

### Programmatic usage

```ts
import {
  walkRules,
  discoverLayerPaths,
  type RulesWalkerConfig,
} from '../../src/services/integrations/CcsAlignRulesWalker.js';

// Discover paths on the current box
const paths = discoverLayerPaths({ project: 'claude-mem' });

const config: RulesWalkerConfig = {
  dataRoot: '~/.claude-mem',
  viewerId: 'ccs-align',
  patchShadows: false,  // report-only by default
  housePaths: paths.housePaths,
  projectPaths: paths.projectPaths,
  seatPaths: paths.seatPaths,
};

const result = walkRules(config);
// result.conflicts — array of detected conflicts
// result.misses — paths that were not found
// result.reportPath — path to the appended rules-report.md
// result.patchesApplied — number of SHADOW_HOUSE lines removed (0 if patchShadows=false)
```

## Phase 3 — Verify / sign-off (plan §3)

Phase 3 closes the plan loop. It proves the seat is hourly-runnable, documented, and honest about what it is not — it does **not** add runtime behavior.

**Prove the boundary, not the code (§3.1):**

- One scripted cycle: health → `search` → `timeline` → `get_observations` → `middle.jsonl`.
- A second cycle produces no duplicate lines (dedupe holds).
- Exclude one id → gone from the middle cache, still returned by the worker (`GET /api/observation/N`).
- A rules report is produced (or an explicit `MISS` on a box with no agent-data tree).
- User-facing strings say **Alex**, never "Az"; no "context compiler shipped / brainbeat is live / we compiled awareness" claims (only future / not-this-plan wording).

**Prove nothing regressed (§3.2):** run the tests in the Verification section below, including the #3931 pusher and transcript tests. #3931 behavior must stay: LFG/Orifice still get `[awareness]` lines from the **worker pusher**, not from Align.

**Anti-pattern grep (§3.3):** no `DELETE /api/observation`, no `notifyGrokBotAwareness`, no `processAgentResponse` reuse in the seat helpers (forbid/comment mentions are fine — the seat must not *use* them).

**Sign-off (§3.4):** this skill can be run by a Worker Watch seat with no extra product context; the shipped defaults still match the D-rows; the Prioritizer can roll this up as "CCS Align Phase 0 green / Phase 1 marks / Phase 2 report."

See `plans/2026-09-09-ccs-align.md` §3 for the full contract.

## Later phases (documented, not implemented)

- **Full brainbeat / context compiler / `.cas` runtime** — future work, paper scaffold, out of this plan.
- **Attention trough / curse-salience, Focus/mouth egress enforcement** — different agents / backlog; hard forbids here.

See `plans/2026-09-09-ccs-align.md` "Explicit non-goals" for the full list.

## Verification (Phase 0 + Phase 1 + Phase 2)

```bash
bun test tests/integrations/ccs-align-middle-cache.test.ts
# Phase 0: format/truncate, needle match, append, dedupe, path safety, never-throw, cursor round-trip
# Phase 1: mark drop, diary present, tool ids not in middle.jsonl, viewer isolation,
#           unmark+rebuild, exclude-marks round-trip, buildExcludeSet, secure-isolation,
#           corrupt marks fail-closed, marked ids skipped on ingest

bun test tests/integrations/ccs-align-rules-walker.test.ts
# Phase 2: SHADOW_HOUSE detection (exact dup + "House rule" prefix), default report-only
#           (leaf unchanged), patchShadows=true (leaf loses duplicates, house unchanged),
#           never patches standing/always/never, MISS on absent paths, CLOCK_HEADER detection,
#           DENY_ALLOW detection, DRIFT detection, append-only report, atomic patch,
#           full walkRules integration, edge cases

# #3931 must not regress — LFG/Orifice still get [awareness] lines from the worker pusher, not Align
bun test tests/integrations/grok-bot-awareness-pusher.test.ts
```

Verification greps (plan §2.3):

```bash
# Report path documented
rg -n "rules-report" plugin/skills/ccs-align/SKILL.md
# expect ≥1

# Patch gated
rg -n "CCS_ALIGN_PATCH_SHADOWS" plugin/skills/ccs-align/SKILL.md
# expect ≥1
```

Live-box checks (house, not CI — a cloud VM may have no live worker; record a MISS if so):

- `curl -sS "http://127.0.0.1:$WORKER_PORT/api/health"` returns `status: ok`
- After one cycle, `~/.claude-mem/ccs-align/ccs-align/middle.jsonl` exists
- A second cycle with the same observations does **not** grow the file (dedupe)
- Mark observation N → next cycle drops N from `middle.jsonl`
- SQLite / `GET /api/observation/N` still returns the row (diary is authoritative)
- Linked tool-use ids on the mark never appear in `middle.jsonl`
- Viewer B's cache does not contain viewer A's unique eval token
- Unmark (remove from JSON) + cycle restores N on the next pull
- `profile.md` under any `agents/` path is byte-identical to before
- LFG/Orifice `memory/log/YYYY-MM.md` unchanged by Align
