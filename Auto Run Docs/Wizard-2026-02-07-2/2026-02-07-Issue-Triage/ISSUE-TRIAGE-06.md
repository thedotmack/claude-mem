# Phase 06: Triage Windows Issues

This phase triages the remaining Windows-specific issues that weren't closed as duplicates in Phase 04. The Windows popup cluster was already consolidated (canonical: #997). These remaining issues cover different Windows problems: WMIC deprecation, bun:sqlite compatibility, ProcessTransport crashes, FTS5 search failures, and Chroma MCP issues. Each needs individual evaluation.

## Tasks

- [x] Label and triage Windows-specific worker startup failures. Read each issue first with `gh issue view NUMBER --repo thedotmack/claude-mem` to understand the details, then take the appropriate action:
  > **Completed**: Created `platform:windows`, `priority:medium`, `priority:low` labels. #997 labeled as canonical (bug, platform:windows, priority:high) with duplicate list in comment. #890 closed as duplicate of #785. #785 labeled (bug, platform:windows, priority:high) with triage comment. #843 labeled (bug, platform:windows, priority:high) with triage comment.
  - **#997** "Windows VSCode CLI: Bun command prompt spam is completely broken" by @cryptodoran — This is the canonical issue for the Windows popup cluster. Label it:
    ```bash
    gh issue edit 997 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:high"
    gh issue comment 997 --repo thedotmack/claude-mem --body "Triage: This is the canonical issue for Windows console popup/flash problems. Duplicates closed: #981, #871, #810, #681, #676, #688. Core problem: bun.cmd wrapper spawns visible console windows on every hook invocation. Needs a solution that either uses windowless execution or switches to a different process spawning method on Windows."
    ```
  - **#890** "Bug: Worker fails to start on Windows 11 (24H2+) due to wmic deprecation" by @Strelitzia-reginae — WMIC was removed in Windows 11 24H2. Check if #785 is the same issue:
    ```bash
    gh issue close 890 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #785 which also reports the WMIC removal issue on Windows 11 25H2+. Tracking the fix in #785."
    ```
  - **#785** "fix: Worker fails to spawn on Windows 11 25H2+ (WMIC removed)" by @bivlked — Keep open and label:
    ```bash
    gh issue edit 785 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:high"
    gh issue comment 785 --repo thedotmack/claude-mem --body "Triage: Confirmed Windows 11 25H2+ removes WMIC. Any process management that depends on WMIC needs to be replaced with PowerShell Get-CimInstance or tasklist alternatives. Duplicate #890 closed in favor of this issue."
    ```
  - **#843** "Worker fails to start on Windows: bun:sqlite not available when spawned via Node.js" by @bivlked — Label and keep open:
    ```bash
    gh issue edit 843 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:high"
    gh issue comment 843 --repo thedotmack/claude-mem --body "Triage: bun:sqlite is a Bun-native module that isn't available when the worker is spawned via Node.js instead of Bun. This suggests the worker spawn path on Windows is falling back to Node.js. Needs investigation into the Windows process spawn chain."
    ```

- [x] Label and triage remaining Windows-specific bugs:
  > **Completed**: #918 labeled (bug, platform:windows, priority:medium) with triage comment. #874 closed as duplicate of #807. #807 labeled (bug, platform:windows, priority:high) with triage comment. #791 labeled (bug, platform:windows, priority:medium) with triage comment. #723 labeled (bug, platform:windows, priority:medium) with triage comment. #708 closed as too vague (was actually a duplicate of #997 popup issue). #675 labeled (bug, platform:windows, priority:low) with triage comment. #1004 closed with guidance to submit as PR instead.
  - **#918** "SessionStart hooks block input in terminal on Windows — needs 'async': true" by @23rdletter — Label:
    ```bash
    gh issue edit 918 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:medium"
    gh issue comment 918 --repo thedotmack/claude-mem --body "Triage: Windows terminal input blocking during hook execution. The hook system may need async:true configuration on Windows to prevent UI freezing. Related to the broader Windows hook execution issues."
    ```
  - **#874** "[Windows] ProcessTransport is not ready for writing - Worker crashes on startup" by @SnowKonn — Check if this is a duplicate of #807:
    ```bash
    gh issue close 874 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #807 which reports the same ProcessTransport error. Tracking in #807."
    ```
  - **#807** "[Windows] ProcessTransport error - Worker fails with 'ProcessTransport is not ready for writing' on Bun 1.3.5" by @Istrebitel98 — Keep open and label:
    ```bash
    gh issue edit 807 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:high"
    gh issue comment 807 --repo thedotmack/claude-mem --body "Triage: ProcessTransport readiness issue on Windows. This is likely a Bun-specific bug with IPC on Windows. Duplicate #874 closed in favor of this issue. May need a Bun version check or alternative transport on Windows."
    ```
  - **#791** "[Windows] Keyword search (FTS5) returns 'No results' despite data existing (v9.0.6)" by @ChampPABA — Label:
    ```bash
    gh issue edit 791 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:medium"
    gh issue comment 791 --repo thedotmack/claude-mem --body "Triage: FTS5 search failure on Windows. This could be a SQLite build difference on Windows (missing FTS5 extension) or a collation issue. Needs investigation of the Windows SQLite binary bundled with Bun."
    ```
  - **#723** "[Windows] Worker crashes with 'Database not initialized' - unstable on Windows 11" by @machanek — Label:
    ```bash
    gh issue edit 723 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:medium"
    gh issue comment 723 --repo thedotmack/claude-mem --body "Triage: Database initialization race condition on Windows. The worker may be accepting requests before the database is fully initialized. Related to the broader Windows startup reliability issues."
    ```
  - **#708** "Windows system BUG" by @yilen3 — Read the issue body. If it's too vague to be actionable, close:
    ```bash
    gh issue close 708 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing due to insufficient detail. The title and description don't provide enough information to reproduce or investigate. If you're still experiencing a Windows-specific issue on v9.1.1, please open a new issue with: 1) your Windows version, 2) exact error message, 3) steps to reproduce."
    ```
  - **#675** "Windows: Chroma MCP connection fails with 'MCP error -32000: Connection closed'" by @faisalkindi — Label:
    ```bash
    gh issue edit 675 --repo thedotmack/claude-mem --add-label "bug,platform:windows,priority:low"
    gh issue comment 675 --repo thedotmack/claude-mem --body "Triage: Chroma MCP connection failure on Windows. This is likely related to the uvx/Python process spawning differences on Windows. Chroma is optional — SQLite-only mode works as a workaround. See also #695 for the macOS equivalent."
    ```
  - **#1004** "gemini 修复windows上Worker unavailable on Windows的问题" by @Apai-Ji — Read the issue body. This appears to be a fix proposal. If it's a PR-like issue with code changes, close with guidance:
    ```bash
    gh issue close 1004 --repo thedotmack/claude-mem --reason "not planned" --comment "Thanks for the fix proposal. Code contributions should be submitted as pull requests rather than issues. If you'd like to contribute this fix, please open a PR targeting the main branch. The Windows worker startup issues are tracked in #785, #807, and #843."
    ```

- [ ] After triaging all Windows issues, output a summary: how many were closed (duplicates + insufficient detail), how many were labeled and kept open, and what the canonical issues are for each sub-problem.
