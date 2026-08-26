# Plan: First-Class gbrain Connector for claude-mem

Store claude-mem observations in [gbrain](https://github.com/garrytan/gbrain) (Garry Tan's open-source
agent memory system: markdown brain repo + PGLite/Postgres hybrid search + MCP).

**Shape:** an outbound sync connector modeled on ChromaSync, with two write lanes that share one
markdown renderer:

1. **Live trickle** — as each observation batch is stored, spawn
   `gbrain capture --stdin --slug <prefix>/<project>/obs-<id> --type note --json` per observation.
   Fire-and-forget, settings-gated, never blocks the write path.
2. **Backfill** — watermark-driven: render unsynced observations to a staging dir, run
   `gbrain import <dir> --no-embed --json` once, then `gbrain embed --stale`. This is gbrain's own
   documented bulk lane and the pattern its hermes-gbrain-bridge uses.

Both lanes are idempotent on gbrain's side (content-hash dedupe + deterministic slugs), and a
watermark state file (`~/.claude-mem/gbrain-sync-state.json`, copied from ChromaSyncState) prevents
re-exporting on our side.

---

## Phase 0: Consolidated Documentation Findings (COMPLETE — reference only)

### Allowed gbrain APIs (verified from source clone at scratchpad/gbrain, v0.46.x)

| Surface | Exact usage | Source |
|---|---|---|
| `gbrain capture` | `gbrain capture --stdin --slug SLUG --type note --source ID --json` (content via stdin; `--quiet` prints slug only) | `src/commands/capture.ts:1-140` |
| Default slug | `inbox/YYYY-MM-DD-<sha8>` when `--slug` omitted — we always pass `--slug` for determinism | `src/core/capture-content.ts:43` |
| `gbrain import` | `gbrain import <dir> [--no-embed] [--source-id <id>] [--json]` — bulk markdown dir, resumable | `src/commands/import.ts:324` |
| `gbrain embed --stale` | exact command to index after bulk import; exits 0 on keyless brains | `src/commands/embed.ts:79-124` |
| Page format | YAML frontmatter + markdown body; NO frontmatter field strictly required; explicit `type:`/`title:` win | `src/core/markdown.ts:130-140` |
| Capture stamping | gbrain stamps `captured_via`, `captured_at`; user frontmatter keys pass through and win | `src/core/capture-content.ts:145-199` |
| Config | `~/.gbrain/config.json`; `GBRAIN_HOME` relocates; PGLite default — **no Postgres or API keys required** | `src/core/config.ts:1467-1485` |

### Allowed claude-mem seams (verified in this repo)

| Need | Location |
|---|---|
| Hook point (live) | `src/services/worker/agents/ResponseProcessor.ts:583-604` — inside `syncAndBroadcastObservations`, adjacent to Chroma `syncObservation`, iterating `uniqueObservationIds` |
| Connector class template | `src/services/sync/ChromaSync.ts:98` (`syncObservation` :431, `ensureBackfilled` :717, watermark gating :472-482) |
| Watermark state template | `src/services/sync/ChromaSyncState.ts` (entire file — atomic tmp+rename JSON at `~/.claude-mem/`) |
| Settings-gate template | `src/services/integrations/TelegramNotifier.ts:67-107` (loadFromFile gate, per-item try/catch warn) |
| Obs→markdown renderer template | `src/services/worker/knowledge/CorpusRenderer.ts:27-68` (`renderObservation`) |
| In-flight obs type | `src/sdk/parser.ts:15` `ParsedObservation`; stored row `src/services/sqlite/types.ts:1` `ObservationRow` |
| Settings schema | `src/shared/SettingsDefaultsManager.ts:22-114` (interface), `:117-206` (DEFAULTS) — flat string JSON at `~/.claude-mem/settings.json` |
| Construction/gating | `src/services/worker/DatabaseManager.ts:20-88` (Chroma at :31-36, getter :82-88, close :52-66) |
| Boot backfill kick | `src/services/worker-service.ts:647-663` |
| Tilde expansion | `expandTilde` in `src/shared/paths.ts:74` (known prior bug when skipped — SettingsRoutes.ts:115-121) |
| Setup skill template | `plugin/skills/cloud-sync/SKILL.md` + `plugin/skills/mode-creator/scripts/configure-telegram.mjs` |
| Test templates | `tests/services/sync/chroma-sync-watermarks.test.ts` |

### Anti-patterns (things that DO NOT exist — never invent)
- ❌ No `gbrain` npm package (npm name is a squatter). CLI is installed via `bun install -g github:garrytan/gbrain`. Never `npm install gbrain`.
- ❌ No REST CRUD API. Only `POST /ingest` on `gbrain serve --http` (remote-brain scenario — out of scope v1).
- ❌ MCP `capture` does not accept file paths; `--file` is CLI-only.
- ❌ `gbrain sync` ignores uncommitted files — irrelevant here; we use `capture`/`import`, never `sync`.
- ❌ Do NOT import the connector (even transitively) from `src/servers/mcp-server.ts` — build hard-fails on `bun:sqlite` in that graph (`scripts/build-hooks.js:526`).
- ❌ Do NOT bump the watermark on partial success (ChromaSync.ts:472-482 is the correctness argument).
- ❌ Do NOT throw from the connector into the observation write path — warn-and-continue only.

