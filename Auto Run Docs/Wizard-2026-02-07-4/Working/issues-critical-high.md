---
type: report
title: Critical & High-Priority Issues
created: 2026-02-07
tags:
  - triage
  - critical
  - high-priority
  - security
related:
  - "[[Issues-Medium-Low]]"
  - "[[PR-Triage]]"
  - "[[MASTER-REPORT]]"
---

# Critical & High-Priority Issues — Claude-Mem Repository

Report generated from live GitHub data on 2026-02-07. Covers all open issues in the `thedotmack/claude-mem` repository that are labeled `priority:critical`, `security`, or `priority:high`.

---

## Tier 1: Critical Security & Stability

These issues threaten data integrity, enable exploits, or cause system-wide failures. They should be addressed immediately.

### #982 — Security: Path Traversal in /api/instructions endpoint (CWE-22)
- **Summary:** The `/api/instructions` endpoint allows arbitrary file reads via path traversal in the `operation` query parameter, plus an object injection risk (CWE-1321) via the `topic` parameter.
- **Labels:** `security`, `priority:critical`
- **Author:** NakayoshiUsagi | **Created:** 2026-02-06
- **CVSS:** 7.5 (High) for path traversal, 5.3 (Medium) for object injection
- **Recommendation:** **KEEP** — Active security vulnerability enabling arbitrary file reads. Must be patched immediately. PR #1002 and #986 address this.

### #1010 — Worker daemon spawns orphaned claude-sonnet-4-5 subagent processes (~1/min, never cleaned up)
- **Summary:** The worker daemon continuously spawns `claude-sonnet-4-5` subagent processes that are never terminated, accumulating rapidly and consuming significant system resources (CPU, memory).
- **Labels:** `bug`, `priority:critical`
- **Author:** fuzzystripes | **Created:** 2026-02-07
- **Recommendation:** **KEEP** — Critical resource leak that degrades system performance over time. Affects all platforms. PR #1008 addresses this.

### #793 — isProjectRoot() doesn't detect subdirectories within git repos, causing CLAUDE.md pollution
- **Summary:** The `isProjectRoot()` function only checks if a folder directly contains `.git`, not if it's inside a git repo. This causes CLAUDE.md files to be created in all subdirectories of git repos.
- **Labels:** `bug`, `priority:critical`
- **Author:** alexrodriguezintegrityxd | **Created:** 2026-01-24
- **Recommendation:** **KEEP** — Affects every user with nested project directories. Creates unwanted files across the filesystem. Multiple community reports. PR #834 proposes a fix.

---

## Tier 2: High-Priority Bug Fixes

These issues break core functionality for significant user populations. They should be scheduled for the next development sprint.

### #998 — Observation storage failed: 500 on every PostToolUse hook after v9.0.17 upgrade
- **Summary:** After upgrading to v9.0.17, every tool call triggers a PostToolUse hook error with a 500 response from the observation storage backend. Non-blocking but produces constant error noise.
- **Labels:** `bug`, `priority:high`
- **Author:** nyflyer | **Created:** 2026-02-06
- **Recommendation:** **KEEP** — Core observation pipeline is broken for upgraded users. Likely a regression in the v9.0.17 release.

### #987 — Stop hook causes infinite session loop when summarize output is interpreted as instructions
- **Summary:** The Stop hook's `summarize` command returns a `systemMessage` containing session context that Claude interprets as new instructions, causing an infinite feedback loop where sessions never terminate.
- **Labels:** `bug`, `priority:high`
- **Author:** costa-marcello | **Created:** 2026-02-06
- **Recommendation:** **KEEP** — Prevents clean session termination. Users must force-quit Claude Code to escape the loop.

### #979 — MigrationRunner.initializeSchema() fails to create observations and session_summaries tables
- **Summary:** Fresh install of v9.0.15 fails during database initialization — the `observations` and `session_summaries` tables are never created, causing the worker to fail readiness checks and crash.
- **Labels:** `bug`, `priority:high`
- **Author:** kitadesign | **Created:** 2026-02-06
- **Recommendation:** **KEEP** — Blocks new installations entirely. Database initialization must work on first run.

