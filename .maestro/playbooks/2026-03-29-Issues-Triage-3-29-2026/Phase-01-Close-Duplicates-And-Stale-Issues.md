# Phase 01: Close Duplicates & Stale Issues

This phase performs the immediate triage cleanup of the claude-mem GitHub issue backlog (thedotmack/claude-mem). By closing ~17 duplicate, vague, and outdated issues with clear explanatory comments, and labeling all remaining issues by root-cause group, we reduce noise and create a clean, organized backlog for the code-fix phases that follow. This phase requires no code changes — only `gh` CLI operations against the GitHub API.

## Tasks

- [x] Create GitHub labels for root-cause categorization on `thedotmack/claude-mem`. ✓ All 10 labels created: root:worker-lifecycle, root:windows, root:chromadb, root:project-scoping, root:session-integrity, root:security, root:installer, root:mcp-schema, root:aws-bedrock, triage:closable Use `gh label create` for each (skip if already exists — use `gh label list` first to check):
  - `root:worker-lifecycle` (color: `#d73a4a`) — Worker startup, shutdown, zombie processes
  - `root:windows` (color: `#0075ca`) — Windows-specific platform bugs
  - `root:chromadb` (color: `#7057ff`) — ChromaDB/MCP subprocess issues
  - `root:project-scoping` (color: `#008672`) — Project identity, isolation, namespace collisions
  - `root:session-integrity` (color: `#e4e669`) — Session data, pending queue, finalization
  - `root:security` (color: `#b60205`) — Security vulnerabilities
  - `root:installer` (color: `#fbca04`) — Setup, install, marketplace path issues
  - `root:mcp-schema` (color: `#1d76db`) — MCP tool registration, schema issues
  - `root:aws-bedrock` (color: `#5319e7`) — AWS Bedrock integration
  - `triage:closable` (color: `#cccccc`) — Marked for closure during triage

- [x] Close the 6 duplicate __dirname issues, keeping #1410 as the canonical issue. For each of #1419, #1428, #1433, #1434, #1437, #1438: run `gh issue close <NUMBER> -R thedotmack/claude-mem -c "Closing as duplicate of #1410. All 7 reports trace to the same root cause: hardcoded __dirname in the esbuild bundle output (worker-service.cjs). Fix will be tracked in #1410."`. Then add label `root:worker-lifecycle` to #1410. ✓ All 6 duplicates (#1419, #1428, #1433, #1434, #1437, #1438) closed with explanatory comments. Label `root:worker-lifecycle` added to #1410.

- [x] Close the duplicate setup.sh pair and duplicate security pair: ✓ #1396 closed as dup of #1340 (root:installer label added), #1521 closed as dup of #1285 (root:security label added)
  - Close #1396 as duplicate of #1340: `gh issue close 1396 -R thedotmack/claude-mem -c "Duplicate of #1340 — both report the same missing scripts/setup.sh issue."` Add label `root:installer` to #1340.
  - Close #1521 as duplicate of #1285: `gh issue close 1521 -R thedotmack/claude-mem -c "Duplicate of #1285 — both report command injection in GitHub Actions workflow."` Add label `root:security` to #1285.

