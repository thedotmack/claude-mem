---
name: ccs-align
description: Execute the CCS Align Worker Watch hourly synchronization cycle by verifying local claude-mem worker health, pulling needle observations through search → timeline → get_observations, landing records in a seat-owned middle cache via atomic grab → filter → append → replace, managing viewer-scoped exclude marks, and walking house → project → seat rule layers to append conflict reports to rules-report.md. Trigger when asked to run CCS Align, breathe the alignment seat, refresh the middle cache, exclude or restore an observation, walk rules, check rules conflicts, or check the Worker Watch board, excluding context compilation, per-turn drip updates, worker lifecycle mutations, and diary deletions.
---

# CCS Align Worker Watch Specification

## Operational Architecture and Phase Baseline

Execute CCS Align as a standing Worker Watch alignment seat on an hourly weekday cadence: query the local `claude-mem` worker, pull recent needle observations through the three-layer progressive disclosure ladder, land deduplicated records in a seat-owned middle cache (`~/.claude-mem/ccs-align/<viewerId>/middle.jsonl`) via atomic grab → filter → append → replace, and audit hierarchical rule layers every 6th hour.

Maintain the unified target state established in `plans/2026-09-09-ccs-align.md` across all shipped slices:

| Plan Slice | Reference | Operational Surface |
|---|---|---|
| **Phase 0 — Breathing Slice** | [#3934](https://github.com/thedotmack/claude-mem/pull/3934) | Execute health check → `search` → `timeline` → `get_observations` → atomic deduplicated append to `~/.claude-mem/ccs-align/<viewerId>/middle.jsonl`. |
| **Phase 1 — Exclude Marks** | [#3935](https://github.com/thedotmack/claude-mem/pull/3935) | Filter marked observations and linked tool-use IDs from compiled `middle.jsonl` while preserving SQLite diary authority and full rebuildability via unmark + rebuild. |
| **Phase 2 — Rules Alignment** | [#3936](https://github.com/thedotmack/claude-mem/pull/3936) | Walk `house → project → seat` rule layers every 6th hour (`D4`), detect `SHADOW_HOUSE`, `DENY_ALLOW`, `DRIFT`, and `CLOCK_HEADER` conflicts, append sections to `rules-report.md`, and gate atomic `SHADOW_HOUSE` leaf patching on `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true` (`D8`). |
| **Phase 3 — Verification and Sign-Off** | `plans/2026-09-09-ccs-align.md` §3 | Execute regression suites, anti-pattern greps, and live-box boundary proofs confirming deduplication, diary preservation under exclusion, rules report generation or explicit `MISS` logging, and strict scope adherence with zero added runtime surface. |

### Communication and Escalation Protocol

- Address the human operator strictly as **Alex** across all user-facing output:
  + `"Az"` ➔ `"Alex"`
- Roll routine operational status up to the **Prioritizer**, omitting peer-seat broadcasts and routine user notifications.
- Emit direct alerts to **Alex** strictly on red operational states: unreachable local worker, refused file write, or unexpected modification to any `profile.md` file.

### Operational Version Drift Protocol

Track version alignment between the repository (`package`, `plugin`, `marketplace` at version **13.24.5** for the Phase 3 patch) and the live house-box worker plugin:

- Record an operational `MISS` when rolling status up to the **Prioritizer** if the live house-box worker reports version **13.24.1** so an out-of-band operator restarts the worker onto the current plugin, excluding in-seat worker restarts or upgrades.
- Mark the version-lag `MISS` closed when the running worker version matches **13.24.5**.

## Scope Boundaries and Isolation Locks

Enforce the operational boundary of CCS Align through affirmative resource locks and explicit set-difference exclusions:

- **Local Worker Endpoint Exclusivity**: Communicate exclusively with the local `claude-mem` worker on the per-UID HTTP port (`~37700`), excluding cloud CMEM MCP endpoints, cloud `observation:<base64>` identifiers, hardcoded port `37777`, `POST /api/context/semantic` per-turn drip calls, `POST /api/settings` mutations, and worker process restarts.
- **Seat-Scoped Storage Authority**: Restrict file writes strictly to `~/.claude-mem/ccs-align/<viewerId>/` (`middle.jsonl`, `cursor.json`, `exclude-marks.json`, `rules-report.md`) and gated `SHADOW_HOUSE` leaf removals, excluding `DELETE /api/observation/:id` calls, A-MEM SQLite row rewrites, `profile.md` files, `user-memory/`, project memory, standing/Focus rule files (`always.md`, `never.md`, `danger.md`), and LFG/Orifice `[awareness]` monthly logs (`agents/**/memory/log/YYYY-MM.md`, owned by [#3931](https://github.com/thedotmack/claude-mem/pull/3931)).
- **Pull-Only Consumer Seam**: Pull observations on the hourly schedule and allow read-only project filtering on LFG observations (agent ID `521e962d-2ec3-4488-bfbc-54d5209ce118`), excluding a sixth `processAgentResponse` consumer or any `notifyGrokBotAwareness` invocation.
- **Checklist-Only Rules Inspection**: Evaluate rule layers via deterministic text checklists and report findings in `rules-report.md`, excluding `.cas` parsers, `compileAwareness()`, JIT compilation, computed-styles UIs, runtime parsing of Notion CCS teaching-copy types (`Bucket`, `canRead`), `DENY_ALLOW` rule flipping, house-to-seat text copying, and Focus/mouth egress filtering.
- **Out-of-Scope Backlog Isolation**: Restrict runtime claims and execution to Phases 0–3 of `plans/2026-09-09-ccs-align.md`, excluding per-unit-of-work `brainbeat` regeneration, Grok Memory Phase 2, attention-trough or curse-salience decay/scoring, and top-of-prompt clock headers (retaining timestamps strictly on individual fact lines).

## Runtime Prerequisites and Configuration Parameters

### Port Resolution Protocol

Resolve the local per-UID worker port once per cycle and reuse `$WORKER_PORT` across all HTTP requests, following the precedence chain `CLAUDE_MEM_WORKER_PORT` environment variable → `~/.claude-mem/settings.json` → per-UID default `37700 + (uid % 100)` (copied from `timeline-report`):

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

### Configuration Matrix

Load default parameters from `SettingsDefaultsManager.ts` and apply overrides from `~/.claude-mem/settings.json`:

| Key | Default | Operational Meaning |
|---|---|---|
| `CLAUDE_MEM_CCS_ALIGN_ENABLED` | `true` | Enable or disable execution of the CCS Align seat. |
| `CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS` | `ccs-align` | Specify comma-separated viewer IDs maintained by the seat (pilot viewer ID: `ccs-align`). |
| `CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES` | `decision,bugfix,security_alert,sensitive` | Define needle observation types pulled during search (inherited from [#3931](https://github.com/thedotmack/claude-mem/pull/3931), `D6`). |
| `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS` | `false` | Gate Phase 2 `SHADOW_HOUSE` leaf patching (`D8`); strip duplicate house lines via atomic temp+rename when `true`, or run report-only when `false`. |

## Hourly Execution Workflow

Execute the single-purpose Appendix A runbook once every hour on the weekday house board, excluding side tasks and opportunistic edits:

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

1. **Resolve Worker Port**: Evaluate `$WORKER_PORT` using the port resolution snippet.
2. **Verify Worker Health**: Query `GET /api/health` first and fall back to the viewer alias `GET /health` expecting a JSON payload containing `"status":"ok"` (treating public docs that reference `GET /health` with a `port` field as stale, and querying `GET /api/stats` for `worker.port` when port metadata is needed):
   ```bash
   curl -sS "[http://127.0.0.1](http://127.0.0.1):${WORKER_PORT}/api/health" || curl -sS "[http://127.0.0.1](http://127.0.0.1):${WORKER_PORT}/health"
   # expect a JSON body with "status":"ok". If the worker is down, abort with a
   # one-line miss — do NOT start it, do NOT retry aggressively.
   ```
   Record a one-line `MISS` and terminate the cycle immediately when health cannot be proven (such as in a cloud VM lacking a live worker), excluding worker startup attempts, retry loops, or synthetic cache cycles.
3. **Pull Observations via Progressive Disclosure Ladder**: Query the three-layer ladder strictly in the sequence `search` → `timeline` → `get_observations` (matching MCP twins `search` → `timeline` → `get_observations`), excluding direct jumps to `get_observations` and excluding Layer 4 `get_tool_uses` calls during standard hourly cycles:
   - **Layer 1 (`search`)**: Query needle `obs_type` values defined in `CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES` with `limit <= 20`, optionally filtered by `project`, advancing from `cursor.lastObservationId`:
     ```bash
     curl -sS "[http://127.0.0.1](http://127.0.0.1):${WORKER_PORT}/api/search?query=*&type=decision&limit=20&format=json"
     ```
   - **Layer 2 (`timeline`)**: Anchor on `<newestObservationId>` and apply the `SearchManager.ts` code default depth of `10` by omitting depth parameters or passing `10` explicitly (superseding stale MCP documentation stating `"3"`):
     ```bash
     curl -sS "[http://127.0.0.1](http://127.0.0.1):${WORKER_PORT}/api/timeline?anchor=<newestObservationId>"
     ```
   - **Layer 3 (`get_observations`)**: Fetch candidate records for caching via `POST /api/observations/batch` using numeric worker IDs, excluding cloud `observation:<base64>` identifiers:
     ```bash
     curl -sS -X POST "[http://127.0.0.1](http://127.0.0.1):${WORKER_PORT}/api/observations/batch" \
       -H 'content-type: application/json' \
       -d '{"ids":[12345,12346]}'
     ```
4. **Land Records in Atomic Middle Cache**: Persist retrieved observations through `landObservationsInMiddleCache` in `src/services/integrations/CcsAlignMiddleCache.ts`, which adapts the [#3931](https://github.com/thedotmack/claude-mem/pull/3931) atomic write primitive (`appendAwarenessLineAtomic` + `awarenessLineBody`) with three parameter substitutions (`[awareness] ➔ [ccs-align]`, root path `~/.claude-mem/ccs-align/<viewerId>/`, target file `middle.jsonl`) and swallows write errors after logging without throwing into the caller:
   ```
   grab:    read middle.jsonl if it exists, else empty
   filter:  load exclude-marks.json; drop any record whose id is marked
   append:  for each new observation id not already present AND not marked, append one record
   replace: write temp + rename (copy appendAwarenessLineAtomic; never appendFileSync)
   fallback: if an OPTIONAL original-cache path is set and not writable, skip grab/replace
             on that path and append timeline items to middle.jsonl only
   ```
   Write directly to the seat file `middle.jsonl` when fallback triggers, excluding creation of any in-repo compiled laminate file. Format each JSONL line according to the locked Phase 0 schema (preserving exact field keys):
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
     "line": "- 2026-09-09 [ccs-align] decision — «…»"
   }
   ```
   Generate `line` via `formatCcsAlignLine` to sanitize recalled text (stripping tag framing and invisible characters), fence the body in `«…»` truncated to `500` characters inside the fence, and deduplicate by both numeric `id` and date-excluded body (from `[ccs-align]` onward) so repeated facts across days leave file size unchanged:
   ```ts
   import { landObservationsInMiddleCache } from '../../src/services/integrations/CcsAlignMiddleCache.js';

   landObservationsInMiddleCache({
     viewerId: 'ccs-align',
     observations: rowsFromGetObservations, // [{ id, type, title, subtitle, facts, created_at, project, agent_id }]
   });
   ```
5. **Update Cursor State**: Write `~/.claude-mem/ccs-align/<viewerId>/cursor.json` atomically (temp + rename) via `writeCursor` to record the latest checkpoint:
   ```json
   { "lastRunAt": "…", "lastObservationId": 12345, "healthPath": "/api/health", "workerPort": 37700 }
   ```
6. **Execute Sixth-Hour Rules Walk and Escalate Anomalies**: Trigger the rules alignment walker on every 6th hour (`D4`), roll status up to the **Prioritizer**, and alert **Alex** strictly on red conditions.

## Exclude-Mark Management and Viewer Isolation

Filter excluded observations and linked tool I/O from the compiled `middle.jsonl` per viewer via `Secure Isolated Awareness` and `context-stripper` semantics while preserving the authoritative SQLite diary for deterministic rebuilds.

### Exclude-Marks Schema and Creation Channels

Store viewer-specific marks in `~/.claude-mem/ccs-align/<viewerId>/exclude-marks.json` (falling back to fail-closed behavior if the marks file is corrupt):

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

Create or update exclude marks exclusively through two authorized v1 channels, excluding automatic promotion from chat text (mitigating prompt-poisoning vectors identified in Memory dig findings):

- **Manual JSON Edit**: Edit `exclude-marks.json` directly to append or remove a mark entry.
- **Skill CLI Flag / Helper API**: Invoke `exclude <observationId> --reason …` (`manual`, `sibling-wall`, `stripper`, `secure-isolation`) or call `addExcludeMark` / `removeExcludeMark` in `CcsAlignMiddleCache.ts`.

### Mark-Time Layer 4 Tool-Use Capture

1. Query `get_tool_uses` / `POST /api/tool-uses/batch` (Layer 4 of the progressive disclosure ladder) strictly at mark-creation time after `get_observations` when tool-use identifiers must be attached to an exclude mark.
2. Record the returned identifiers inside the mark's `toolUseIds` array in `exclude-marks.json`.
3. Omit raw `tool_input` and `tool_response` payloads from `middle.jsonl` and all cache files, and preserve the SQLite diary intact by excluding `DELETE /api/observation/:id` calls and Layer 4 calls during normal hourly cycles.

### Unmark and Rebuild Workflow

1. Remove the target observation mark from `exclude-marks.json` using `removeExcludeMark` or manual JSON editing.
2. Re-pull the observation range from the authoritative diary through `search` → `timeline` → `get_observations`.
3. Invoke `rebuildMiddleCache` to clear and re-populate `middle.jsonl` from the diary rows.

### Viewer Cache Isolation

Maintain strict partition boundaries between viewer directories (`~/.claude-mem/ccs-align/viewer-a/middle.jsonl` versus `~/.claude-mem/ccs-align/viewer-b/middle.jsonl`) so observations and exclude marks scoped to viewer A remain absent from viewer B's compiled cache (verifiable by injecting a unique eval token into viewer A's cache, running viewer B, and asserting zero occurrences of A's token in B's `middle.jsonl`):

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

## Rules Alignment and Cascade Conflict Detection

Walk the `house → project → seat` hierarchy every 6th hour of the Worker Watch cycle (`D4`) using `src/services/integrations/CcsAlignRulesWalker.ts` to detect cascade violations and append results to `~/.claude-mem/ccs-align/<viewerId>/rules-report.md`.

### Notion CCS Cascade Principles

- Define shared baseline rules once at the `House` layer for inheritance across downstream seats.
- Classify duplicated house lines inside leaf seat files as cascade-shadowing defects (`SHADOW_HOUSE`).
- Enforce `deny` precedence over `allow` across all layers, default sibling seats to `deny` on heavy buckets (`obs`, `note`, `person`), and fail closed (`deny`) whenever an explicit rule is absent.

### Layer Walk and Conflict Classification Matrices

Inspect the three hierarchy layers on the house box, or record `MISS: house-box paths` in `rules-report.md` and exit cleanly when the agent-data tree is absent:

| Layer | Target Paths (House Box) | Bucket Scope |
|---|---|---|
| **House** | `user-memory/` shared profile; Notion CCS `:root` | `profile`, `standing`, `owns` |
| **Project** | `.cmem-projects/<project>/`, repo `CLAUDE.md` | Project overrides |
| **Seat** | `agents/<uuid>/profile.md`, `agents/<uuid>/memory/` | Leaf layer — inherits house rules without duplication |

Classify detected discrepancies across four v1 conflict codes:

| Code | Detection Pattern | Authorized Agency |
|---|---|---|
| `SHADOW_HOUSE` | Leaf file contains an exact duplicate of a house line or a line prefixed with `House rule` | Dry-run leaf removal in report; apply atomic leaf patch strictly when `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true` |
| `DENY_ALLOW` | Identical bucket is granted `allow` at one layer and `deny` at another | Report-only in `rules-report.md` |
| `DRIFT` | House rule text updated while leaf retains stale wording (partial prefix match) | Report-only in `rules-report.md` |
| `CLOCK_HEADER` | Profile file contains a top-of-prompt clock or `"current time is"` header | Report-only in `rules-report.md` (house rule forbids prefix clocks) |

### Report Generation and Gated Leaf Patching

Append a dated report section to `~/.claude-mem/ccs-align/<viewerId>/rules-report.md` on each walk containing the execution timestamp, conflict table, `MISS` entries, and `patchesApplied` count, then roll status up to the **Prioritizer**. When `CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS=true` (`D8`, default `false`), execute leaf patching under five strict constraints:

1. Restrict automated patching solely to `SHADOW_HOUSE` conflicts, leaving `DENY_ALLOW`, `DRIFT`, and `CLOCK_HEADER` in report-only mode.
2. Write the prospective diff into `rules-report.md` prior to modifying any target file.
3. Copy the target leaf file, strip duplicated house lines, and replace the leaf file atomically via temp + rename.
4. Preserve `standing`, Focus, `always.md`, `never.md`, `danger.md`, and `profile.md` files untouched.
5. Preserve all `House` layer files untouched.

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

## Verification and Sign-Off Protocol

Validate the complete Phase 0–3 contract defined in `plans/2026-09-09-ccs-align.md` (§2.3, §3.1–§3.4) before rolling sign-off up to the **Prioritizer** as `"CCS Align Phase 0 green / Phase 1 marks / Phase 2 report."`:

### Automated Test and Grep Suites

Execute the unit, integration, and regression suites (§3.2) ensuring [#3931](https://github.com/thedotmack/claude-mem/pull/3931) worker-pusher delivery of `[awareness]` lines to LFG/Orifice remains intact:

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

Verify skill documentation keys (§2.3) and confirm zero active calls to `DELETE /api/observation`, `notifyGrokBotAwareness`, or `processAgentResponse` inside seat implementation helpers (§3.3):

```bash
# Report path documented
rg -n "rules-report" plugin/skills/ccs-align/SKILL.md
# expect ≥1

# Patch gated
rg -n "CCS_ALIGN_PATCH_SHADOWS" plugin/skills/ccs-align/SKILL.md
# expect ≥1
```

### Live-Box Boundary Checklist

Verify end-to-end runtime invariants on the house box (§3.1, §3.4), or record an explicit `MISS` when running in a cloud VM lacking a live worker:

- Confirm `curl -sS "http://127.0.0.1:$WORKER_PORT/api/health"` returns `"status":"ok"`.
- Confirm `~/.claude-mem/ccs-align/ccs-align/middle.jsonl` is created after one full cycle (`health → search → timeline → get_observations → middle.jsonl`).
- Confirm a second cycle over identical observations produces zero duplicate lines in `middle.jsonl`.
- Confirm marking observation `N` removes `N` from `middle.jsonl` on the subsequent cycle while `GET /api/observation/N` continues returning the authoritative SQLite diary row.
- Confirm linked `toolUseIds` recorded on an exclude mark remain absent from `middle.jsonl`.
- Confirm viewer B's compiled `middle.jsonl` remains free of viewer A's unique evaluation token.
- Confirm removing observation `N` from `exclude-marks.json` and running a rebuild cycle restores `N` into `middle.jsonl`.
- Confirm `~/.claude-mem/ccs-align/ccs-align/rules-report.md` appends a dated report section (or records `MISS` on an absent agent-data tree).
- Confirm all `agents/**/profile.md` files and LFG/Orifice `memory/log/YYYY-MM.md` files remain byte-identical before and after the cycle.
- Confirm all user-facing strings address **Alex** and preserve shipped `D-row` defaults without claiming context-compiler or brainbeat deployment.
