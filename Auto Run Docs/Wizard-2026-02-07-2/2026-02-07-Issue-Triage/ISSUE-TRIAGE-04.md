# Phase 04: Consolidate Duplicate Clusters

This phase is the highest-impact triage action. Many issues report the same underlying bug with slightly different symptoms. For each cluster, we keep ONE canonical issue (the most detailed/recent) and close all duplicates pointing to it. This dramatically reduces the issue count and clarifies what actually needs fixing.

## Tasks

- [x] **Cluster A: CLAUDE.md Pollution** — Keep **#793** ("isProjectRoot() doesn't detect subdirectories within git repos") as the canonical issue. Close the rest as duplicates. This is the most detailed report with root cause analysis:
  > **Completed**: All 11 duplicate issues (#952, #941, #912, #778, #758, #734, #697, #641, #635, #609, #955) closed with comments pointing to canonical #793.
  - **#952** "CLAUDE.md files written inside .git/ directories corrupt git repository" by @Fato07
    ```bash
    gh issue close 952 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The root cause is isProjectRoot() failing to detect subdirectories within git repos, causing CLAUDE.md files to be written everywhere including .git/. Tracking the fix in #793."
    ```
  - **#941** "claude-mem creates CLAUDE.md files in arbitrary working directories" by @donghyuk-bmsmile
    ```bash
    gh issue close 941 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The root cause is the isProjectRoot() detection logic. Tracking the fix in #793."
    ```
  - **#912** "Bug: CLAUDE.md files in Android res/ directories break builds (aapt2 failure)" by @DennisHartrampf
    ```bash
    gh issue close 912 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. CLAUDE.md files in subdirectories (including Android res/) are caused by the isProjectRoot() detection bug. Tracking the fix in #793."
    ```
  - **#778** "Bug: 50-120+ CLAUDE.md files created per session causing repository pollution" by @murillodutt
    ```bash
    gh issue close 778 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The mass CLAUDE.md creation is caused by isProjectRoot() not detecting subdirectories within git repos. Tracking the fix in #793."
    ```
  - **#758** "Claude-mem creates empty CLAUDE.md files in all folders" by @vikasbnsl
    ```bash
    gh issue close 758 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. Tracking the fix for CLAUDE.md file pollution in #793."
    ```
  - **#734** "Bug: CLAUDE.md files created inside .git directory causing git pull failures" by @moyuu-az
    ```bash
    gh issue close 734 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793 and #952. CLAUDE.md files in .git/ are caused by the isProjectRoot() detection bug. Tracking the fix in #793."
    ```
  - **#697** "CLAUDE.md file creation causes Python package shadowing when working in subdirectories" by @nyflyer
    ```bash
    gh issue close 697 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. CLAUDE.md files in subdirectories (causing Python import shadowing) are caused by the isProjectRoot() detection bug. Tracking the fix in #793."
    ```
  - **#641** "Bug: Observation system creates CLAUDE.md files in project subdirectories and duplicate nested directories" by @yungweng
    ```bash
    gh issue close 641 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. Tracking the fix for CLAUDE.md subdirectory pollution in #793."
    ```
  - **#635** "Bug: CLAUDE.md folder context files not generating due to JSON parsing error" by @AndaAndaman
    ```bash
    gh issue close 635 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The folder context generation issues are related to the isProjectRoot() detection logic. Tracking the fix in #793."
    ```
  - **#609** "why does this leave CLAUDE.md files literally all over?" by @tommyjcarpenter
    ```bash
    gh issue close 609 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The root cause is isProjectRoot() not properly detecting subdirectories within git repos. Tracking the fix in #793."
    ```
  - **#955** "Folder-level CLAUDE.md creates orphan directories due to relative path resolution bug" by @sonyschan
    ```bash
    gh issue close 955 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #793. The orphan directory creation is a consequence of the isProjectRoot() detection bug. Tracking the fix in #793."
    ```

- [x] **Cluster B: FOLDER_CLAUDEMD_ENABLED Not Implemented** — Keep **#942** ("CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is documented but not implemented") by @costa-marcello as the canonical issue. This is the most recent and clearly describes the documentation vs. implementation gap:
  > **Completed**: All 6 duplicate issues (#788, #787, #767, #760, #671, #632) closed with comments pointing to canonical #942.
  - **#788** "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is documented but not implemented" by @cool-RR
    ```bash
    gh issue close 788 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. The CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is documented in settings but not enforced in code. Tracking implementation in #942."
    ```
  - **#787** "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is ignored - files still generated" by @costa-marcello
    ```bash
    gh issue close 787 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. Tracking the implementation of this setting in #942."
    ```
  - **#767** "Feature request: Add setting to disable folder CLAUDE.md auto-generation" by @omriariav
    ```bash
    gh issue close 767 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. The setting (CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED) already exists in documentation but isn't enforced yet. Tracking implementation in #942."
    ```
  - **#760** "Bug: CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting is not checked" by @mkdelta221
    ```bash
    gh issue close 760 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. Tracking the implementation of this setting check in #942."
    ```
  - **#671** "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED is documented but not enforced" by @Danielalnajjar
    ```bash
    gh issue close 671 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. Tracking the implementation of this setting in #942."
    ```
  - **#632** "Feature: Add setting to disable CLAUDE.md file generation in subdirectories" by @morfize
    ```bash
    gh issue close 632 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #942. The setting already exists (CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED) but isn't enforced yet. Tracking implementation in #942."
    ```

- [x] **Cluster C: Orphaned/Zombie Processes** — Keep **#1010** ("Worker daemon spawns orphaned claude-sonnet-4-5 subagent processes") as the canonical issue. It's the most recent with the clearest reproduction steps:
  > **Completed**: All 10 duplicate issues (#1007, #1003, #980, #906, #902, #857, #852, #803, #789, #701) closed with comments pointing to canonical #1010.
  - **#1007** "Critical: Daemon spawns hundreds of orphaned processes, consumes all system RAM and swap" by @bdteo
    ```bash
    gh issue close 1007 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. The orphaned subprocess accumulation is tracked in #1010 with detailed reproduction steps."
    ```
  - **#1003** "Bug: Observer subprocesses never terminate after user CLI session ends" by @gladego
    ```bash
    gh issue close 1003 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Observer subprocess lifecycle management is tracked in #1010."
    ```
  - **#980** "[BUG] Observer session processes not cleaned up - memory leak (v9.0.12)" by @JhihJian
    ```bash
    gh issue close 980 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Process cleanup issues are tracked in #1010."
    ```
  - **#906** "Worker daemon spawns subagents that never terminate (resource leak)" by @evoleinik
    ```bash
    gh issue close 906 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Subagent lifecycle management is tracked in #1010."
    ```
  - **#902** "Orphaned subprocesses accumulate during heavy tool usage" by @irudkevich
    ```bash
    gh issue close 902 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Subprocess accumulation is tracked in #1010."
    ```
  - **#857** "Observation generator deadlock during high-frequency tool use" by @costa-marcello
    ```bash
    gh issue close 857 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. The observation generator deadlock is related to the subprocess lifecycle issue tracked in #1010."
    ```
  - **#852** "Orphaned Claude subprocesses on macOS - cleanup not terminating processes" by @dkhylan
    ```bash
    gh issue close 852 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. macOS subprocess cleanup is tracked in #1010."
    ```
  - **#803** "Bug: Worker Service Accumulates Claude Processes Without Limit (13GB+ Memory Leak)" by @oliveagle
    ```bash
    gh issue close 803 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Unbounded process accumulation is tracked in #1010."
    ```
  - **#789** "Memory Leak: worker-service daemon causes 50+ GB memory consumption" by @ktytagong
    ```bash
    gh issue close 789 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Worker memory consumption via orphaned subprocesses is tracked in #1010."
    ```
  - **#701** "Process leak regression in v9.0.4: 209 orphaned claude processes consuming 2.5-3.5GB RAM" by @LeahArmstrong
    ```bash
    gh issue close 701 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #1010. Process leak regression is tracked in #1010."
    ```

- [x] **Cluster D: Windows Popup/Flash** — Keep **#997** ("Windows VSCode CLI: Bun command prompt spam is completely broken") as the canonical issue. Close the rest as duplicates:
  > **Completed**: All 6 duplicate issues (#981, #871, #810, #681, #676, #688) closed with comments pointing to canonical #997.
  - **#981** "Windows: bun.exe popups still appear on v9.0.17" by @dsk2k
    ```bash
    gh issue close 981 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Windows bun.exe popup issues are tracked in #997."
    ```
  - **#871** "Windows: cmd.exe windows flash on every hook invocation due to bun.cmd wrapper" by @cryptodoran
    ```bash
    gh issue close 871 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Windows console window flashing is tracked in #997."
    ```
  - **#810** "[Windows] Hook commands spawn zombie uvx.exe console windows" by @twhitteberry
    ```bash
    gh issue close 810 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Windows console window spawning is tracked in #997."
    ```
  - **#681** "Windows Terminal Popup Regression" by @xingyu42
    ```bash
    gh issue close 681 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Windows Terminal popup regression is tracked in #997."
    ```
  - **#676** "Windows Terminal console window repeatedly opens and closes on hook execution" by @MrViSiOn
    ```bash
    gh issue close 676 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Console window flicker is tracked in #997."
    ```
  - **#688** "安装且运行claude-mem之后，我每次对话claude都会弹出nodejs黑窗口" by @lby-1
    ```bash
    gh issue close 688 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #997. Windows console popup on hook execution (Node.js black window) is tracked in #997."
    ```

- [x] **Cluster E: Zod Cyclical Schema** — Keep **#975** as canonical, close **#976**:
  > **Completed**: Issue #976 closed as duplicate pointing to canonical #975.
  - **#976** "Stop hook fails: cyclical schema error in zod-to-json-schema (code 738)" by @jensechterling
    ```bash
    gh issue close 976 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #975. The Zod cyclical schema resolution error in the stop hook is tracked in #975."
    ```

- [x] **Cluster F: SessionStart Exit Code 3** — Keep **#658** as canonical (earliest, most detailed), close duplicates:
  > **Completed**: All 4 duplicate issues (#985, #686, #747, #775) closed with comments pointing to canonical #658.
  - **#985** "user-message-hook.js exits code 3 and writes to stderr" by @30robert85-ctrl
    ```bash
    gh issue close 985 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #658. The exit code 3 (USER_MESSAGE_ONLY) behavior in hooks is tracked in #658."
    ```
  - **#686** "SessionStart hook shows error due to exit code 3 in user-message-hook.js" by @victordelrosal
    ```bash
    gh issue close 686 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #658. The exit code 3 display issue is tracked in #658."
    ```
  - **#747** "SessionStart hook shows error in Claude Code due to non-zero exit code" by @YvesMlk
    ```bash
    gh issue close 747 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #658. The non-zero exit code display issue is tracked in #658."
    ```
  - **#775** "SessionStart:startup hook error on Claude Code startup" by @jikuya
    ```bash
    gh issue close 775 --repo thedotmack/claude-mem --reason "not planned" --comment "Duplicate of #658. SessionStart hook error display is tracked in #658."
    ```

- [x] Verify all duplicate closures succeeded. Run this check to count remaining open issues from this phase:
  ```bash
  DUPES="952 941 912 778 758 734 697 641 635 609 955 788 787 767 760 671 632 1007 1003 980 906 902 857 852 803 789 701 981 871 810 681 676 688 976 985 686 747 775"
  OPEN_COUNT=0
  for i in $DUPES; do
    STATE=$(gh issue view $i --repo thedotmack/claude-mem --json state --jq ".state" 2>/dev/null)
    if [ "$STATE" = "OPEN" ]; then
      echo "STILL OPEN: #$i"
      OPEN_COUNT=$((OPEN_COUNT + 1))
    fi
  done
  echo "Total still open: $OPEN_COUNT (expected: 0)"
  ```
  If any remain open, re-run the failed close commands.
  > **Verified**: All 37 duplicate issues across 6 clusters (A-F) confirmed closed. 0 issues remain open. Verification completed 2026-02-07.