---

## Phase 1: Core connector — renderer, state, GbrainSync class

**Files to create:**

1. `src/services/sync/GbrainMarkdown.ts`
   - `export function renderObservationMarkdown(obs: StoredObservationLike): string`
   - COPY the body structure from `CorpusRenderer.ts:27-68`; prepend YAML frontmatter:
     ```yaml
     ---
     type: note
     title: <obs.title>
     tags: [<concepts>]
     claude_mem:
       observation_id: <id>
       project: <project>
       obs_type: <type>
       memory_session_id: <sid>
       created_at: <iso>
       files_read: [...]
       files_modified: [...]
     ---
     ```
   - `export function observationSlug(prefix: string, project: string, id: number): string`
     → `<prefix>/<project>/obs-<id>` (sanitize project to slug-safe chars; deterministic → idempotent re-runs).
2. `src/services/sync/GbrainSyncState.ts`
   - COPY `ChromaSyncState.ts` wholesale; state file `gbrain-sync-state.json` in DATA_DIR;
     watermarks per project: `{ observations: number }` only (YAGNI — no summaries/prompts in v1).
3. `src/services/sync/GbrainSync.ts` — `export class GbrainSync`
   - Constructor takes settings snapshot: `{ cliPath, sourceId, slugPrefix, projectsFilter }`.
   - `static fromSettings(): GbrainSync | null` — gate copied from `TelegramNotifier.ts:68-84`:
     load `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`, return null unless
     `CLAUDE_MEM_GBRAIN_ENABLED === 'true'`. Resolve `cliPath` default `'gbrain'`, expandTilde on it.
   - `async syncObservation(observationId, project, obs: ParsedObservation, createdAtEpoch, memorySessionId): Promise<void>`
     - render markdown, spawn `gbrain capture --stdin --slug <slug> --type note --json`
       (+ `--source <id>` if configured), write markdown to stdin, 15s timeout.
     - Before spawning, check the process-spawn idiom already used in this repo: grep
       `spawn` under `src/` and copy the existing precedent (Bun.spawn vs child_process) —
       do not invent a new one.
     - On success: `state.bump(project, observationId)` (only advance, never regress).
     - On failure: `logger.warn` once per session per failure class; set an in-memory
       `disabledForSession` flag after 3 consecutive spawn failures (CLI missing etc.) so we
       don't fork-bomb a broken install. Never throw.
   - `async ensureBackfilled(project, store: SessionStore): Promise<void>`
     - watermark loop copied from `ChromaSync.ts:717-810` structure, but batch lane:
       query `ObservationRow`s with `id > watermark` for the project (reuse the store's
       existing query helpers — grep how ChromaSync fetches backfill rows and copy it),
       render each to `<scratch-staging>/<slugPrefix>/<project>/obs-<id>.md`,
       run `gbrain import <staging> --no-embed --json` once, then `gbrain embed --stale`;
       on confirmed success bump watermark to max id; clean staging dir.
     - **Verify first** (read `scratchpad/gbrain/src/commands/import.ts`): confirm import derives
       slug from file path relative to the import root, so staged paths produce the SAME slugs as
       the capture lane. If it does not, write explicit `slug:` frontmatter into staged files instead.
   - Cap: if unsynced rows for a project exceed 5,000, log the count and process in 1,000-row
     chunks with watermark bump per chunk (no silent truncation).

**Per Fail-Fast pillar:** happy path first; the only try/catch allowed in Phase 1 is the outer
fire-and-forget boundary (matching TelegramNotifier/ChromaSync precedent, which IS the established
boundary for outbound connectors — errors are logged, never swallowed silently).

**Verification checklist:**
- [ ] `bun test` new unit tests pass (Phase 4 adds them; here: code compiles via `npm run build`)
- [ ] `grep -n "throw" src/services/sync/GbrainSync.ts` — no throws escaping public methods
- [ ] slugs match between capture lane and import lane (documented check above)

---

## Phase 2: Wiring — settings, DatabaseManager, ResponseProcessor, boot backfill

1. `src/shared/SettingsDefaultsManager.ts`
   - Interface (~line 96, next to Telegram block) + DEFAULTS (~line 188):
     ```
     CLAUDE_MEM_GBRAIN_ENABLED: 'false'
     CLAUDE_MEM_GBRAIN_CLI_PATH: ''            // '' → 'gbrain' from PATH
     CLAUDE_MEM_GBRAIN_SOURCE: ''              // optional gbrain --source id
     CLAUDE_MEM_GBRAIN_SLUG_PREFIX: 'claude-mem'
     CLAUDE_MEM_GBRAIN_PROJECTS: ''            // '' = all projects; else comma-separated allowlist
     CLAUDE_MEM_GBRAIN_BACKFILL_ENABLED: 'true'
     ```
