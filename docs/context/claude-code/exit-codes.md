

# Claude Code Hooks Exit Code Cheat Sheet

## Exit Code Behavior [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)

- **Exit code 0**: Success. `stdout` is shown to the user in transcript mode, except for `UserPromptSubmit` hook where stdout is injected as context [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)
- **Exit code 2**: Blocking error. `stderr` is fed back to Claude to process automatically [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)  
- **Other exit codes**: Non-blocking error. `stderr` is shown to the user and execution continues [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)

## Per-Hook Event Behavior [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)

| Hook Event | Exit Code 2 Behavior |
|------------|---------------------|
| `PreToolUse` | Blocks the tool call, shows stderr to Claude [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `PostToolUse` | Shows stderr to Claude (tool already ran) [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `Notification` | N/A, shows stderr to user only [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `UserPromptSubmit` | Blocks prompt processing, erases prompt, shows stderr to user only [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `Stop` | Blocks stoppage, shows stderr to Claude [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `SubagentStop` | Blocks stoppage, shows stderr to Claude subagent [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `PreCompact` | N/A, shows stderr to user only [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `SessionStart` | N/A, shows stderr to user only [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |
| `SessionEnd` | N/A, shows stderr to user only [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output) |

## Quick Reference

- **Success**: `process.exit(0)` - Operation completed successfully
- **Block & feedback**: `process.exit(2)` - Block operation and give Claude feedback via stderr  
- **Non-blocking error**: `process.exit(1)` - Show error to user but continue execution

**Important**: Claude Code does not see stdout if the exit code is 0, except for the `UserPromptSubmit` hook where stdout is injected as context [(1)](https://docs.claude.com/en/docs/claude-code/hooks#hook-output)