---
type: report
title: "Issues Triage Report — 2026-03-29"
created: 2026-03-29
tags:
  - triage
  - issues
  - claude-mem
related:
  - "[[Phase-01-Close-Duplicates-And-Stale-Issues]]"
  - "[[Phase-02-Fix-Dirname-And-Worker-Startup]]"
---

# Issues Triage Report — 2026-03-29

**Repository:** thedotmack/claude-mem
**Triage Date:** 2026-03-29
**Triaged By:** issues-triage-3-29-2026 (Maestro agent)

## Summary

| Metric | Count |
|--------|-------|
| Total issues before triage | 112 |
| Issues closed during triage | 18 |
| Remaining open issues | 94 |

## Closed Issues

### Duplicate Issues (8 closed)

| # | Title | Duplicate Of |
|---|-------|-------------|
| #1419 | Worker service fails on non-developer machines due to hardcoded __dirname in CJS bundle | #1410 |
| #1428 | Hardcoded __dirname in worker-service.cjs breaks mode file loading on non-dev machines | #1410 |
| #1433 | Hardcoded __dirname in worker-service.cjs prevents DB initialization | #1410 |
| #1434 | worker-service.cjs: __dirname hardcoded to developer's local path, breaks database initialization | #1410 |
| #1437 | v10.6.1: Worker daemon fails to start - esbuild inlines __dirname with developer's local path | #1410 |
| #1438 | Bundled worker-service.cjs hardcodes developer paths, breaking daemon spawn and mode loading | #1410 |
| #1396 | [10.6.0] Setup hook references setup.sh that doesn't exist in package | #1340 |
| #1521 | Security issue: possible command injection in GitHub Actions workflow | #1285 |

### Vague / Non-Actionable Issues (7 closed)

| # | Title | Reason |
|---|-------|--------|
| #1492 | Bug Report | Generic title, no repro steps or details |
| #1436 | bug | No description, no steps to reproduce |
| #1362 | (Chinese, no repro) | No reproduction steps or error details |
| #1385 | mem still not save | Insufficient details to diagnose |
| #1488 | Consumed 25% of my tokens | Usage concern, not a bug |
| #1459 | Featured in awesome-claude-code-workflows | Community celebration, not actionable |
| #1378 | Test failure: test run failed | No test output or version info |

### Stale / Superseded Issues (3 closed)

| # | Title | Reason |
|---|-------|--------|
| #1268 | (regression) | Fixed in 10.6.x+ releases |
| #1137 | (plan mode pending messages) | Superseded by #1262 |
| #1219 | version bump to 10.4.1 | Version long since superseded |

## Remaining Open Issues by Root Cause

### root:worker-lifecycle (23 issues)

| # | Title | Priority |
|---|-------|----------|
| #1410 | bug: hardcoded __dirname in worker-service.cjs prevents initialization on end-user machines | P0 |
| #1435 | Binary embeds stale worker version (10.3.1) mismatching plugin version (10.6.1), causes infinite restart loop | P0 |
| #1490 | Worker daemon repeatedly killed by version mismatch shutdown, startup fratricide, and session SIGTERM | P0 |
| #1505 | SessionStart hooks fail on cold start: worker-start exits 137, context hook races worker | P0 |
| #1469 | Linux/WSL2: UserPromptSubmit fires before worker is ready - all observations silently dropped | P0 |
| #1420 | worker-service.cjs exits immediately on WSL (code 0, no output) | P0 |
| #1522 | /compact command causes worker crash requiring system reboot | P1 |
| #1477 | Hot session monopolizes SDK pool slots via infinite restart loop | P1 |
| #1447 | Worker startup race condition causes 2 SessionStart hook errors on every first session | P1 |
| #1446 | Stale worker PIDs in supervisor.json cause SessionStart:resume hook 500 errors | P1 |
| #1430 | Worker not available {} | P1 |
| #1426 | aggressiveStartupCleanup SIGKILLs hook process on cold start | P1 |
| #1423 | Worker daemon cold start exceeds POST_SPAWN_WAIT timeout (5s) on macOS ARM64 | P1 |
| #1412 | Error: Error calling Worker API: fetch failed (Mac Book) | P1 |
| #1399 | Windows worker service hangs with CLOSE_WAIT zombie sockets | P1 |
| #1397 | SessionStart context hook gets empty data on cold start (race condition) | P1 |
| #1392 | Windows: zombie socket holds port 37777 after worker crash, blocking restart | P1 |
| #1389 | SDK agent pool deadlock: idle processes block pool slots | P1 |
| #1323 | Race condition: Database not initialized error on session-init hook | P1 |
| #1289 | Worker silently fails init when 'node' not in PATH | P1 |
| #1266 | Loss of connection to MCPs even though localhost:37777 was active | P1 |
| #1245 | worker-service.cjs start subcommand causes SIGKILL under systemd | P1 |
| #1509 | Feature request: Support Node.js runtime via better-sqlite3 to avoid Bun memory leaks | P2 |

