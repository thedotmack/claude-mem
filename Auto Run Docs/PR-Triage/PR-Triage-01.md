# Phase 01: Close Stale/Already-Addressed PRs

These PRs fix issues that have already been resolved in released versions. Close each with a comment explaining which version addressed the fix.

- [x] Close PR #820 (`fix: use /api/health instead of /api/readiness` by @bigph00t) with comment: "This fix was merged in v9.0.16 — see the changelog entry for 'Fix Worker Startup Timeout (#811, #772, #729)'. The health check endpoint was switched from `/api/readiness` to `/api/health` in that release. Closing as already addressed. Thank you for the contribution!" Run: `gh pr close 820 --comment "Already addressed in v9.0.16 — health check endpoint switched from /api/readiness to /api/health. See changelog. Thank you for the contribution!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #774 (`fix: use /api/health instead of /api/readiness` by @rajivsinclair) — same fix as #820, already shipped in v9.0.16. Run: `gh pr close 774 --comment "Already addressed in v9.0.16 (same fix as PR #820 which was merged). Health checks now use /api/health. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #773 (`fix: use /api/health instead of /api/readiness` by @rajivsinclair) — same fix as #820/#774, already shipped in v9.0.16. Run: `gh pr close 773 --comment "Already addressed in v9.0.16 (same fix as PR #820 which was merged). Health checks now use /api/health. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #861 (`fix: add idle timeout with abort to prevent zombie observer processes` by @bigph00t) — v9.0.13 shipped zombie observer prevention with 3-minute idle timeout. Run: `gh pr close 861 --comment "Already addressed in v9.0.13 — 'Zombie Observer Prevention (#856)' added 3-minute idle timeout with race condition fix and 11 tests. Thank you for the contribution!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #848 (`fix: Kill duplicate observer processes to prevent zombie accumulation` by @influenist) — v9.0.13 addresses zombie observers. Run: `gh pr close 848 --comment "Already addressed in v9.0.13 — zombie observer prevention with idle timeout. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #735 (`fix: strip ANTHROPIC_API_KEY for Claude Code subscribers` by @shyal) — v9.0.15 shipped isolated credentials, sourcing exclusively from ~/.claude-mem/.env. Run: `gh pr close 735 --comment "Already addressed in v9.0.15 — 'Isolated Credentials (#745)' now sources credentials exclusively from ~/.claude-mem/.env with whitelisted env vars. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #840 (`fix(windows): replace WMIC with PowerShell Start-Process` by @bivlked) — v9.0.2 already replaced WMIC with PowerShell. Run: `gh pr close 840 --comment "Already addressed in v9.0.2 — replaced deprecated WMIC commands with PowerShell Get-Process and Get-CimInstance. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #933 (`fix(windows): replace deprecated wmic worker spawn with child_process spawn` by @jayvenn21) — same WMIC issue, fixed in v9.0.2. Run: `gh pr close 933 --comment "Already addressed in v9.0.2 — WMIC replacement with PowerShell commands. Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #700 (`fix(#681): eliminate Windows Terminal popup by removing spawn-based daemon` by @thedotmack) — fixed in v9.0.6 (Windows console popup fix). Run: `gh pr close 700 --comment "Already addressed in v9.0.6 — Windows console popups eliminated with WMIC-based detached process spawning. Closing as resolved."`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent

- [x] Close PR #521 (`fix: implement two-stage readiness to prevent fresh install timeout` by @seanGSISG) — v9.0.16 switched to /api/health and v9.0.17 added bun-runner.js for fresh install PATH resolution. Run: `gh pr close 521 --comment "Already addressed in v9.0.16 (health check fix) and v9.0.17 (bun-runner.js for fresh install Bun PATH resolution). Thank you!"`
  - ✅ Closed 2026-02-05 by Claude-Mem PRs agent
