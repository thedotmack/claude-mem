# Claude Code Hook Configuration Documentation

**LOCKED by @docs-agent | Change to 🔑 to allow @docs-agent edits**

## Official Documentation Reference

- **Source**: Claude Code Hooks API Documentation
- **Version**: v2025
- **Last Verified**: 2025-08-31
- **Official URL**: https://docs.anthropic.com/en/docs/claude-code/hooks

## Hook Configuration Structure

### Two Categories of Hooks

Claude Code hooks are divided into two distinct categories with different configuration structures:

#### 1. Tool-Related Hooks
These hooks are triggered in relation to tool usage and require a `matcher` field:
- `PreToolUse`: Executed before a tool is invoked
- `PostToolUse`: Executed after a tool completes

**Configuration Structure:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.js",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

#### 2. Non-Tool Hooks
These hooks are triggered by system events and **MUST NOT** have a `matcher` or `pattern` field:
- `PreCompact`: Before conversation compaction
- `SessionStart`: When a new session begins
- `SessionEnd`: When a session ends
- `UserPromptSubmit`: When user submits a prompt
- `Notification`: For system notifications
- `Stop`: When Claude is stopping
- `SubagentStop`: When a subagent is stopping

**Configuration Structure:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.js",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

## Common Configuration Mistakes

### ❌ INCORRECT: Adding `pattern` field to non-tool hooks
```json
{
  "hooks": {
    "PreCompact": [
      {
        "pattern": "*",  // WRONG: Non-tool hooks don't use patterns
        "hooks": [...]
      }
    ]
  }
}
```

### ✅ CORRECT: Non-tool hooks without matcher
```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/pre-compact.js",
            "timeout": 180000
          }
        ]
      }
    ]
  }
}
```

## Hook Field Reference

### Common Fields (All Hooks)
- `type`: Always `"command"` for external scripts
- `command`: Absolute path to the executable script
- `timeout`: Optional timeout in milliseconds (default: 60000)

### Tool Hook Specific
- `matcher`: Regex pattern to match tool names
  - Example: `"Edit|MultiEdit|Write"`
  - Example: `"mcp__.*__write.*"`
  - Example: `"Bash"`

### Environment Variables Available to Hooks
- `$CLAUDE_PROJECT_DIR`: Project root directory
- Standard environment variables from the shell

## Hook Input/Output

### Input (via stdin)
All hooks receive JSON input with common fields:
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  // Additional event-specific fields
}
```

### Output Options
Hooks can output:
1. **Plain text** (stdout): Added as context
2. **JSON** (stdout): Structured response for decisions
3. **Exit codes**:
   - `0`: Success, continue normally
   - `1`: General error
   - `2`: Block operation (for PreToolUse)

## Implementation Notes

### File Locations
- User settings: `~/.claude/settings.json`
- Project settings: `./.claude/settings.json`
- Local settings: `./.claude/settings.local.json`

### Settings Precedence (Highest to Lowest)
1. Enterprise managed policies
2. Command line arguments
3. Local project settings
4. Shared project settings
5. User settings

## Cross-References

- Code Implementation: `/Users/alexnewman/Scripts/claude-mem/src/commands/install.ts:263-320`
- Hook Files: `/Users/alexnewman/Scripts/claude-mem/hooks/`
- User Guide: `/Users/alexnewman/Scripts/claude-mem/README-npm.md`

## Version History

- **2025-08-31**: Fixed hook configuration to remove incorrect `pattern` field from non-tool hooks
- **2025-08-31**: Documented official hook structure requirements per Claude Code API

---
*This documentation is maintained by @docs-agent and verified against official Anthropic documentation.*