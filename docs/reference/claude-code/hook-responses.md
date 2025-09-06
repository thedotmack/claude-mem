# Claude Code Hook Response Format Documentation
## Source: Official Claude Code Docs v2025
## Last Verified: 2025-08-31

## Common Hook Response Fields

All hooks can return these common fields:

```json
{
  "continue": true,              // Whether Claude should continue (default: true)
  "stopReason": "string",        // Message shown when continue is false
  "suppressOutput": true,        // Hide stdout from transcript (default: false)
  "systemMessage": "string"      // Optional warning message shown to user
}
```

## Hook-Specific Response Formats

### PreCompact Hook
**IMPORTANT**: PreCompact does NOT support `hookSpecificOutput`

```json
{
  "continue": true,
  "suppressOutput": true
}
```

### SessionStart Hook
SessionStart DOES support `hookSpecificOutput`:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context string to add to session"
  }
}
```

### PreToolUse Hook
```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "Reason for decision"
  }
}
```

### PostToolUse Hook
```json
{
  "decision": "block",  // Optional - blocks further processing
  "reason": "Explanation",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional information for Claude"
  }
}
```

### UserPromptSubmit Hook
```json
{
  "decision": "block",  // Optional - blocks the prompt
  "reason": "Security policy violation",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Additional context for the prompt"
  }
}
```

## Exit Codes

- `0`: Success - hook executed successfully
- `1`: Error - shown to user with stdout
- `2`: Error - shown to Claude with stderr

## Common Mistakes to Avoid

### \u274c INCORRECT: Using wrong field names
```javascript
// WRONG
{
  "decision": "block",      // \u274c Wrong field
  "reason": "Error message"  // \u274c Wrong field
}
```

### \u2705 CORRECT: Using official field names
```javascript
// RIGHT
{
  "continue": false,
  "stopReason": "Error message"
}
```

### \u274c INCORRECT: Adding hookSpecificOutput to PreCompact
```javascript
// WRONG - PreCompact doesn't support this
{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "status": "success"
  }
}
```

### \u2705 CORRECT: Simple response for PreCompact
```javascript
// RIGHT
{
  "continue": true,
  "suppressOutput": true
}
```

## References
- Official Docs: https://docs.anthropic.com/en/docs/claude-code/hooks
- Hook Examples: https://docs.anthropic.com/en/docs/claude-code/hooks-guide