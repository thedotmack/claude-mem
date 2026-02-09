# Phase 09: Triage Worker/Database/Session Issues

This phase triages the remaining worker crashes, database errors, session management bugs, and Chroma/search issues. These are the core infrastructure problems that affect daily usage. Each needs individual evaluation — read the full issue body before deciding whether to close as fixed, close as duplicate, or label and keep open.

## Tasks

- [x] Triage worker and database errors. Read each issue with `gh issue view NUMBER --repo thedotmack/claude-mem` before taking action:
  - **#1011** "Health endpoint build string hardcoded as TEST-008-wrapper-ipc" by @thedotmack (owner) — This is the owner's own issue. Label:
    ```bash
    gh issue edit 1011 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 1011 --repo thedotmack/claude-mem --body "Triage: Owner-filed issue. The /api/health endpoint returns a hardcoded test build string instead of the actual version. Minor issue — only affects health check debugging."
    ```
  - **#998** "Observation storage failed: 500 on every PostToolUse hook after upgrading to v9.0.17" by @nyflyer — Read the issue to determine if this is still happening on v9.1.x:
    ```bash
    gh issue edit 998 --repo thedotmack/claude-mem --add-label "bug,priority:high"
    gh issue comment 998 --repo thedotmack/claude-mem --body "Triage: HTTP 500 on observation storage after v9.0.17 upgrade. This could be a database migration issue or API contract change. Needs investigation of the observation storage endpoint error logs."
    ```
  - **#979** "Bug: MigrationRunner.initializeSchema() fails to create observations and session_summaries tables" by @kitadesign — Label:
    ```bash
    gh issue edit 979 --repo thedotmack/claude-mem --add-label "bug,priority:high"
    gh issue comment 979 --repo thedotmack/claude-mem --body "Triage: Database schema initialization failure. If the migration runner can't create core tables, the entire plugin is non-functional. Needs investigation of the migration error and the database state."
    ```
  - **#966** "SDK Generator immediately aborts on every observation, causing infinite pending queue backlog" by @NoobyNull — Label:
    ```bash
    gh issue edit 966 --repo thedotmack/claude-mem --add-label "bug,priority:high"
    gh issue comment 966 --repo thedotmack/claude-mem --body "Triage: SDK Generator abort loop creates an ever-growing pending queue. This is likely related to the subprocess lifecycle issues tracked in #1010. The generator process may be crashing on startup due to configuration or dependency issues."
    ```
  - **#916** "FOREIGN KEY constraint failed after model switch and worker restart" by @hyperleoon — Label:
    ```bash
    gh issue edit 916 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 916 --repo thedotmack/claude-mem --body "Triage: Foreign key constraint failure during model switch. The worker restart may be creating new records that reference IDs from the previous session/model configuration. Needs investigation of the database relationship chain during model switches."
    ```
  - **#911** "MCP search tool returns 'No results found' for all queries (v9.0.12)" by @PointCero — Check if this is fixed in v9.1.x. If the user is on an old version:
    ```bash
    gh issue close 911 --repo thedotmack/claude-mem --reason "completed" --comment "The MCP search functionality has been significantly improved in v9.0.15+ releases. If you're still seeing 'No results' on v9.1.1, please open a new issue with your search query and database status (number of observations stored)."
    ```
  - **#855** "Gemini API summarization fails and causes database corruption" by @jerzydziewierz — Label as high priority:
    ```bash
    gh issue edit 855 --repo thedotmack/claude-mem --add-label "bug,priority:high"
    gh issue comment 855 --repo thedotmack/claude-mem --body "Triage: Gemini provider summarization failure causing database corruption. This is critical — a provider error should never corrupt the database. Needs defensive error handling in the summarization pipeline to catch provider failures gracefully."
    ```
  - **#740** "Orphaned 'active' sessions block pending queue; recovery ignores OpenRouter provider setting" by @licutis — Label:
    ```bash
    gh issue edit 740 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 740 --repo thedotmack/claude-mem --body "Triage: Stuck 'active' sessions blocking the queue, and recovery doesn't respect provider settings. Two separate issues: 1) session state cleanup needs a timeout/staleness check, 2) recovery should use the configured provider."
    ```