### root:windows (14 issues)

| # | Title | Priority |
|---|-------|----------|
| #1420 | worker-service.cjs exits immediately on WSL (code 0, no output) | P0 |
| #1366 | Windows: claude-mem 10.5.5 causes Claude Code hooks to hang, CLI becomes unresponsive | P0 |
| #1482 | claude-mem plugin breaks claude --print (pipe mode) on Windows | P1 |
| #1476 | Windows: aggressiveStartupCleanup WQL filter fails due to single-quote nesting in PowerShell | P1 |
| #1452 | Windows: bun-runner.js spawn ENOENT when bun is installed via npm shim | P1 |
| #1489 | Windows: chroma-mcp spawn fails with EINVAL when using uvx.cmd | P1 |
| #1399 | Windows worker service hangs with CLOSE_WAIT zombie sockets | P1 |
| #1395 | SessionEnd hook 'session-complete' fails with 'Hook cancelled' on Windows | P1 |
| #1392 | Windows: zombie socket holds port 37777 after worker crash | P1 |
| #1342 | mcp-server.cjs has CRLF line endings - shebang fails on macOS/Linux | P1 |
| #1281 | Windows: Stop hooks fail with MODULE_NOT_FOUND due to backslash path corruption | P1 |
| #1225 | Windows: chroma-mcp "Received request before initialization was complete" | P1 |
| #1503 | DEP0190 warning in bun-runner.js on Windows (Node 22+) | P2 |
| #1247 | smart-explore fails silently on Windows - tree-sitter CLI requires C compiler | P2 |

### root:chromadb (9 issues)

| # | Title | Priority |
|---|-------|----------|
| #1248 | chroma-mcp spins at 250-360% CPU indefinitely on macOS (v10.5.2) | P0 |
| #1369 | chroma-mcp subprocess leak: callTool and onclose null transport | P1 |
| #1361 | chroma-mcp processes leak after session exit, repeatedly downloading ONNX model (~15GB wasted) | P1 |
| #1297 | macOS: chroma-mcp crashes when CWD contains .env.local | P1 |
| #1261 | MCP Search fails with "Collection setup failed" error on cacheDir initialization | P1 |
| #1489 | Windows: chroma-mcp spawn fails with EINVAL when using uvx.cmd | P1 |
| #1225 | Windows: chroma-mcp "Received request before initialization was complete" | P1 |
| #1470 | ChromaDB search fails on WSL/Linux with SOCKS proxy - missing socksio | P2 |
| #1424 | chroma-mcp subprocess fails when ALL_PROXY uses socks:// scheme | P2 |

### root:session-integrity (12 issues)

