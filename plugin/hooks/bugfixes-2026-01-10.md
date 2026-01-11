# Bugfix Sprint: 2026-01-10

## Critical Priority (Blocks Users)

### #646 - Plugin bricks Claude Code - stdin fstat EINVAL crash
- **Impact**: Plugin completely bricks Claude Code on Linux. Users cannot recover without manual config editing.
- **Root Cause**: Bun's stdin handling causes fstat EINVAL when reading piped input
- **Related Discussion**: Check if this is a Bun upstream issue
- [ ] Investigate stdin handling in hook scripts
- [ ] Test on Linux with stdin piping
- [ ] Implement fix

### #623 - Crash-recovery loop when memory_session_id not captured
- **Impact**: Infinite loop consuming API tokens, growing queue unbounded
- **Root Cause**: memory_session_id not captured, causes repeated crash-recovery
- [ ] Add null/undefined check for memory_session_id
- [ ] Add circuit breaker for crash-recovery attempts

## High Priority

### #638 - Worker startup missing JSON output causes hooks to appear stuck
- **Impact**: UI appears stuck during worker startup
- [ ] Ensure worker startup emits proper JSON status
- [ ] Add progress feedback to hook output

### #641/#609 - CLAUDE.md files in subdirectories
- **Impact**: CLAUDE.md files scattered throughout project directories
- **Note**: This is a documented feature request that was never implemented (setting exists but doesn't work)
- [ ] Implement the `disableSubdirectoryCLAUDEmd` setting properly
- [ ] Or change default behavior to not create subdirectory files

### #635 - JSON parsing error prevents folder context generation
- **Impact**: Folder context not generating, breaks context injection
- **Root Cause**: String spread instead of array spread
- [ ] Fix the JSON parsing logic
- [ ] Add proper error handling

## Medium Priority

### #582 - Tilde paths create literal ~ directories
- **Impact**: Directories named "~" created instead of expanding to home
- [ ] Use path expansion for tilde in all path operations
- [ ] Audit all path handling code

### #642/#643 - ChromaDB search fails due to initialization timing
- **Impact**: Search fails with JSON parse error
- **Note**: #643 is a duplicate of #642
- [ ] Fix initialization timing issue
- [ ] Add proper async/await handling

### #626 - HealthMonitor hardcodes ~/.claude path
- **Impact**: Fails for users with custom config directories
- [ ] Use configurable path instead of hardcoded ~/.claude
- [ ] Respect CLAUDE_CONFIG_DIR or similar env var

### #598 - Too many messages pollute conversation history
- **Impact**: Hook messages clutter conversation
- [ ] Reduce verbosity of hook messages
- [ ] Make message frequency configurable

## Low Priority (Code Quality)

### #648 - Empty catch blocks swallow JSON parse errors
- [ ] Add proper error logging to catch blocks in SessionSearch.ts

### #649 - Inconsistent logging in CursorHooksInstaller
- [ ] Replace console.log with structured logger
- **Note**: 177 console.log calls across 20 files identified

## Won't Fix / Not a Bug

### #632 - Feature request for disabling CLAUDE.md in subdirectories
- **Note**: Covered by #641 implementation

### #633 - Help request about Cursor integration
- **Note**: Documentation/support issue, not a bug

### #640 - Arabic README translation
- **Note**: Documentation PR, not a bugfix

### #624 - Beta testing strategy proposal
- **Note**: Enhancement proposal, not a bugfix

## Already Fixed in v9.0.2

- Windows Terminal tab accumulation (#625/#628)
- Windows 11 compatibility - WMIC to PowerShell migration
- Claude Code 2.1.1 compatibility + path validation (#614)

---

**Recommended Approach**: Fix #646 first (critical blocker), then #623 (crash loop), then work through high priority issues in order of impact.
