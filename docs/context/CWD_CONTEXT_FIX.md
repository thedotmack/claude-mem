# CWD Context Fix - Technical Documentation

## Overview

This fix adds working directory (CWD) context propagation through the entire claude-mem pipeline, enabling the SDK agent to have spatial awareness of which directory/repository it's observing.

## Problem Statement

Previously, the SDK agent would:
- Search wrong repositories when analyzing file operations
- Report "file not found" for files that actually exist
- Lack context about which project was being worked on
- Generate inaccurate observations due to spatial confusion

## Solution

The CWD information now flows through the entire system:

```
Hook Input (cwd) → Worker API (cwd) → SessionManager (cwd) → SDK Agent (tool_cwd)
```

## Data Flow

### 1. Hook Layer (`save-hook.ts`)
```typescript
export interface PostToolUseInput {
  session_id: string;
  cwd: string;  // ← Captured from Claude Code
  tool_name: string;
  tool_input: any;
  tool_response: any;
}
```

The hook extracts `cwd` and includes it in the worker API request:
```typescript
body: JSON.stringify({
  tool_name,
  tool_input,
  tool_response,
  prompt_number,
  cwd: cwd || ''  // ← Passed to worker
})
```

### 2. Worker Service (`worker-service.ts`)
```typescript
const { tool_name, tool_input, tool_response, prompt_number, cwd } = req.body;

this.sessionManager.queueObservation(sessionDbId, {
  tool_name,
  tool_input,
  tool_response,
  prompt_number,
  cwd  // ← Forwarded to queue
});
```

### 3. Session Manager (`SessionManager.ts`)
```typescript
session.pendingMessages.push({
  type: 'observation',
  tool_name: data.tool_name,
  tool_input: data.tool_input,
  tool_response: data.tool_response,
  prompt_number: data.prompt_number,
  cwd: data.cwd  // ← Included in message queue
});
```

### 4. SDK Agent (`SDKAgent.ts`)
```typescript
content: buildObservationPrompt({
  id: 0,
  tool_name: message.tool_name!,
  tool_input: JSON.stringify(message.tool_input),
  tool_output: JSON.stringify(message.tool_response),
  created_at_epoch: Date.now(),
  cwd: message.cwd  // ← Passed to prompt builder
})
```

### 5. Prompt Generation (`prompts.ts`)
```typescript
return `<tool_used>
  <tool_name>${obs.tool_name}</tool_name>
  <tool_time>${new Date(obs.created_at_epoch).toISOString()}</tool_time>${obs.cwd ? `
  <tool_cwd>${obs.cwd}</tool_cwd>` : ''}  // ← Included in XML
  <tool_input>${JSON.stringify(toolInput, null, 2)}</tool_input>
  <tool_output>${JSON.stringify(toolOutput, null, 2)}</tool_output>
</tool_used>`;
```

## SDK Agent Prompt Changes

The init prompt now includes a "SPATIAL AWARENESS" section:

```
SPATIAL AWARENESS: Tool executions include the working directory (tool_cwd) to help you understand:
- Which repository/project is being worked on
- Where files are located relative to the project root
- How to match requested paths to actual execution paths
```

## Example Usage

When a user executes a read operation in `/home/user/my-project`:

```xml
<tool_used>
  <tool_name>ReadTool</tool_name>
  <tool_time>2025-11-10T19:18:03.065Z</tool_time>
  <tool_cwd>/home/user/my-project</tool_cwd>
  <tool_input>
  {
    "path": "src/index.ts"
  }
  </tool_input>
  <tool_output>
  {
    "content": "export default..."
  }
  </tool_output>
</tool_used>
```

The SDK agent now knows:
1. The operation happened in `/home/user/my-project`
2. The file `src/index.ts` is relative to that directory
3. Which repository context to search when generating observations

## Testing

8 comprehensive tests validate the CWD propagation:

```bash
npx tsx --test tests/cwd-propagation.test.ts
```

All tests verify:
- Type interfaces include `cwd` fields
- Hook extracts and passes `cwd`
- Worker accepts and forwards `cwd`
- SDK agent includes `cwd` in prompts
- End-to-end flow is correct

## Benefits

1. **Spatial Awareness**: SDK agent knows which directory/repository it's observing
2. **Accurate Path Matching**: Can verify if requested paths match executed paths
3. **Better Summaries**: Won't search wrong repositories or report false negatives
4. **Works with All Models**: Even Haiku benefits from correct context (no need for Opus workaround)

## Backward Compatibility

- `cwd` is optional in all interfaces (`cwd?: string`)
- Missing `cwd` values are handled gracefully (defaults to empty string)
- Existing observations without `cwd` continue to work
- No database migration required (CWD is transient, not persisted)

## Related Issues

Fixes issue #73 (CWD context missing from SDK agent)
