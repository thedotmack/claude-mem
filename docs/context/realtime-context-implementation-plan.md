# Real-Time Context Implementation Plan

## Goal
Implement the workflow from `real-time-context-workflow.md` as a UserPromptSubmit hook that returns relevant observation content as context.

## What It Does
When user submits a prompt, the hook searches for relevant observations and returns them as context before Claude processes the request.

## Implementation

### 1. Create Real-Time Context Hook
**File:** `src/hooks/realtime-context-hook.ts`

**Logic:**
```typescript
async function getRealTimeContext(userPrompt: string, project: string): Promise<string> {
  try {
    // Search for relevant observations using the prompt
    const response = await fetch(`${workerUrl}/api/search/timeline-by-query`, {
      method: 'POST',
      body: JSON.stringify({
        query: userPrompt,
        project,
        mode: 'auto',
        depth_before: 5,
        depth_after: 5
      }),
      signal: AbortSignal.timeout(1000)
    });

    const { timeline } = await response.json();

    // Format observations as context
    return formatObservationsAsContext(timeline.observations);

  } catch (error) {
    // Silent fail - don't block prompt
    return '';
  }
}
```

**Hook Output:**
```typescript
{
  hookSpecificOutput: `# [claude-mem] real-time context

Found ${count} relevant observations for your request:

${formattedObservations}
`
}
```

### 2. Register Hook
**File:** `plugin/hooks/hooks.json`

Add entry:
```json
{
  "UserPromptSubmit": {
    "command": "node",
    "args": ["./scripts/realtime-context-hook.js"]
  }
}
```

### 3. Build Configuration
**File:** `scripts/build-hooks.js`

Add to hooks array:
```javascript
'src/hooks/realtime-context-hook.ts'
```

### 4. Environment Flag (Optional)
```bash
CLAUDE_MEM_REALTIME_CONTEXT=true  # enable feature
```

If flag is false/unset, hook returns empty context.

## What Gets Built

**New Files:**
- `src/hooks/realtime-context-hook.ts` (~80 lines)
- `plugin/scripts/realtime-context-hook.js` (built)

**Modified Files:**
- `plugin/hooks/hooks.json` (add hook registration)
- `scripts/build-hooks.js` (add to build list)

## Build & Deploy

```bash
npm run build
npm run sync-marketplace
# Hook takes effect on next session - no worker restart needed
```

## Testing

1. Enable feature: `export CLAUDE_MEM_REALTIME_CONTEXT=true`
2. Start new session
3. Ask question about past work: "How did we fix the auth bug?"
4. Check if relevant observations appear in context
5. Verify latency is acceptable (<1s)

## That's It

~80 lines of code. One hook. Uses existing search API. Done.
