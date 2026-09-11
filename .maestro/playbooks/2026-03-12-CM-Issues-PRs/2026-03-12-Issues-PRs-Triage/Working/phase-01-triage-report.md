---
type: report
title: Phase 01 PR Triage Report
created: 2026-03-12
tags:
  - triage
  - pr-merge
  - issues
related:
  - '[[TRIAGE-01-PR-Review-And-Merge]]'
---

# Phase 01: PR Triage Report

## Summary

- **15 PRs reviewed** across 5 batches
- **14 PRs merged**, 1 closed as superseded
- **16 issues closed** (6 duplicates + 10 resolved by merged PRs)
- **3 PRs skipped** due to merge conflicts (need rebase)
- **1 PR flagged** for rework (dead code / not wired in)
- **Test suite verified**: 1135 passed, 3 skipped, 0 failures

---

## PRs Reviewed

### Batch 1 — Critical Bug Fixes (Data Correctness)

| PR | Title | Fixes | Status |
|----|-------|-------|--------|
| #1345 | Prevent LLM from using `<observation>` tags in summary responses | #1312 | MERGED |
| #1344 | Respect env vars and settings.json for DATA_DIR resolution | #1303 | MERGED |
| #1343 | Respect dateStart/dateEnd filters in Chroma search path | #1324 | MERGED |
| #1337 | smart-install.js outputs valid JSON for hook contract | #1253 | MERGED |
| #1336 | Null guard getChromaSync() when Chroma disabled | #1294 | MERGED |

### Batch 2 — Lifecycle and Hook Fixes

| PR | Title | Fixes | Status |
|----|-------|-------|--------|
| #1330 | Move session-complete from Stop to SessionEnd hook | #1314 | MERGED |
| #1325 | Prevent zombie subprocess accumulation | #1226, #1296 | MERGED |
| #1291 | Remove unrecognized fields from Stop hook output | #1288, #1290 | MERGED |
| #1326 | Gracefully handle missing transcript files in worktrees | #1234, #1235 | MERGED |
| #1264 | Older worktree transcript fix (superseded by #1326) | — | CLOSED (superseded) |

### Batch 3 — Data Integrity and Infrastructure

| PR | Title | Fixes | Status |
|----|-------|-------|--------|
| #1315 | Include SSE live data when project filter is active | #1313 | MERGED |
| #1308 | Auto-repair malformed database schema from cross-version sync | #1307 | MERGED |
| #1302 | Content-hash dedup for batch observation store methods | #1260 | MERGED |
| #1301 | Harden hook fallback and MCP node resolution | #1242, #1289 | SKIPPED (merge conflict, needs rebase) |

### Batch 4 — Standalone Fix PRs

| PR | Title | Fixes | Status |
|----|-------|-------|--------|
| #1341 | Merge SessionStart hooks to run sequentially | #1346 | MERGED |
| #1334 | Prevent infinite restart loop on FK constraint errors | — | MERGED |
| #1306 | Handle missing session_id when Cursor runs hooks | — | SKIPPED (merge conflict, needs rebase) |
| #1286 | Always pass --ssl flag to chroma-mcp in remote mode | — | MERGED |

### Batch 5 — Feature PRs

| PR | Title | Fixes | Status |
|----|-------|-------|--------|
| #1321 | Per-project disable/exclude functionality | #1320 | SKIPPED (merge conflict, needs rebase). Code review: APPROVED |
| #1319 | Workspace-based memory isolation | #1318 | NEEDS REWORK — dead code not wired into runtime, DRY violations |

---

## Issues Closed

### Duplicate Issues Closed (6)

| Closed | Duplicate Of | Topic |
|--------|-------------|-------|
| #1250 | #1248 | Chroma-mcp CPU runaway on Apple Silicon |
| #1235 | #1234 | Stop hook crashes in git worktrees |
| #1290 | #1288 | Stop hook output format / JSON validation |
| #1317 | #1256 | basename(cwd) project detection fragmentation |
| #1232 | #1261 | Chroma connection/setup failures |
| #1296 | #1226 | Orphaned/zombie process accumulation |

### Issues Resolved by Merged PRs (10)