- [x] Triage session and search issues:
  - **#895** "Project field becomes empty when switching git branches" by @GigiTiti-Kai — Label:
    ```bash
    gh issue edit 895 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 895 --repo thedotmack/claude-mem --body "Triage: Project field reset on branch switch. The project association should persist across branch changes within the same repository."
    ```
  - **#838** "Bug: session-init hook fails with HTTP 400 when invoked from Cursor's beforeSubmitPrompt" by @Chachamaru127 — Label:
    ```bash
    gh issue edit 838 --repo thedotmack/claude-mem --add-label "bug,priority:medium,integration:cursor"
    gh issue comment 838 --repo thedotmack/claude-mem --body "Triage: Cursor integration issue — the session-init endpoint returns 400 when called from Cursor's hook system. The request payload from Cursor may differ from Claude Code's format."
    ```
  - **#784** "Internal memory agent output leaks to user on claude --continue" by @paseriINU — Label:
    ```bash
    gh issue edit 784 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 784 --repo thedotmack/claude-mem --body "Triage: Memory agent internal output leaking into user-visible conversation when using --continue flag. The hook output isolation needs to account for the continue session mode."
    ```
  - **#781** "Plugin doesn't respect disabled state - requires manual intervention to fully stop" by @Nickonomic — Label:
    ```bash
    gh issue edit 781 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 781 --repo thedotmack/claude-mem --body "Triage: Disabling the plugin via settings doesn't actually stop it. The hooks continue to fire and the worker continues running. Need to check the disabled flag at hook entry points."
    ```
  - **#744** "sessionInitHandler throws error when prompt is empty (breaks Codex CLI integration)" by @JKVirus — Label:
    ```bash
    gh issue edit 744 --repo thedotmack/claude-mem --add-label "bug,priority:medium,integration:codex"
    gh issue comment 744 --repo thedotmack/claude-mem --body "Triage: sessionInitHandler doesn't handle empty prompts. Some integrations (Codex CLI) may send empty prompts on init. The handler should treat empty prompt as valid."
    ```
  - **#730** "Vector-db folder grows to 1TB+ when multiple Docker containers share the same .claude-mem mount" by @lucacri — Label:
    ```bash
    gh issue edit 730 --repo thedotmack/claude-mem --add-label "bug,priority:high"
    gh issue comment 730 --repo thedotmack/claude-mem --body "Triage: Chroma vector-db unbounded growth in shared Docker mounts. This could be caused by multiple containers writing to the same Chroma instance without coordination, creating duplicate embeddings. Needs a cleanup mechanism or instance isolation."
    ```
  - **#725** "Worker host setting ignored for IPv6/non-default host" by @Danielalnajjar — Label:
    ```bash
    gh issue edit 725 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 725 --repo thedotmack/claude-mem --body "Triage: Worker host configuration not respected. The Express server should bind to the configured host instead of hardcoding localhost."
    ```
  - **#714** "search(query=\"*\", project=\"...\") returns no observations despite data existing" by @spaceshipmike — Label:
    ```bash
    gh issue edit 714 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 714 --repo thedotmack/claude-mem --body "Triage: Wildcard search returning empty results. The FTS5 search may not support wildcard queries, or the project filter may be incorrect. Needs investigation of the search query pipeline."
    ```
  - **#716** "Bug: cleanup-duplicates.ts missing PRAGMA foreign_keys = ON causes orphan records" by @pitimon — Label:
    ```bash
    gh issue edit 716 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 716 --repo thedotmack/claude-mem --body "Triage: Missing PRAGMA foreign_keys = ON in cleanup script. Without this, SQLite doesn't enforce foreign key constraints and cleanup can leave orphan records."
    ```
  - **#709** "If started now, historical sessions can no longer be seen in the Claude Code interface" by @zbsdsb — Label:
    ```bash
    gh issue edit 709 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 709 --repo thedotmack/claude-mem --body "Triage: Historical session visibility issue. May be related to database migration or session ID format changes between versions."
    ```
  - **#694** "Updated to 9.0.4, Claude -c switches to this mode and becomes completely unusable" by @cjh-store — Likely fixed in later releases:
    ```bash
    gh issue close 694 --repo thedotmack/claude-mem --reason "completed" --comment "This was a v9.0.4 specific issue. Significant stability improvements have been made in subsequent releases. Please update to v9.1.1 (latest). If you're still experiencing this, please open a new issue with your current version."
    ```
  - **#692** "Hooks not executing in Claude Code - no output, logs, or observations despite healthy worker" by @cenkkiran — Label:
    ```bash
    gh issue edit 692 --repo thedotmack/claude-mem --add-label "bug,priority:medium"
    gh issue comment 692 --repo thedotmack/claude-mem --body "Triage: Silent hook failure — worker is healthy but hooks produce no output. This could be a hook registration issue or a permission problem preventing hook execution."
    ```
  - **#690** "Claude provider with LLM gateway like litellm got api key error (auth error)" by @lts-kittisak-m — Label:
    ```bash
    gh issue edit 690 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 690 --repo thedotmack/claude-mem --body "Triage: API key forwarding issue with LiteLLM proxy. The Claude provider may not be passing through proxy authentication correctly."
    ```
  - **#677** "OpenRouter provider fails to create observations (obsCount=0)" by @pitimon — Related to #678 (resolution). Close with reference:
    ```bash
    gh issue close 677 --repo thedotmack/claude-mem --reason "completed" --comment "Resolution documented in #678 — switching to the Claude provider resolves the observation creation issue. OpenRouter provider compatibility has also been improved in recent releases."
    ```
  - **#648** "Silent failures: Empty catch blocks in SessionSearch.ts swallow JSON parse errors" by @Naokus — Label:
    ```bash
    gh issue edit 648 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 648 --repo thedotmack/claude-mem --body "Triage: Code quality issue — empty catch blocks hiding errors. Low priority but should be addressed for debugging reliability."
    ```
  - **#649** "Inconsistent logging: CursorHooksInstaller uses console.log instead of structured logger" by @Naokus — Label:
    ```bash
    gh issue edit 649 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 649 --repo thedotmack/claude-mem --body "Triage: Code quality issue — inconsistent logging. Low priority, should use the structured logger for consistency."
    ```
  - **#642** "ChromaDB search fails with JSON parse error due to initialization timing" by @darconada — Label:
    ```bash
    gh issue edit 642 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 642 --repo thedotmack/claude-mem --body "Triage: Chroma initialization race condition causing JSON parse errors. The search should gracefully handle Chroma not being ready yet. Chroma is optional — this shouldn't break the core search."
    ```
  - **#695** "macOS: Chroma MCP connection fails with 'MCP error -32000: Connection closed'" by @lagiosv — Label:
    ```bash
    gh issue edit 695 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 695 --repo thedotmack/claude-mem --body "Triage: Chroma MCP connection failure on macOS. See also #675 for the Windows equivalent. Chroma is optional — SQLite-only mode works as a workaround."
    ```
  - **#753** "Chroma MCP UVX Investigation" by @thedotmack (owner) — Owner research issue, label:
    ```bash
    gh issue edit 753 --repo thedotmack/claude-mem --add-label "investigation"
    ```
  - **#965** "Lockfiles are gitignored, causing non-reproducible builds" by @bmccann36 — Label:
    ```bash
    gh issue edit 965 --repo thedotmack/claude-mem --add-label "bug,priority:low"
    gh issue comment 965 --repo thedotmack/claude-mem --body "Triage: Build reproducibility concern — lockfiles should be committed for deterministic installs."
    ```

- [ ] After triaging all worker/database/session issues, output a summary of actions taken.