2. `src/services/worker/DatabaseManager.ts`
   - Construct in `initialize()` mirroring Chroma at :31-36; add `getGbrainSync(): GbrainSync | null`
     mirroring :82-88; null out in `close()` (:52-66).
3. `src/services/worker/agents/ResponseProcessor.ts`
   - Inside `syncAndBroadcastObservations`, adjacent to the Chroma block (:583-604): for each
     `uniqueObservationIds[i]`, `void gbrainSync.syncObservation(...).catch(logger.warn)` —
     copy the exact fire-and-forget `.then/.catch` style of the Chroma call.
   - Respect `CLAUDE_MEM_GBRAIN_PROJECTS` filter (empty = all).
4. `src/services/worker-service.ts` (:647-663 area)
   - If gbrain enabled + backfill enabled: kick `GbrainSync.backfillAllProjects(store)`
     non-blocking at boot, mirroring the ChromaSync block exactly.

**Anti-pattern guards:** no changes to `storeObservations`; no awaits added to the store path;
gbrain code must not be imported by `src/servers/mcp-server.ts` graph.

**Verification checklist:**
- [ ] `npm run build` succeeds (proves mcp-server graph guard passed)
- [ ] `grep -n "GBRAIN" src/shared/SettingsDefaultsManager.ts` shows all 6 keys in both interface and DEFAULTS
- [ ] `grep -n "getGbrainSync" src/services/worker/` shows construction + call site

---

## Phase 3: Setup skill — `plugin/skills/gbrain/`

Skills are git-tracked source authored directly under `plugin/skills/` (no src/ build step).

1. `plugin/skills/gbrain/SKILL.md` — COPY structure from `plugin/skills/cloud-sync/SKILL.md`
   (frontmatter: `name: gbrain`, description triggers: "connect gbrain", "store memories in gbrain",
   "gbrain sync", "set up gbrain"; `allowed-tools: [Bash, Read, AskUserQuestion]`). Flow:
   - Check CLI: `gbrain --version` / `gbrain doctor` (offer install one-liner
     `bun install -g github:garrytan/gbrain` if missing — never npm).
   - Ask for optional source id / slug prefix / project filter.
   - Run `scripts/configure-gbrain.mjs` to write settings.
   - Restart worker (same command cloud-sync uses), then verify: trigger a test capture and
     `gbrain query` for it.
2. `plugin/skills/gbrain/scripts/configure-gbrain.mjs` — COPY
   `plugin/skills/mode-creator/scripts/configure-telegram.mjs` (data-dir resolution, read/merge
   settings.json, atomic tmp+rename write, chmod 0600), swapping in the 6 GBRAIN keys.

**Verification checklist:**
- [ ] `node plugin/skills/gbrain/scripts/configure-gbrain.mjs --enabled true` (against a temp
      CLAUDE_MEM_DATA_DIR) writes exactly the expected keys and preserves unrelated ones
- [ ] frontmatter parses (compare shape to cloud-sync SKILL.md)

---

## Phase 4: Tests + final verification

Tests in `tests/services/sync/` (existing convention), modeled on `chroma-sync-watermarks.test.ts`:

1. `gbrain-markdown.test.ts` — renderer: frontmatter fields present, body sections match
   CorpusRenderer conventions, slug determinism + sanitization (project with spaces/slashes).
2. `gbrain-sync-state.test.ts` — watermark bump monotonicity, atomic persist, fresh-file defaults.
3. `gbrain-sync.test.ts` — with a **fake `gbrain` executable** (shell stub in test tmp dir writing
   argv+stdin to a log, exiting 0): syncObservation spawns correct argv, passes markdown on stdin,
   bumps watermark; disabled settings → no spawn; failing stub (exit 1) ×3 → disabledForSession,
   watermark NOT bumped.

**Final verification:**
- [ ] `bun test tests/services/sync/gbrain-*.test.ts` green
- [ ] `npm run build` green
- [ ] Anti-pattern greps:
      `grep -rn "npm install gbrain\|require('gbrain')\|from 'gbrain'" src/ plugin/` → empty
      (CLI-only integration; no fictional npm dep)
- [ ] `grep -rn "gbrain" src/servers/` → empty (mcp-server graph clean)
- [ ] End-to-end smoke IF `gbrain` CLI is installed locally: enable in a temp
      CLAUDE_MEM_DATA_DIR, capture one rendered observation, confirm `gbrain query` finds it.
      If CLI absent, the fake-executable test suite is the acceptance gate.