| Issue | Title | Resolved By |
|-------|-------|-------------|
| #1312 | Summarize produces `<observation>` instead of `<summary>` | PR #1345 |
| #1303 | paths.ts ignores settings.json and env vars for DATA_DIR | PR #1344 |
| #1324 | MCP search ignores dateStart/dateEnd filters | PR #1343 |
| #1253 | SessionStart hook error from non-JSON smart-install output | PR #1337 |
| #1294 | Null crash on getChromaSync() when Chroma disabled | PR #1336 |
| #1314 | session-complete in Stop hook kills SDK agent | PR #1330 |
| #1226 | Process leak: worker never terminates subagent processes | PR #1325 |
| #1288 | Stop hook loops infinitely due to `{"continue":true}` | PR #1291 |
| #1313 | SSE live data discarded when project filter active | PR #1315 |
| #1307 | Schema migration failure on cross-version DB sync | PR #1308 |

---

## Test Results

- **1135 tests passed**, 3 skipped, 0 failures across 66 test files (19.48s)
- Build succeeded — all artifacts generated
- No regressions detected from merged PRs

---

## Remaining: PRs Needing Rebase (3)

These PRs were reviewed and approved but have merge conflicts after earlier batch merges:

| PR | Title | Action Needed |
|----|-------|---------------|
| #1301 | Harden hook fallback and MCP node resolution | Rebase onto main |
| #1306 | Handle missing session_id (Cursor compatibility) | Rebase onto main |
| #1321 | Per-project disable/exclude functionality | Rebase onto main |

## Remaining: PR Needing Rework (1)

| PR | Title | Issue |
|----|-------|-------|
| #1319 | Workspace-based memory isolation | Dead code — new files not wired into hooks.json or worker-service.ts. DRY violations with parallel code paths. Needs integration into existing handlers. |

## Remaining Open Issues (Still Need Code Fixes)

These 42 open issues were NOT addressed in Phase 01 and feed into subsequent triage phases:

| Issue | Title |
|-------|-------|
| #1346 | SessionStart hook errors on shared port 37777 (partially addressed by #1341) |
| #1342 | mcp-server.cjs has CRLF line endings — shebang fails on macOS/Linux |
| #1340 | Setup hook references missing scripts/setup.sh in v10.5.5 |
| #1339 | Web UI #ID numbers don't match MCP get_observations IDs |
| #1335 | Observer sessions trigger ECC's observe.sh hook — double Haiku loop |
| #1332 | OpenClaw plugin config: observationFeed blocked |
| #1331 | SSE new_prompt broadcast stops after /reload-plugins |
| #1323 | Race condition: Database not initialized error on session-init |
| #1322 | Restore manual save_memory MCP tool for explicit memory creation |
| #1320 | Per-project disable/exclude functionality (PR #1321 needs rebase) |
| #1318 | Workspace-based memory isolation (PR #1319 needs rework) |
| #1299 | mock.module() leak in context-reinjection-guard test |
| #1297 | chroma-mcp crashes when CWD contains .env.local |
| #1289 | Worker silently fails init when 'node' not in PATH (PR #1301 needs rebase) |
| #1285 | Possible command injection in GitHub Actions workflow |
| #1284 | Integration idea: claude-brain for cross-machine sync |
| #1281 | Windows: Stop hooks fail with MODULE_NOT_FOUND (backslash paths) |
| #1274 | Stop hook crashes with 'Transcript path missing' after context compaction |
| #1273 | UUID observation IDs for multi-machine sync/merge |
| #1272 | Add option to disable subdirectory CLAUDE.md generation |
| #1269 | CPU 100% caused by saved_hook_context in session files |
| #1268 | Claude code update breaks claude-mem |
| #1266 | Loss of connection to MCPs despite active localhost:37777 |
| #1265 | Display model name on observation/summary cards in web UI |
| #1263 | search (MCP) Worker API error (500) |
| #1262 | pending_messages queue grows unbounded, 100%+ CPU on startup |
| #1261 | MCP Search fails with "Collection setup failed" error |
| #1260 | Duplicate observations — concurrent hook triggers bypass dedup (PR #1302 merged, may need verification) |
| #1259 | Gemini Flash Lite produces hallucinated observations |
| #1256 | basename(cwd) project detection fragmentation in monorepos |
| #1255 | Worker port collision causes cross-account data leakage |
| #1252 | Embedded/in-process mode for OpenClaw plugin |
| #1251 | Security Audit: Comprehensive Code Review |
| #1249 | node→bun grandchild process SIGKILL'd in sandbox |
| #1248 | chroma-mcp 250-360% CPU on macOS |
| #1247 | smart-explore fails on Windows (tree-sitter needs C compiler) |
| #1245 | worker-service.cjs start causes SIGKILL under systemd |
| #1242 | Hook fallback path points to marketplace source (PR #1301 needs rebase) |
| #1234 | Stop hook crashes in git worktrees (PR #1326 merged — verify closed) |
| #1231 | Worker start reports success with stale PID file |
| #1225 | Windows: chroma-mcp "Received request before initialization" |
| #1219 | Bump version in plugin.json to 10.4.1 |
| #1218 | Runtime self-healing for stuck processing messages |
| #1204 | watch.context.path can write AGENTS.md to arbitrary paths |
| #1163 | Claude provider fails behind API proxy |
| #1156 | np should be devDependency, not runtime |
| #1137 | Plan mode triggers excessive pending message accumulation |
| #943 | Support custom API endpoint / LiteLLM proxy |

