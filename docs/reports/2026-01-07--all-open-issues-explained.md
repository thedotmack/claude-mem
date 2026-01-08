# All Open Issues Explained

*Generated: January 7, 2026*

This report provides plain English explanations of all 12 open GitHub issues, their root causes, and proposed solutions.

---

## Critical Priority (P0)

### #603 - Memory Leak from Child Processes

When you use claude-mem on Linux/Mac, it spawns helper processes to analyze your work. These processes never get cleaned up when they're done - they just sit there eating RAM. One user had 121 zombie processes using 44GB of memory after 6 hours.

**Root cause:** The `getChildProcesses()` function in ProcessManager.ts only works on Windows (using WMIC). On Linux/Mac, it returns an empty array, so child processes are never tracked or killed during cleanup.

**Proposed solution:** Add Unix child process enumeration using `pgrep -P <pid>` to find and kill child processes when the worker shuts down or restarts.

---

### #596 - SDK Crashes on Startup

Sometimes when the plugin tries to start its AI helper, it crashes immediately with "ProcessTransport not ready." It's a timing issue - the plugin tries to send data before the helper process is fully started up.

**Root cause:** The Claude Agent SDK spawns a subprocess, but the plugin immediately tries to write to stdin before the process has finished initializing. There's no retry mechanism.

**Proposed solution:** Add a retry wrapper with exponential backoff (100ms → 200ms → 400ms) around the SDK query call. If it fails with "ProcessTransport not ready," wait and try again up to 3 times.

---

### #587 - Observations Stop Being Saved

After you restart the worker (or it crashes), the plugin thinks it can resume an old session that doesn't exist anymore. The AI helper just sits there waiting instead of processing your work, so nothing gets saved.

**Root cause:** The `memorySessionId` persists in the database across worker restarts, but the actual SDK session is gone. The plugin tries to resume a non-existent session, and the SDK responds with "awaiting data" instead of processing.

**Proposed solution:** Track whether the `memorySessionId` was captured during the current worker run with a `memorySessionIdCapturedThisRun` flag. Only attempt to resume if this flag is true.

---

## High Priority (P1)

### #602 - Windows Won't Start

The plugin uses an old Windows command called `wmic` that Microsoft removed from Windows 11. So Windows users get errors and the plugin won't start properly.

**Root cause:** ProcessManager.ts uses `wmic process where "parentprocessid=X"` to enumerate child processes, but WMIC is deprecated and removed from modern Windows 11 builds.

**Proposed solution:** Replace WMIC with `tasklist /FI "PID eq X" /FO CSV` as the primary method, with PowerShell `Get-CimInstance Win32_Process` as a fallback.

---

### #588 - Unexpected API Charges

If you have an Anthropic API key in your project's `.env` file, the plugin silently uses it and charges your account. Users with Claude Max subscriptions were surprised by extra bills because the plugin found their API key and used it without asking.

**Root cause:** The default provider is set to `'claude'` in SettingsDefaultsManager.ts, and the Claude Agent SDK automatically discovers `ANTHROPIC_API_KEY` from environment variables. The plugin inherits the parent process environment, exposing any API keys.

**Proposed solution:** Either change the default provider to `'gemini'` (which has a free tier), or add a first-run warning that clearly states API costs will be incurred. Consider requiring explicit opt-in for Anthropic API usage.

---

### #591 - OpenRouter Provider Broken

When using OpenRouter as your AI provider, the plugin can't save observations because it's missing an internal ID that normally comes from Claude's API. OpenRouter doesn't provide this ID, and the plugin doesn't handle that.

**Root cause:** OpenRouterAgent.ts has no mechanism to capture or generate a `memorySessionId`. Unlike the Claude SDK which returns a `session_id` in responses, OpenRouter's API is stateless and doesn't provide session identifiers.

**Proposed solution:** Generate a UUID for `memorySessionId` at the start of `OpenRouterAgent.startSession()` before calling `processAgentResponse()`. The same fix is needed for GeminiAgent.ts.

---

### #598 - Plugin Messages in Your History

When you use `/resume` in Claude Code, you see a bunch of "Hello memory agent" messages that the plugin sent internally. These should be hidden from your conversation history but they're leaking through.

**Root cause:** The plugin yields messages with `session_id: session.contentSessionId` (the user's session) instead of `session.memorySessionId` (the plugin's internal session). This causes the SDK to associate plugin messages with the user's conversation.

**Proposed solution:** Change SDKAgent.ts line 289 to use `memorySessionId` instead of `contentSessionId`. Also consider removing or minimizing the `continuation_greeting` in code.json.

---

### #586 - Race Condition Loses Data

There's a timing bug where the plugin tries to save your observations before it has the session ID it needs. Instead of waiting, it just throws an error and your observations are lost.

**Root cause:** The async message generator yields messages concurrently with session ID capture. If `processAgentResponse()` runs before the first SDK message with `session_id` is processed, `memorySessionId` is still null and the hard error at ResponseProcessor.ts:73-75 throws.

**Proposed solution:** Replace the hard error with a wait/retry loop that polls for up to 5 seconds for `memorySessionId` to be captured. If still missing, generate a fallback UUID.

---

## Medium Priority (P2)

### #590 - Annoying Popup Window on Windows

When the plugin starts its vector database (Chroma) on Windows, a blank terminal window pops up and stays open. You have to manually close it every time.

**Root cause:** ChromaSync.ts attempts to set `windowsHide: true` in the transport options, but the MCP SDK's StdioClientTransport doesn't pass this option through to `child_process.spawn()`.

**Proposed solution:** Wrap the `uvx` command in a PowerShell call: `powershell -NoProfile -WindowStyle Hidden -Command "uvx ..."`. This pattern already works elsewhere in the codebase (ProcessManager.ts:271).

---

### #600 - Documentation Lies

The docs describe features that don't actually exist in the released version - they're only in beta branches. Users try to use documented features and they don't work.

**Root cause:** Documentation was written for features in beta branches that were never merged to main. The MCP migration removed the skills directory but docs still reference it. Several settings are documented but not in the validated settings list.

**Proposed solution:** Audit all docs and either add "Beta Only" badges to unimplemented features, or remove references entirely. Update architecture docs to reflect MCP-based search instead of skill-based.

---

### #597 - General Bug Report

A user posted 4 screenshots saying "too many bugs" after 2 days of frustration. It's basically a meta-issue confirming the other problems are real and affecting users.

**Root cause:** The user encountered multiple v9.0.0 regressions including ProcessTransport failures, worker startup issues, and session problems. The screenshots show error states but lack specific details.

**Proposed solution:** This is resolved by fixing the other issues. Consider adding a `/troubleshoot` command or better error reporting to help users provide actionable bug reports.

---

## Low Priority (P3)

### #599 - Windows Drive Root Error

If you run Claude Code from `C:\` (the drive root), the plugin crashes because it can't figure out what to call your "project." It's an edge case but easy to fix.

**Root cause:** user-message-hook.ts uses `path.basename(process.cwd())` directly, which returns an empty string for drive roots like `C:\`. The API rejects empty project names with a 400 error.

**Proposed solution:** Use the existing `getProjectName()` utility from `src/utils/project-name.ts` which already handles drive roots by returning `"drive-C"` style names.

---

## Summary by Release

| Release | Issues | Focus |
|---------|--------|-------|
| v9.0.1 | #603, #596, #587 | Critical stability fixes |
| v9.0.2 | #602, #588, #591, #598, #586 | Windows + provider fixes |
| v9.1.0 | #590, #600, #597 | Polish + documentation |
| v9.1.x | #599 | Edge case fix |
