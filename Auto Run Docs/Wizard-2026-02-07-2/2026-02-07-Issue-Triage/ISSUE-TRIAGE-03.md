# Phase 03: Close Already-Fixed Issues

This phase closes issues reporting bugs that were confirmed fixed in subsequent releases. These issues are stale — the reported problems no longer exist in the current version (v9.1.1). Closing them with version references helps users on older versions understand the fix path.

## Tasks

- [x] Close version mismatch / hardcoded version issues — all fixed by the build pipeline improvements in v9.0.5+:
  > **Completed** — All 5 issues (#665, #667, #669, #689, #736) closed with version fix references.
  - **#665** "[BUG] v9.0.3 bundle contains hardcoded version '9.0.2' causing infinite restart loop" by @Regis-RCR
    ```bash
    gh issue close 665 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.5+. The build pipeline now correctly updates version strings across all bundle files. Please update to v9.1.1 (latest). Related: #667, #669, #689."
    ```
  - **#667** "v9.0.3: Version mismatch in plugin/package.json causes infinite worker restart loop" by @saasom
    ```bash
    gh issue close 667 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.5+. Same root cause as #665 — build pipeline now synchronizes versions across all distribution files. Please update to v9.1.1 (latest)."
    ```
  - **#669** "v9.0.4: worker-service.cjs contains hardcoded version '9.0.3' causing infinite restart loop" by @Regis-RCR
    ```bash
    gh issue close 669 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.5+. Same root cause as #665 — pre-built worker bundle is now regenerated during each release. Please update to v9.1.1 (latest)."
    ```
  - **#689** "Version mismatch in v9.0.4 causes infinite worker restart loop" by @chenjunnn
    ```bash
    gh issue close 689 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.5+. Same root cause as #665 — version strings are now synchronized during the release process. Please update to v9.1.1 (latest)."
    ```
  - **#736** "Version 9.0.5 .mcp.json is empty, causing MCP server configuration to fail" by @kajiwara321
    ```bash
    gh issue close 736 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.6+. The .mcp.json file is now correctly generated during the build process. Please update to v9.1.1 (latest)."
    ```

- [x] Close startup/health-check issues fixed in v9.0.5+ releases:
  > **Completed** — All 5 issues (#772, #673, #623, #825, #724) closed with version fix references.
  - **#772** "Worker health check uses /api/readiness causing 15-second timeout during background initialization" by @rajivsinclair
    ```bash
    gh issue close 772 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — the health check endpoint was updated from /api/readiness to /api/health, which responds immediately without waiting for full initialization. Please update to v9.1.1 (latest)."
    ```
  - **#673** "Stop hook summarize fails with 'Unable to connect' error in v9.0.4" by @grimnir
    ```bash
    gh issue close 673 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.5+. Stop hook connectivity and error handling were overhauled. Please update to v9.1.1 (latest)."
    ```
  - **#623** "v9.0.0: Crash-recovery loop when memory_session_id is not captured" by @mrlfarano
    ```bash
    gh issue close 623 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.1+. Session ID capture and crash recovery were stabilized in subsequent releases. Please update to v9.1.1 (latest)."
    ```
  - **#825** "v9.0.10: Plugin completely non-functional - hooks disabled, worker doesn't start, UI broken" by @costa-marcello
    ```bash
    gh issue close 825 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed in v9.0.11+. The v9.0.10 release had a packaging issue that was addressed in the next release. Please update to v9.1.1 (latest)."
    ```
  - **#724** "Connection Error: API endpoints /claude-mem:make-plan and /claude-mem:claude failing" by @fentz26
    ```bash
    gh issue close 724 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — API endpoint connectivity issues were resolved in subsequent releases. The worker service connection handling was overhauled. Please update to v9.1.1 (latest)."
    ```

- [x] Close remaining stale/fixed issues from older versions:
  > **Completed** — All 5 issues (#591, #626, #582, #815, #948) closed with version fix references.
  - **#591** "OpenRouter agent fails to capture memorySessionId for sessions with empty prompt history" by @cjdrilke
    ```bash
    gh issue close 591 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — session ID capture was improved in v9.0.1+ to handle edge cases including empty prompt history. Please update to v9.1.1 (latest)."
    ```
  - **#626** "Bug: HealthMonitor hardcodes ~/.claude path, fails with custom config directories" by @mtenpow
    ```bash
    gh issue close 626 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — the health monitor now uses configurable paths via settings.json rather than hardcoding ~/.claude. Please update to v9.1.1 (latest)."
    ```
  - **#582** "Bug: Tilde paths create literal ~ directories instead of expanding to home" by @ricardostmalo
    ```bash
    gh issue close 582 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — path resolution now properly expands tilde (~) to the home directory across all platforms. Please update to v9.1.1 (latest)."
    ```
  - **#815** "UI saves incorrect Gemini model name (missing -preview suffix)" by @costa-marcello
    ```bash
    gh issue close 815 --repo thedotmack/claude-mem --reason "completed" --comment "Fixed — Gemini model names are now correctly saved with the proper suffix. Please update to v9.1.1 (latest)."
    ```
  - **#948** "Footer Bug: Copyright year is hardcoded and outdated" by @Tilakmahajan
    ```bash
    gh issue close 948 --repo thedotmack/claude-mem --reason "completed" --comment "Thanks for the report. The copyright year display has been updated. Please update to v9.1.1 (latest)."
    ```

- [ ] Verify all 15 issues from this phase are closed:
  ```bash
  ISSUES="665 667 669 689 736 772 673 623 825 724 591 626 582 815 948"
  for i in $ISSUES; do gh issue view $i --repo thedotmack/claude-mem --json state --jq ".state"; done | sort | uniq -c
  ```
  Expected output: `15 CLOSED`. If any show OPEN, re-run the failed close command.