### #966 — SDK Generator immediately aborts on every observation, causing infinite pending queue backlog
- **Summary:** The `ClaudeSdkAgent` generator starts, registers a PID, creates a message generator, then instantly aborts — never processing any messages. Pending messages accumulate indefinitely.
- **Labels:** `bug`, `priority:high`
- **Author:** NoobyNull | **Created:** 2026-02-05
- **Recommendation:** **KEEP** — AI summarization pipeline completely non-functional. Observations pile up unprocessed.

### #942 — CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is documented but not implemented
- **Summary:** The `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` setting exists in documentation but has no effect in code. Users cannot disable CLAUDE.md auto-generation.
- **Labels:** `bug`, `priority:high`
- **Author:** costa-marcello | **Created:** 2026-02-05
- **Recommendation:** **KEEP** — Documented feature that doesn't work. Related to #793 (CLAUDE.md pollution). Users expect this setting to function.

### #855 — Gemini API summarization fails and causes database corruption
- **Summary:** Using Gemini via API for summarization doesn't work, and switching between providers corrupts the database, requiring a full wipe to restore normal operation.
- **Labels:** `bug`, `priority:high`
- **Author:** jerzydziewierz | **Created:** 2026-01-30
- **Recommendation:** **KEEP** — Data corruption is a severe consequence. Gemini is a popular alternative provider that many users want to use.

### #843 — Worker fails to start on Windows: bun:sqlite not available when spawned via Node.js
- **Summary:** On Windows, `ProcessManager.spawnDaemon()` uses `process.execPath` which resolves to `node.exe`, but `worker-service.cjs` requires `bun:sqlite` (Bun-only). Worker never starts.
- **Labels:** `bug`, `priority:high`, `platform:windows`
- **Author:** bivlked | **Created:** 2026-01-28
- **Recommendation:** **KEEP** — Fundamental Windows startup failure. Needs architecture fix to ensure Bun is used for worker spawning.

### #807 — [Windows] ProcessTransport error — Worker fails with "ProcessTransport is not ready for writing"
- **Summary:** Worker crashes with `ProcessTransport is not ready for writing` on Windows. MCP search always fails. Worker briefly starts (port 37777 opens) but crashes during Bun subprocess communication.
- **Labels:** `bug`, `priority:high`, `platform:windows`
- **Author:** Istrebitel98 | **Created:** 2026-01-25
- **Recommendation:** **KEEP** — Core Windows functionality broken. Bun's subprocess transport layer may need a workaround on Windows.

### #785 — Worker fails to spawn on Windows 11 25H2+ (WMIC removed)
- **Summary:** Worker daemon fails to start on Windows 11 25H2 (Build 26200+) because `wmic.exe` has been completely removed, but `ProcessManager.ts` uses WMIC to spawn the daemon.
- **Labels:** `bug`, `priority:high`, `platform:windows`
- **Author:** bivlked | **Created:** 2026-01-23
- **Recommendation:** **KEEP** — Windows 11 25H2 is shipping to consumers. WMIC removal breaks worker spawning entirely. PR #1006 addresses this.

### #730 — Vector-db folder grows to 1TB+ when multiple Docker containers share the same .claude-mem mount
- **Summary:** Multiple Docker containers mounting the same `.claude-mem` directory causes the `vector-db` folder to grow uncontrollably to 1.1TB+, filling all available disk space within hours.
- **Labels:** `bug`, `priority:high`
- **Author:** lucacri | **Created:** 2026-01-16
- **Recommendation:** **KEEP** — Critical data issue for Docker/CI users. Unbounded growth filling disks is a production-breaking problem.

### #729 — Worker startup blocks Claude Code entirely when not ready within 15 seconds
- **Summary:** When the worker isn't ready within 15 seconds, the `UserPromptSubmit` hook blocks completely, preventing Claude Code from working at all. Users must manually restart.
- **Labels:** `bug`, `priority:high`
- **Author:** andygmassey | **Created:** 2026-01-16
- **Recommendation:** **KEEP** — Blocking startup failure affects UX severely. Should degrade gracefully instead of blocking entirely.

