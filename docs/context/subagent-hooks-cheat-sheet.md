 # Claude Code Subagent Hooks Cheat Sheet

## SubagentStop Hook Overview

**When it fires:** Runs when a Claude Code subagent (Task tool call) has finished responding[(1)](https://code.claude.com/docs/en/hooks#hook-events)

**Purpose:** Allows you to control whether a subagent should continue working or stop[(1)](https://code.claude.com/docs/en/hooks#hook-events)

## Configuration

Configure in your settings files (`~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`)[(1)](https://code.claude.com/docs/en/hooks#hook-events):

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/subagent-stop-handler.sh"
          }
        ]
      }
    ]
  }
}
```
[(1)](https://code.claude.com/docs/en/hooks#hook-events)

## Input Data Structure

SubagentStop hooks receive this JSON via stdin[(1)](https://code.claude.com/docs/en/hooks#hook-events):

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "SubagentStop",
  "stop_hook_active": true
}
```
[(1)](https://code.claude.com/docs/en/hooks#hook-events)

**Key field:** `stop_hook_active` is true when Claude Code is already continuing as a result of a stop hook[(1)](https://code.claude.com/docs/en/hooks#hook-events). Check this value or process the transcript to prevent Claude Code from running indefinitely[(1)](https://code.claude.com/docs/en/hooks#hook-events).

## Decision Control

SubagentStop hooks can control whether Claude must continue[(1)](https://code.claude.com/docs/en/hooks#hook-events):

- **`"block"`** - Prevents Claude from stopping. You must populate `reason` for Claude to know how to proceed[(1)](https://code.claude.com/docs/en/hooks#hook-events)
- **`undefined`** - Allows Claude to stop. `reason` is ignored[(1)](https://code.claude.com/docs/en/hooks#hook-events)

JSON output format[(1)](https://code.claude.com/docs/en/hooks#hook-events):

```json
{
  "decision": "block",
  "reason": "Must be provided when Claude is blocked from stopping"
}
```
[(1)](https://code.claude.com/docs/en/hooks#hook-events)

## Prompt-Based Hooks

SubagentStop supports prompt-based hooks that use an LLM to make intelligent decisions[(2)](https://code.claude.com/docs/en/hooks#prompt-based-hooks):

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if the subagent completed its task: $ARGUMENTS",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```
[(2)](https://code.claude.com/docs/en/hooks#prompt-based-hooks)

The LLM responds with JSON containing[(2)](https://code.claude.com/docs/en/hooks#prompt-based-hooks):

```json
{
  "decision": "approve",
  "reason": "Explanation for the decision",
  "continue": false,
  "stopReason": "Message shown to user",
  "systemMessage": "Warning or context"
}
```
[(2)](https://code.claude.com/docs/en/hooks#prompt-based-hooks)

## Key Differences from PostToolUse

| Feature | SubagentStop | PostToolUse |
|---------|--------------|-------------|
| **Trigger** | When a subagent finishes responding[(1)](https://code.claude.com/docs/en/hooks#hook-events) | After a tool completes successfully[(1)](https://code.claude.com/docs/en/hooks#hook-events) |
| **Matchers** | No matchers (applies to all subagents)[(1)](https://code.claude.com/docs/en/hooks#hook-events) | Supports tool name matchers like `Bash`, `Write`, `Edit`[(1)](https://code.claude.com/docs/en/hooks#hook-events) |
| **Decision Control** | Can block stoppage with `"decision": "block"`[(1)](https://code.claude.com/docs/en/hooks#hook-events) | Can block with `"decision": "block"` but tool already ran[(1)](https://code.claude.com/docs/en/hooks#hook-events) |
| **Exit Code 2** | Blocks stoppage, shows stderr to Claude subagent[(1)](https://code.claude.com/docs/en/hooks#hook-events) | Shows stderr to Claude (tool already ran)[(1)](https://code.claude.com/docs/en/hooks#hook-events) |

## SDK Support

**Python SDK:** Note that due to setup limitations, the Python SDK does not support SessionStart, SessionEnd, and Notification hooks[(3)](https://platform.claude.com/docs/en/agent-sdk/python#hook-types)

**TypeScript SDK:** Full support for SubagentStop hooks[(4)](https://platform.claude.com/docs/en/agent-sdk/typescript#hook-types)

TypeScript type definition[(4)](https://platform.claude.com/docs/en/agent-sdk/typescript#hook-types):

```typescript
type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
}
```
[(4)](https://platform.claude.com/docs/en/agent-sdk/typescript#hook-types)

## Known Limitations

According to a GitHub issue, SubagentStop hooks cannot identify which specific subagent finished because all subagents share the same session ID[(5)](https://github.com/anthropics/claude-code/issues/7881). The hook input doesn't include `subagent_type` or a unique `subagent_id`, making it impossible to track individual subagent performance or maintain agent-specific state[(5)](https://github.com/anthropics/claude-code/issues/7881).

## Execution Details

- **Timeout:** 60-second execution limit by default, configurable per command[(1)](https://code.claude.com/docs/en/hooks#hook-events)
- **Parallelization:** All matching hooks run in parallel[(1)](https://code.claude.com/docs/en/hooks#hook-events)
- **Output:** Progress shown in transcript mode (Ctrl-R)[(1)](https://code.claude.com/docs/en/hooks#hook-events)
- **Does not run:** If stoppage occurred due to a user interrupt[(1)](https://code.claude.com/docs/en/hooks#hook-events)