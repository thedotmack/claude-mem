# Claude Code Hooks Configuration Documentation
## Source: Official Claude Code Docs v2025
## Last Verified: 2025-08-31

## Hook Configuration Structure

### For Tool-Based Hooks (PreToolUse, PostToolUse)
These hooks use the `matcher` field to match tool patterns:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ToolPattern",  // Required for tool hooks
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60000  // Optional, in milliseconds
          }
        ]
      }
    ]
  }
}
```

### For Non-Tool Hooks (PreCompact, SessionStart, etc.)
These hooks DO NOT use matcher/pattern fields:

```json
{
  "hooks": {
    "PreCompact": [
      {
        // NO matcher or pattern field!
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.js",
            "timeout": 180000
          }
        ]
      }
    ]
  }
}
```

## Available Hook Events

### Tool-Related Hooks (use matcher)
- **PreToolUse**: Before tool execution
- **PostToolUse**: After tool execution

### System Event Hooks (no matcher)
- **PreCompact**: Before conversation compaction
- **SessionStart**: When session begins
- **SessionEnd**: When session ends (not in official docs)
- **UserPromptSubmit**: When user submits prompt
- **Notification**: When Claude needs user input
- **Stop**: When stop is requested
- **SubagentStop**: When subagent stop is requested

## Hook Payload Structure

### Common Fields (all hooks)
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "hook_event_name": "string",
  "cwd": "string"  // Current working directory
}
```

### PreCompact Specific
```json
{
  "hook_event_name": "PreCompact",
  "trigger": "manual" | "auto",
  "custom_instructions": "string"
}
```

### SessionStart Specific
```json
{
  "hook_event_name": "SessionStart",
  "source": "startup" | "compact" | "vscode" | "web"
}
```

### PreToolUse/PostToolUse Specific
```json
{
  "tool_name": "string",
  "tool_input": { /* tool specific */ },
  "tool_response": { /* PostToolUse only */ }
}
```

## Common Configuration Mistakes

### \u274c INCORRECT: Using 'pattern' for non-tool hooks
```json
{
  "hooks": {
    "PreCompact": [{
      "pattern": "*",  // \u274c WRONG - non-tool hooks don't use this
      "hooks": [...]
    }]
  }
}
```

### \u2705 CORRECT: No matcher for non-tool hooks
```json
{
  "hooks": {
    "PreCompact": [{
      // No pattern or matcher field
      "hooks": [...]
    }]
  }
}
```

### \u274c INCORRECT: Wrong matcher field name
```json
{
  "hooks": {
    "PreToolUse": [{
      "pattern": "Bash",  // \u274c WRONG field name
      "hooks": [...]
    }]
  }
}
```

### \u2705 CORRECT: Using 'matcher' for tool hooks
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",  // \u2705 Correct field name
      "hooks": [...]
    }]
  }
}
```

## Matcher Patterns for Tool Hooks

- **Exact match**: `"Bash"` - matches only Bash tool
- **Multiple tools**: `"Edit|MultiEdit|Write"` - matches any of these
- **MCP tools**: `"mcp__memory__.*"` - matches all memory server tools
- **All tools**: `"*"` - matches everything

## Environment Variables

Hooks have access to:
- `$CLAUDE_PROJECT_DIR` - Project root directory

## Settings File Locations

1. **User settings**: `~/.claude/settings.json`
2. **Project settings**: `./.claude/settings.json`
3. **Local settings**: `./.claude/settings.local.json`
4. **Managed settings**: `/Library/Application Support/ClaudeCode/managed-settings.json`

## References
- Official Docs: https://docs.anthropic.com/en/docs/claude-code/hooks
- Hook Guide: https://docs.anthropic.com/en/docs/claude-code/hooks-guide