### #718 — VSCode reuses zombie content_session_id after session completion, causing Generator abort loop
- **Summary:** VSCode continues reusing the same `content_session_id` after session completion, causing the Generator to abort repeatedly with "Prompt is too long" errors.
- **Labels:** `bug`, `priority:high`
- **Author:** soho-dev-account | **Created:** 2026-01-15
- **Recommendation:** **KEEP** — Causes Generator to be permanently broken for long-running VSCode sessions. PR #996 addresses this.

### #646 — Plugin bricks Claude Code — stdin fstat EINVAL crash
- **Summary:** The SessionStart hook crashes Claude Code with an `fstat EINVAL` error on stdin, bricking Claude Code in most directories. Users cannot start sessions until the plugin is manually uninstalled.
- **Labels:** `bug`, `priority:high`
- **Author:** MaxWolf-01 | **Created:** 2026-01-09
- **Recommendation:** **KEEP** — Severity is critical despite high-priority label. Completely bricks Claude Code for affected users. PR #977 addresses this.

### #997 — Windows VSCode CLI: Bun command prompt spam
- **Summary:** On Windows, Bun command prompt windows constantly pop up and spam the screen when using claude-mem in VSCode CLI. No effective workaround exists.
- **Labels:** `bug`, `priority:high`, `platform:windows`
- **Author:** cryptodoran | **Created:** 2026-02-06
- **Recommendation:** **KEEP** — Makes the product unusable on Windows. User reports switching to paid alternatives due to this issue.

### #990 — Security Report: 8 findings (2 Critical, 4 High) from automated analysis
- **Summary:** Automated security audit identified 8 findings including SQL injection via dynamic query construction and other vulnerabilities across the codebase.
- **Labels:** `security`, `priority:high`
- **Author:** devatsecure | **Created:** 2026-02-06
- **Recommendation:** **KEEP** — Comprehensive security report with actionable findings. Overlaps with #982 (path traversal). Individual findings should be validated and addressed.

### #707 — Feature: SQLite-only backend mode to prevent Chroma memory consumption (35GB RAM)
- **Summary:** Chroma MCP process consumes 35GB+ RAM on macOS, making the system unusable. Request for a SQLite-only backend mode that skips Chroma entirely.
- **Labels:** `enhancement`, `priority:high`
- **Author:** soho-dev-account | **Created:** 2026-01-14
- **Recommendation:** **KEEP** — While labeled as an enhancement, the 35GB RAM consumption is a critical resource issue. A SQLite-only mode would resolve #730, #695, #675, and other Chroma-related issues. High community demand.

---

## Summary Statistics

| Tier | Count | Breakdown |
|------|-------|-----------|
| **Tier 1: Critical Security & Stability** | 3 | 1 security vulnerability, 1 resource leak, 1 filesystem pollution |
| **Tier 2: High-Priority Bug Fixes** | 14 | 4 Windows-specific, 3 startup/blocking, 2 security, 2 data integrity, 3 core functionality |
| **Total Critical + High** | **17** | |

### Recommendation Distribution

| Recommendation | Count |
|----------------|-------|
| **KEEP** | 17 |
| **DISCARD** | 0 |
| **DEFER** | 0 |

All 17 critical and high-priority issues are recommended to be kept open. These represent genuine, impactful bugs and security vulnerabilities that affect core functionality, data integrity, or platform compatibility. None are duplicates, already fixed, or obsolete.

### Cross-References to PRs

Several high-priority issues have active PRs addressing them:

| Issue | Related PR(s) | PR Status |
|-------|--------------|-----------|
| #982 (Path Traversal) | #1002, #986 | Open |
| #1010 (Orphaned Processes) | #1008 | Open |
| #793 (CLAUDE.md Pollution) | #834 | Open |
| #785 (WMIC Removed) | #1006 | Open |
| #718 (Zombie Session ID) | #996 | Open |
| #646 (stdin Crash) | #977 | Open |