| # | Title | Priority |
|---|-------|----------|
| #1262 | pending_messages queue grows unbounded, causes 100%+ CPU on startup | P0 |
| #1269 | CPU 100% caused by saved_hook_context in Claude Code session files | P0 |
| #1519 | Session completion can finalize too early when summarize is still in flight | P1 |
| #1514 | regenerate-claude-md.ts finds 0 observations despite data existing in database | P1 |
| #1511 | Session context not persisting between sessions despite previous work | P1 |
| #1360 | parseSummary creates empty SESSION SUMMARY records from observation responses | P1 |
| #1335 | Observer sessions trigger ECC's observe.sh hook - double Haiku loop | P1 |
| #1274 | Stop hook crashes with 'Transcript path missing' after context compaction | P1 |
| #1260 | Duplicate observations still occurring - concurrent hooks bypass content-hash dedup | P1 |
| #1234 | Stop hook crashes in git worktrees: transcript path not found | P1 |
| #1218 | feat: Add runtime self-healing for stuck processing messages and orphaned pending queues | P2 |
| #1359 | Viewer crashes: files_modified stored as bare path instead of JSON array | P2 |

### root:security (5 issues)

| # | Title | Priority |
|---|-------|----------|
| #1204 | `watch.context.path` in settings can write AGENTS.md content to arbitrary file paths | P0 |
| #1255 | Worker port collision causes cross-account data leakage on multi-user macOS systems | P0 |
| #1285 | [Security Issue] possible command injection in GitHub Actions workflow | P0 |
| #1493 | Sub-agents bypass user permission settings (permissionMode: 'default' hardcoded) | P0 |
| #1251 | Security Audit: Comprehensive Code Review of claude-mem | P1 |

### root:project-scoping (6 issues)

| # | Title | Priority |
|---|-------|----------|
| #1256 | basename(cwd) project detection causes data fragmentation in monorepos | P0 |
| #1458 | Projects with same folder name share memories due to basename-only scoping | P0 |
| #1473 | Codex and Claude sessions can bleed into the same context and viewer data | P1 |
| #1478 | Project resolver doesn't expand ~ to home directory path | P2 |
| #1318 | Feature Request: Workspace-Based Memory Isolation | P2 |
| #1320 | feat: per-project disable/exclude functionality | P2 |

### root:installer (8 issues)

| # | Title | Priority |
|---|-------|----------|
| #1471 | MCP server not registered - marketplace root .mcp.json is empty | P1 |
| #1497 | Update now fails: Marketplace directory not found | P1 |
| #1456 | OpenClaw installer fails when plugins.allow contains claude-mem | P1 |
| #1371 | Installer fails in a loop when plugins.allow is validated before plugin is installed | P1 |
| #1367 | OpenClaw plugin returns 401 when calling worker API | P1 |
| #1340 | Setup hook references missing scripts/setup.sh in v10.5.5 | P1 |
| #1242 | PR #1229 fallback path points to marketplace source, not installed cache | P1 |
| #1156 | np (npm publish tool) should be a devDependency, not a runtime dependency | P2 |

### root:mcp-schema (8 issues)

| # | Title | Priority |
|---|-------|----------|
| #1413 | search tool inputSchema missing query parameter | P1 |
| #1384 | MCP search/timeline tools have empty inputSchema properties, 3s API timeout | P1 |
| #1342 | mcp-server.cjs has CRLF line endings - shebang fails on macOS/Linux | P1 |
| #1331 | SSE new_prompt broadcast stops after /reload-plugins | P1 |
| #1266 | Loss of connection to MCPs even though localhost:37777 was active | P1 |
| #1263 | search (MCP) Worker API error (500) | P1 |
| #1471 | MCP server not registered - .mcp.json is empty | P1 |
| #1339 | Web UI #ID numbers don't match MCP get_observations IDs | P2 |

### root:aws-bedrock (2 issues)

| # | Title | Priority |
|---|-------|----------|
| #1496 | AWS Bedrock auth not supported in SDK pipeline (10.6.0+) | P1 |
| #1373 | AWS Bedrock env vars not passed to CLI subprocess - observations fail silently | P1 |

### Unlabeled / Standalone (15 issues)

