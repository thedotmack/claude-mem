# Hook Prompts System

This directory contains the centralized prompt configuration for all streaming hooks.

## Quick Edit Guide

**Want to change hook prompts?** Edit this file:
```
hook-prompts.config.ts
```

Then rebuild and reinstall:
```bash
bun run build
bun run dev:install
```

## Files in This Directory

### hook-prompts.config.ts
**EDIT THIS FILE** to change prompt content.

Contains:
- `SYSTEM_PROMPT` - Initial instructions for SDK (190 lines)
- `TOOL_MESSAGE` - Format for tool responses (10 lines)
- `END_MESSAGE` - Session completion request (10 lines)
- `HOOK_CONFIG` - Shared settings (truncation limits, SDK options)

Uses `{{variableName}}` template syntax.

### hook-prompt-renderer.ts
**DON'T EDIT** unless adding new variables or changing rendering logic.

Contains:
- `renderSystemPrompt()` - Processes system prompt template
- `renderToolMessage()` - Processes tool message template
- `renderEndMessage()` - Processes end message template
- Template substitution and auto-truncation logic

### templates/context/ContextTemplates.ts
Session start message formatting (separate from hook prompts).

## Template Variables Reference

### SYSTEM_PROMPT Variables
```typescript
{
  project: string;        // Project name (e.g., "claude-mem-source")
  sessionId: string;      // Claude Code session ID
  date: string;           // YYYY-MM-DD format
  userPrompt: string;     // Auto-truncated to 200 chars
}
```

### TOOL_MESSAGE Variables
```typescript
{
  toolName: string;       // Tool name (e.g., "Read", "Bash")
  toolResponse: string;   // Auto-truncated to 20000 chars
  userPrompt: string;     // Auto-truncated to 200 chars
  timestamp: string;      // Full ISO timestamp
  timeFormatted: string;  // HH:MM:SS format (auto-generated)
}
```

### END_MESSAGE Variables
```typescript
{
  project: string;        // Project name
  sessionId: string;      // Claude Code session ID
}
```

## Usage in Hooks

### user-prompt-submit-streaming.js
```javascript
import { renderSystemPrompt, HOOK_CONFIG } from '../src/prompts/hook-prompt-renderer.js';

const prompt = renderSystemPrompt({
  project,
  sessionId: session_id,
  date,
  userPrompt: prompt || ''
});

query({
  prompt,
  options: {
    model: HOOK_CONFIG.sdk.model,
    allowedTools: HOOK_CONFIG.sdk.allowedTools,
    maxTokens: HOOK_CONFIG.sdk.maxTokensSystem
  }
});
```

### post-tool-use-streaming.js
```javascript
import { renderToolMessage, HOOK_CONFIG } from '../src/prompts/hook-prompt-renderer.js';

const message = renderToolMessage({
  toolName: tool_name,
  toolResponse: toolResponseStr,
  userPrompt: prompt || '',
  timestamp: timestamp || new Date().toISOString()
});

query({
  prompt: message,
  options: {
    model: HOOK_CONFIG.sdk.model,
    maxTokens: HOOK_CONFIG.sdk.maxTokensTool
  }
});
```

### stop-streaming.js
```javascript
import { renderEndMessage, HOOK_CONFIG } from '../src/prompts/hook-prompt-renderer.js';

const message = renderEndMessage({
  project,
  sessionId: claudeSessionId
});

query({
  prompt: message,
  options: {
    model: HOOK_CONFIG.sdk.model,
    maxTokens: HOOK_CONFIG.sdk.maxTokensEnd
  }
});
```

## Configuration Options

Edit `HOOK_CONFIG` in `hook-prompts.config.ts`:

```typescript
export const HOOK_CONFIG = {
  // Truncation limits for template variables
  maxUserPromptLength: 200,      // Increase to show more context
  maxToolResponseLength: 20000,  // Increase for larger outputs

  // SDK configuration
  sdk: {
    model: 'claude-sonnet-4-5',  // Change model version
    allowedTools: ['Bash'],      // Add more tools if needed
    maxTokensSystem: 8192,       // Token limit for system prompt
    maxTokensTool: 8192,         // Token limit for tool messages
    maxTokensEnd: 2048,          // Token limit for end message
  },
};
```

## Example: Editing a Prompt

### Before
```typescript
export const TOOL_MESSAGE = `# Tool Response {{timeFormatted}}

Tool: {{toolName}}
User Context: "{{userPrompt}}"

\`\`\`
{{toolResponse}}
\`\`\`

Analyze and store if meaningful.`;
```

### After
```typescript
export const TOOL_MESSAGE = `# Analysis Request {{timeFormatted}}

Executed: {{toolName}}
Context: "{{userPrompt}}"
Priority: High

Output:
\`\`\`
{{toolResponse}}
\`\`\`

IMPORTANT: Only store if this contains:
- New code patterns or logic
- Architecture decisions
- Error messages with solutions
- Configuration changes

Skip trivial operations.`;
```

### Apply Changes
```bash
bun run build && bun run dev:install
```

## Benefits

### DRY Compliance
- **Before**: 3 files with 188 lines of hardcoded prompts
- **After**: 1 config file with all prompts centralized

### Maintainability
- Change prompts without touching hook implementation
- Type-safe template variables
- Consistent formatting across all hooks
- Version-controlled prompt history

### Flexibility
- Easy A/B testing of different instructions
- Simple to adjust truncation limits
- Quick model/token configuration changes
- Template variables prevent copy-paste errors

## Full Documentation

See `/Users/alexnewman/Scripts/claude-mem-source/docs/HOOK_PROMPTS.md` for:
- Detailed editing guide
- Troubleshooting common issues
- Adding new template variables
- Advanced customization
- Migration notes
