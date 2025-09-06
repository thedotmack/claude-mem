# SessionStart Hook Documentation

## Official Documentation Reference
- **Source**: https://docs.anthropic.com/en/docs/claude-code/hooks#sessionstart
- **Last Verified**: 2025-08-31
- **Version**: Claude Code v2025

## Hook Payload Structure

The SessionStart hook receives the following JSON payload via stdin:

```json
{
  "session_id": "string",
  "transcript_path": "string", 
  "hook_event_name": "SessionStart",
  "source": "startup" | "compact" | "vscode" | "web"
}
```

### Field Descriptions

- **session_id**: Unique identifier for the Claude Code session
- **transcript_path**: Path to the conversation transcript JSONL file
- **hook_event_name**: Always "SessionStart" for this hook
- **source**: Indicates how the session was initiated:
  - `"startup"`: New session started normally (should load context)
  - `"compact"`: Session started after compaction (may skip context)
  - `"vscode"`: Session initiated from VS Code extension
  - `"web"`: Session initiated from web interface

## Response Format

The hook should output JSON in the following format to add context:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "string"
  }
}
```

### Response Fields

- **hookSpecificOutput**: Container for hook-specific output
- **hookEventName**: Must be "SessionStart"
- **additionalContext**: String content to add to the session context

## Implementation Notes

### Context Loading Strategy

The hook should determine whether to load context based on the `source` field:

1. **For "startup" source**: Load full context from memory
2. **For "compact" source**: Skip or load minimal context (session continuing after compaction)
3. **For "vscode"/"web" sources**: Load context as appropriate

### Error Handling

- If context loading fails, exit silently (exit code 0)
- Do not break the session start with errors
- Log errors to separate log file if needed

## Common Mistakes

### Incorrect Field Check (FIXED)
**Wrong**: Checking `payload.reason === 'continue'`
**Correct**: Checking `payload.source === 'compact'`

The payload does not have a `reason` field. The `source` field indicates the session initiation context.

## Code Location
- **File**: `/Users/alexnewman/Scripts/claude-mem/hooks/session-start.js`
- **Line**: 53-66 (field check and documentation)

## Cross-References
- General Hooks Documentation: [docs/claude-code/hooks.md](./hooks.md)
- Hook Response Formats: [docs/claude-code/hook-responses.md](./hook-responses.md)
- MCP Configuration: [docs/claude-code/mcp-configuration.md](./mcp-configuration.md)