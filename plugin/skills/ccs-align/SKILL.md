---
name: ccs-align
description: Run the CCS Align seat's hourly breathing cycle — prove the local claude-mem worker is healthy, pull needle observations through search → timeline → get_observations, and land them in a seat-owned middle cache via an atomic grab → append → replace. Use when asked to run CCS Align, breathe the alignment seat, refresh the middle cache, or check the Worker Watch board.
---

# CCS Align — Worker Watch seat (Phase 0: breathing slice)

CCS Align is a **standing seat**, not a bird's-eye planner. Its one job, once an hour: talk to the **local** claude-mem worker, pull recent needle observations through the existing three-layer disclosure ladder, and land them in a **seat-owned middle cache** using grab → append → replace.

This skill is the Phase 0 breathing slice of the plan of record, `plans/2026-09-09-ccs-align.md`. It is **not** a context compiler, **not** Focus/mouth, and **not** Grok Memory Phase 2. When you speak to the human, address them as **Alex**.

## What Phase 0 is (and is not)

Phase 0 proves the boundary, not a product:

- **Does:** health check → `search` → `timeline` → `get_observations` → append records to `~/.claude-mem/ccs-align/<viewerId>/middle.jsonl` (atomic, deduped).
- **Does not:** delete history, write `profile.md`, write LFG/Orifice `[awareness]` logs (that seam belongs to [#3931](https://github.com/thedotmack/claude-mem/pull/3931)), add a sixth `processAgentResponse` consumer, restart the worker, or run a per-turn drip update.

Later phases (exclude marks, rules alignment) are documented in the plan of record and are **not** implemented here.

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
| `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS` | `false` | Phase 2 rules-shadow patch gate. **Off** in Phase 0; documented only. |

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
  6. grab middle.jsonl → append new → filter exclude-marks → replace atomic
  7. if original-cache path set and not writable: append-only to middle.jsonl (already done)
  8. update cursor.json
  9. every 6th hour: rules walk → append rules-report.md   (Phase 2 — not in this slice)
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

### Step 4 — Grab → append → replace (atomic middle cache)

Land the observations with the seat helper `src/services/integrations/CcsAlignMiddleCache.ts`
(`landObservationsInMiddleCache`). It copies the #3931 atomic primitive
(`appendAwarenessLineAtomic` + `awarenessLineBody`) with exactly three changes:
the tag is `[ccs-align]`, the path root is `~/.claude-mem/ccs-align/<viewerId>/`,
and the file is `middle.jsonl`.

```
grab:    read middle.jsonl if it exists, else empty
append:  for each new observation id not already present, append one record
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

## Later phases (documented, not implemented here)

- **Phase 1 — Exclude marks:** compile-time omit of observations + linked tool-use ids from the middle cache; history stays; no `DELETE`. Marks file `exclude-marks.json`.
- **Phase 2 — Rules alignment:** house → project → seat conflict/drift **report** (`rules-report.md`). Report-only unless `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true`.
- **Phase 3 — Verify:** two-cycle dedupe, rebuild-from-diary, #3931 tests still green.

See `plans/2026-09-09-ccs-align.md` for the full contract.

## Verification (Phase 0)

```bash
bun test tests/integrations/ccs-align-middle-cache.test.ts
# format/truncate, needle match, append, dedupe, path safety, never-throw, cursor round-trip

# #3931 must not regress — LFG/Orifice still get [awareness] lines from the worker pusher, not Align
bun test tests/integrations/grok-bot-awareness-pusher.test.ts
```

Live-box checks (house, not CI — a cloud VM may have no live worker; record a MISS if so):

- `curl -sS "http://127.0.0.1:$WORKER_PORT/api/health"` returns `status: ok`
- After one cycle, `~/.claude-mem/ccs-align/ccs-align/middle.jsonl` exists
- A second cycle with the same observations does **not** grow the file (dedupe)
- `profile.md` under any `agents/` path is byte-identical to before
- LFG/Orifice `memory/log/YYYY-MM.md` unchanged by Align