- [x] Close vague, no-info, and non-actionable issues. For each, use `gh issue close` with a polite explanatory comment: ✓ All 7 vague/non-actionable issues closed (#1492, #1436, #1362, #1385, #1488, #1459, #1378) with explanatory comments.
  - #1492 ("Bug Report") — `"Closing: this issue has only a generic title with no reproduction steps, error logs, or version info. Please reopen with specific details if the issue persists."`
  - #1436 ("bug") — `"Closing: no description, steps to reproduce, or error output provided. Please reopen with details if still relevant."`
  - #1362 (Chinese, no repro) — `"Closing: unable to action without reproduction steps or error details. If you can provide steps to reproduce (in any language), please reopen."`
  - #1385 ("mem still not save") — `"Closing: insufficient details to diagnose. If you can share your OS, claude-mem version, and error logs, please reopen a new issue."`
  - #1488 ("Consumed 25% of my tokens") — `"Closing: this appears to be a usage concern rather than a bug. Token consumption depends on context window size and session length. If you believe there is a specific bug causing excessive token usage, please open a new issue with reproduction steps."`
  - #1459 ("Featured in awesome-claude-code-workflows") — `"Closing: this is a community celebration rather than an actionable issue. Thank you for the recognition! 🎉"`
  - #1378 ("Test failure: test run failed") — `"Closing: no test output, stack trace, or version info provided. This may have been fixed in later releases. Please reopen with details if still occurring."`

- [x] Close likely-fixed and superseded issues: ✓ All 3 closed (#1268 regression fixed in 10.6.x+, #1137 superseded by #1262, #1219 stale version bump).
  - #1268 — `gh issue close 1268 -R thedotmack/claude-mem -c "This regression appears to have been fixed in subsequent releases (10.6.x+). If you're still experiencing this on the latest version, please reopen with your version number and error details."`
  - #1137 — `gh issue close 1137 -R thedotmack/claude-mem -c "Superseded by #1262 which covers the broader plan mode pending messages issue. Closing to consolidate tracking."`
  - #1219 (version bump to 10.4.1) — `gh issue close 1219 -R thedotmack/claude-mem -c "This version has long since been superseded. The current version is well past 10.4.1. Closing as stale."`

- [x] Label all remaining open issues by root-cause group. ✓ 76 label applications across 9 root-cause groups on 93 open issues. Multi-label issues: #1489 (windows+chromadb), #1225 (windows+chromadb), #1234 (worker-lifecycle+session-integrity). Breakdown: root:worker-lifecycle (21), root:windows (13), root:chromadb (9), root:project-scoping (6), root:session-integrity (13), root:security (4), root:installer (7), root:mcp-schema (4), root:aws-bedrock (2). ~16 feature requests/misc kept without root labels. First run `gh issue list -R thedotmack/claude-mem --state open --limit 200 --json number,title,labels` to get the current open list, then apply labels using `gh issue edit <NUMBER> -R thedotmack/claude-mem --add-label <LABEL>`. Group assignments:
  - **root:worker-lifecycle**: #1410, and any issues mentioning worker startup failures, cold start, zombie processes, version mismatch, daemon spawn, "worker not running", "ECONNREFUSED", port binding, health check failures, or `ensureWorkerRunning`
  - **root:windows**: Any issues mentioning Windows, PowerShell, CRLF, `win32`, zombie sockets on Windows, `.exe`, `taskkill`, or Windows Terminal
  - **root:chromadb**: Any issues mentioning ChromaDB, chroma-mcp, `uvx`, vector search failures, CPU spin from chroma, or embedding errors
  - **root:project-scoping**: Any issues mentioning project name collisions, basename, monorepo isolation, workspace bleed, or data from wrong project
  - **root:session-integrity**: Any issues mentioning early finalization, duplicate observations, empty summaries, pending queue growth, or lost data
  - **root:security**: #1285, #1204, and any issues mentioning command injection, file write vulnerability, port collision data leakage, or permission bypass
  - **root:installer**: #1340, and any issues mentioning setup, install, marketplace path, allowlist, plugin.json, or MCP registration failures
  - **root:mcp-schema**: Any issues mentioning empty inputSchema, MCP tool ID mismatch, or SSE broadcast
  - **root:aws-bedrock**: Any issues mentioning Bedrock, AWS SDK, or Bedrock environment variables
  - Issues fitting multiple categories should receive multiple labels. Feature requests should keep their existing `enhancement` label if present.

- [x] Generate a structured triage summary report. ✓ Report written to Working/triage-report.md. 112 issues before triage, 18 closed (8 duplicate, 7 vague, 3 stale), 94 remaining. 15 P0, 54 P1, 25 P2. All 94 open issues categorized by 9 root-cause labels plus 15 unlabeled standalone items. Create a markdown file at `/Users/alexnewman/Scripts/claude-mem/Auto Run Docs/2026-03-29-Issues-Triage-3-29-2026/Working/triage-report.md` with YAML front matter:
  ```yaml
  ---
  type: report
  title: "Issues Triage Report — 2026-03-29"
  created: 2026-03-29
  tags:
    - triage
    - issues
    - claude-mem
  ---
  ```
  The report should contain:
  - Total issues before triage vs after (with count of closed)
  - Table of closed issues with number, title, and reason (duplicate/stale/vague)
  - Table of remaining open issues grouped by root-cause label, with issue number, title, and priority (P0/P1/P2)
  - Priority criteria: P0 = blocks all users or security vulnerability, P1 = affects large user segment, P2 = nice-to-have or single-user report
  - A "Next Steps" section listing the 6 remaining fix phases with brief descriptions
