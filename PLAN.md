# Plan: Add PreCompact Hook to Claude-Mem

## Goal

Add a `PreCompact` hook to claude-mem that injects compaction instructions: "include the last assistant message you sent here only, so we can quickly continue our work naturally, by using the claude-mem-context timeline to help stay on track."

This ensures that when context compaction occurs (manual or auto), the summary preserves continuity by including the last assistant response and referencing the claude-mem timeline.

## Phase 0: Documentation Discovery (Complete)

### Verified APIs & Patterns

**PreCompact hook (Claude Code)** — from `https://code.claude.com/docs/en/hooks`:
- **Stdin fields**: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `trigger` ("manual"/"auto"), `custom_instructions`
- **Matcher values**: `manual` (user `/compact`), `auto` (context window full)
- **Cannot block**: exit 2 just shows stderr to user
- **Output**: Standard JSON output fields (`continue`, `suppressOutput`, `systemMessage`, `hookSpecificOutput` with `additionalContext`)

**Existing handler pattern** — from `src/cli/handlers/summarize.ts`:
- Import `EventHandler`, `NormalizedHookInput`, `HookResult` from `../types.js`
- Import `ensureWorkerRunning`, `getWorkerPort` from `../../shared/worker-utils.js`
- Import `extractLastMessage` from `../../shared/transcript-parser.js`
- Import `HOOK_EXIT_CODES`, `HOOK_TIMEOUTS`, `getTimeout` from `../../shared/hook-constants.js`
- Import `ensureAuthToken` from `../../shared/AuthTokenManager.js`
- Pattern: check worker ready → extract from transcript → return result

**NormalizedHookInput** — from `src/cli/types.ts:1-13`:
- Already has `transcriptPath?: string` — PreCompact stdin includes `transcript_path` which the adapter maps to this field

**hookSpecificOutput** — from `src/cli/types.ts:18`:
- `{ hookEventName: string; additionalContext: string }` — this is how context gets injected

**Claude Code adapter** — from `src/cli/adapters/claude-code.ts:6-16`:
- Already normalizes `trigger` field? No — it only maps `session_id`, `cwd`, `prompt`, `tool_name`, `tool_input`, `tool_response`, `transcript_path`
- **Gap**: `trigger` and `custom_instructions` from PreCompact stdin are not mapped to `NormalizedHookInput`

**Handler registry** — from `src/cli/handlers/index.ts:17-34`:
- `EventType` union needs new `'pre-compact'` entry
- `handlers` record needs new entry

**hooks.json** — from `plugin/hooks/hooks.json`:
- Needs new `"PreCompact"` section with hook commands
- Pattern: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js" "${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs" hook claude-code <event-name>`

### Anti-Patterns to Avoid
- Do NOT use Agent SDK `compactionControl` — that's for SDK-based agents, not Claude Code hooks
- Do NOT try to block compaction (PreCompact can't block)
- Do NOT add worker API endpoint unless needed — the hook handler can return `additionalContext` directly without calling the worker

## Phase 1: Extend Type System

### What to implement
1. Add `trigger` and `customInstructions` fields to `NormalizedHookInput` in `src/cli/types.ts`
2. Map `trigger` and `custom_instructions` in the Claude Code adapter `src/cli/adapters/claude-code.ts`

### Files to modify
- `src/cli/types.ts:1-13` — add `trigger?: string` and `customInstructions?: string` to interface
- `src/cli/adapters/claude-code.ts:6-16` — add `trigger: r.trigger` and `customInstructions: r.custom_instructions` to normalizeInput

### Verification
- `grep -n 'trigger' src/cli/types.ts` shows the new field
- `grep -n 'custom_instructions' src/cli/adapters/claude-code.ts` shows the mapping

## Phase 2: Create PreCompact Handler

### What to implement
Create `src/cli/handlers/pre-compact.ts` following the `summarize.ts` pattern, but simpler — no worker API call needed.

The handler will:
1. Read the transcript to extract the last assistant message (using `extractLastMessage` from `src/shared/transcript-parser.ts:10`)
2. Return `hookSpecificOutput` with `additionalContext` containing:
   - The compaction instructions text
   - The last assistant message (so it's in context when the summary is generated)

### Handler logic
```typescript
// src/cli/handlers/pre-compact.ts
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';

const COMPACTION_INSTRUCTIONS = `When summarizing this conversation for compaction, include the following to ensure continuity:

1. Include the last assistant message in full below, so we can quickly continue our work naturally
2. Reference the claude-mem-context timeline to help stay on track with what was being worked on

Last assistant message:`;

export const preCompactHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { transcriptPath } = input;

    if (!transcriptPath) {
      logger.debug('HOOK', 'No transcriptPath in PreCompact hook input - skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

    const additionalContext = lastAssistantMessage
      ? `${COMPACTION_INSTRUCTIONS}\n\n${lastAssistantMessage}`
      : COMPACTION_INSTRUCTIONS;

    return {
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext
      },
      exitCode: HOOK_EXIT_CODES.SUCCESS
    };
  }
};
```

### Files to create
- `src/cli/handlers/pre-compact.ts` — new file, copy pattern from `src/cli/handlers/summarize.ts`

### Verification
- File exists and exports `preCompactHandler`
- No worker API calls (this is a local-only handler)

## Phase 3: Register Handler and Wire Hook

### What to implement
1. Add `'pre-compact'` to `EventType` union and handler registry in `src/cli/handlers/index.ts`
2. Add `PreCompact` hook configuration to `plugin/hooks/hooks.json`

### Files to modify

**`src/cli/handlers/index.ts`**:
- Line 15: Add import `import { preCompactHandler } from './pre-compact.js';`
- Lines 17-24: Add `| 'pre-compact'` to `EventType` union (with comment `// PreCompact - inject compaction instructions`)
- Lines 26-34: Add `'pre-compact': preCompactHandler` to `handlers` record
- Add re-export at bottom: `export { preCompactHandler } from './pre-compact.js';`

**`plugin/hooks/hooks.json`**:
- Add new `"PreCompact"` section after `"PostToolUse"` and before `"Stop"`:
```json
"PreCompact": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js\" \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code pre-compact",
        "timeout": 30
      }
    ]
  }
]
```

Note: No `worker-service.cjs start` step needed because PreCompact doesn't call the worker API. However, `hook claude-code pre-compact` routes through `worker-service.cjs` as the unified CLI entry point, so it still needs the bun-runner invocation. The handler itself doesn't need the worker running (it only reads the transcript file).

### Verification
- `grep -n 'pre-compact' src/cli/handlers/index.ts` shows registration
- `grep -n 'PreCompact' plugin/hooks/hooks.json` shows hook wiring
- `npm run build-and-sync` succeeds

## Phase 4: Build and Test

### What to implement
1. Run `npm run build-and-sync` to rebuild worker-service.cjs with the new handler
2. Verify the built output includes the pre-compact handler

### Verification checklist
- [ ] `npm run build-and-sync` completes without errors
- [ ] `grep 'pre-compact' plugin/scripts/worker-service.cjs` finds the handler in the bundle
- [ ] `grep 'PreCompact' plugin/hooks/hooks.json` confirms hook is wired
- [ ] Manual test: run `/compact` in Claude Code and verify the compaction summary includes the last assistant message and references claude-mem context

### Anti-pattern guards
- [ ] No `compactionControl` usage (that's Agent SDK, not Claude Code hooks)
- [ ] No worker API endpoint added (handler is local-only)
- [ ] No try/catch in the handler (fail fast — errors surface visibly)
- [ ] PreCompact handler does NOT attempt to block compaction