| # | Title | Priority |
|---|-------|----------|
| #1390 | Default model CLAUDE_MEM_MODEL still set to claude-sonnet-4-5 instead of claude-sonnet-4-6 | P2 |
| #1484 | Feature request: CLAUDE_MEM_DISABLED env var for headless/agent sessions | P2 |
| #1464 | Feature: option to disable claude-mem context injection for spawned subagents | P2 |
| #1462 | Feature: Promote worktree observations to parent project after PR merge | P2 |
| #1431 | timeline-report script ignores custom port in settings.json | P2 |
| #1364 | Missing mode file for zh-TW (Traditional Chinese) | P2 |
| #1322 | Restore manual save_memory MCP tool for explicit memory creation | P2 |
| #1299 | mock.module() leak in context-reinjection-guard test pollutes parallel workers | P2 |
| #1284 | Integration idea: claude-brain for cross-machine memory sync? | P2 |
| #1273 | Feature Request: UUID observation IDs to enable multi-machine sync/merge | P2 |
| #1272 | Feature Request: Add option to disable subdirectory CLAUDE.md generation | P2 |
| #1265 | Feature Request: Display model name on observation/summary cards in web UI | P2 |
| #1259 | Gemini Flash Lite produces hallucinated observations; Gemini 2.5 Flash fixes it | P2 |
| #1252 | Feature request: Embedded/in-process mode for OpenClaw plugin | P2 |
| #943 | Feature Request: Support custom API endpoint / LiteLLM proxy | P2 |

## Priority Distribution

**Priority criteria:**
- **P0** = Blocks all users or is a security vulnerability
- **P1** = Affects a large user segment
- **P2** = Nice-to-have or single-user report

| Priority | Count | Description |
|----------|-------|-------------|
| P0 | 15 | Blocks all users or security vulnerability |
| P1 | 54 | Affects large user segment |
| P2 | 25 | Nice-to-have or single-user report |

## Multi-Label Issues

8 issues span multiple root-cause categories:

| # | Labels |
|---|--------|
| #1420 | root:worker-lifecycle, root:windows |
| #1399 | root:worker-lifecycle, root:windows |
| #1392 | root:worker-lifecycle, root:windows |
| #1489 | root:windows, root:chromadb |
| #1225 | root:windows, root:chromadb |
| #1342 | root:windows, root:mcp-schema |
| #1266 | root:worker-lifecycle, root:mcp-schema |
| #1471 | root:installer, root:mcp-schema |
| #1269 | root:worker-lifecycle, root:session-integrity |
| #1234 | root:worker-lifecycle, root:session-integrity |
| #1339 | root:session-integrity, root:mcp-schema |

## Next Steps

Six code-fix phases follow this triage:

1. **Phase 02: Fix __dirname and Worker Startup** - Replace hardcoded `__dirname` in esbuild bundle output, add retry loop for cold-start worker initialization, implement atomic restart lockfile to prevent startup stampede, and add structured failure diagnostics.

2. **Phase 03: Windows Platform Hardening** - Fix hook timeout/hang issues, zombie port timing, PowerShell escaping utility, CRLF `.gitattributes`, WQL process enumeration edge cases, and `isProcessAlive()` utility.

3. **Phase 04: ChromaDB Subprocess Lifecycle** - Add 60s health monitoring, CPU spin detection, process-group kill, `chromaPid` in worker.pid, `chromaAvailable` flag, and graceful SQLite fallback.

4. **Phase 05: Project Scoping and Session Integrity** - Consolidate project identity to parent/basename, implement `migrateProjectNames()` with legacy/ prefix, add early-finalization guard, session-scoped dedup unique index, and queue size limits.

5. **Phase 06: Security Fixes** - Fix GitHub Actions env block injection, add `isPathSafe()` allowlist utility, port collision project-identity warning, and hook input validation audit.

6. **Phase 07: Installer, MCP, and Remaining Fixes** - Reconcile setup.sh/smart-install.js, add MCP tool explicit property schemas, AWS Bedrock env passthrough, installer idempotency, SSE heartbeat/cleanup, and issue comment updates with commit refs.