## Remaining Open PRs (Not Part of Phase 01)

These 45 open PRs were not reviewed in this phase — they are feature PRs, stale PRs, or address issues outside Phase 01 scope:

| PR | Title | State |
|----|-------|-------|
| #1348 | Feat/factory ai | Open |
| #1347 | Add comprehensive code analysis and optimization report | Open |
| #1338 | feat: add MiniMax M2.5 as a provider option | Open |
| #1333 | feat: add Codex CLI integration | Open |
| #1311 | feat: cowork modes — persistent memory for non-coding work | Open |
| #1310 | fix(openclaw): avoid /dev/tty crash in --non-interactive | Open |
| #1304 | feat: VS Code MCP integration with partner agent support | Open |
| #1298 | feat: use git root for consistent project name detection | Open |
| #1295 | fix(openclaw): fix worker startup race condition in installer | Open |
| #1283 | feat(cli): add comprehensive CLI with 11 commands | Open |
| #1258 | feat: npx claude-mem — unified CLI with 13 IDE integrations | Open |
| #1257 | feat: temporal scoring, staleness tracking, drift detection | Open |
| #1254 | fix: smart-install.js non-JSON stdout causes SessionStart error | Open |
| #1246 | feat: branch-scoped memory with git ancestry filtering | Open |
| #1233 | feat: add OpenCode platform integration | Conflicting |
| #1230 | feat(session-registry): registry UI and raw session browsing | Open |
| #1207 | feat: add GitHub Copilot provider | Open |
| #1198 | fix: migrate from bun:sqlite to better-sqlite3 | Open |
| #1191 | fix: use 'uvx' instead of 'uvx.cmd' on Windows | Open |
| #1189 | feat: add Claude model selection to installer | Open |
| #1186 | feat: Litestream cloud backup integration | Open |
| #1180 | fix: detect auth errors and prevent infinite retry loops | Open |
| #1177 | feat(provider): add OpenAI Codex OAuth provider | Open |
| #1169 | fix: deduplicate session-init to prevent redundant re-init | Open |
| #1164 | perf(memory): bound conversation history + lower Chroma footprint | Conflicting |
| #1151 | fix: make privacy tag stripping case-insensitive | Open |
| #1150 | fix: use nullish coalescing for promptNumber | Open |
| #1142 | Skip summary generation for subagent runs | Open |
| #1129 | feat: add generic session backfill script | Open |
| #1127 | feat: implement 5-stage observation processing pipeline | Open |
| #1102 | fix: critical bug fixes, snap sandbox support, resource monitoring | Open |
| #1101 | feat: interactive feed setup wizard and standalone daemon | Open |
| #1092 | fix: harden OpenClaw integration, auth chain, SSE stability | Open |
| #1088 | fix: use persistent venv instead of uvx | Open |
| #1085 | fix: eliminate unbounded process spawning with 4-layer defense | Open |
| #1083 | Add thoughts timeline | Open |
| #1078 | Add Spanish translations and Windows improvements | Open |
| #1072 | fix: add error handling for Stop hook package.json read errors | Open |
| #1064 | feat: sync imported observations to Chroma vector DB | Open |
| #996 | fix: preserve synthetic memorySessionId for stateless providers | Open |
| #854 | feat: Pro cloud sync integration with Supabase + Pinecone | Open |
| #474 | fix(windows): prevent libuv assertion failure in smart-install.js | Open |
