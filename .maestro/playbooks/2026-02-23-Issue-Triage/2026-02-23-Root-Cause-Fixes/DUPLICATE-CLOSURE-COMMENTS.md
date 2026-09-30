---
type: reference
title: Duplicate Issue Closure Comments
created: 2026-02-23
tags:
  - issue-triage
  - duplicates
  - housekeeping
related:
  - "[[TRIAGE-10-Issue-Housekeeping]]"
---

# Duplicate Issue Closure Comments

Prepared for manual review. Each section contains the issue number, the root duplicate, and a suggested closure comment.

---

## Cluster: Windows uvx.cmd Spawn Failures

**Root issue:** #1190 — `StdioClientTransport` does not resolve `.cmd` files on Windows
**Fix:** Phase 06 (TRIAGE-06-Windows-Platform-Support)

### #1192

> Closing as duplicate of #1190. Both issues stem from the same root cause: `StdioClientTransport` in the Claude Agent SDK does not resolve `.cmd` wrappers (like `uvx.cmd`) on Windows. The fix in #1190 adds `.cmd` extension resolution for Windows platforms. See TRIAGE-06-Windows-Platform-Support for the full fix.

### #1199

> Closing as duplicate of #1190. This is the same `uvx.cmd` spawn failure on Windows caused by `StdioClientTransport` not handling `.cmd` file extensions. Fixed alongside #1190 in Phase 06.

---

## Cluster: Python 3.14 Breaks Pydantic (ChromaDB)

**Root issue:** #1196 — `uvx chromadb` fails on Python 3.14 because pydantic is incompatible
**Fix:** Phase 01 (TRIAGE-01-ChromaDB-Core-Fixes) — added `--python 3.12` flag to `uvx` command

### #1206

> Closing as duplicate of #1196. All three issues are caused by the same problem: `uvx chromadb` uses the system Python, and Python 3.14 breaks pydantic (a ChromaDB dependency). The fix pins the Python version to 3.12 via the `--python` flag in the `uvx` command.

### #1208

> Closing as duplicate of #1196. Same root cause — pydantic incompatibility with Python 3.14 when launching ChromaDB via `uvx`. Fixed by pinning `--python 3.12` in Phase 01.

---

## Cluster: Process Leaks on Shutdown

**Root issue:** #1068 — Claude subprocesses and ChromaDB not cleaned up on shutdown paths
**Fix:** Phase 05 (TRIAGE-05-Worker-Lifecycle-Simplified) — added ProcessRegistry and cleanup on all shutdown paths

### #1089

> Closing as duplicate of #1068. This process leak is caused by the same missing cleanup on shutdown paths. Phase 05 added a `ProcessRegistry` that tracks all spawned subprocesses and ensures they are killed on `SIGINT`, `SIGTERM`, and graceful shutdown.

### #1090

> Closing as duplicate of #1068. Same root cause as #1089 — missing process cleanup on exit. Fixed in Phase 05 with the unified `ProcessRegistry` shutdown handler.

---

## Cluster: Missing chromadb Dependency

**Root issue:** #1149 — `chromadb` package missing from `plugin/package.json`
**Fix:** Phase 07 (TRIAGE-07-Installation-Distribution) — added `chromadb` to plugin dependencies

### #1155

> Closing as duplicate of #1149. Both report the same missing `chromadb` dependency in the distributed plugin package. Fixed in Phase 07 by adding `chromadb` to `plugin/package.json`.

---

## Non-Actionable Issues (Close Without Fix)

### #1135

> Closing — this issue has an empty body ("Hhh") with no actionable content. Please reopen with a description if there is a real issue to report.

### #1205

> Closing — this issue ("Locked?") is unclear and has no actionable content. Please reopen with a detailed description and reproduction steps if there is a real issue to report.
