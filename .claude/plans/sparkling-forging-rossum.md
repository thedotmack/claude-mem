# Phase 3+4 (Combined): Enhanced Telemetry + Effort Configuration

## Context

Phase 2 is complete. The original proposal's Phase 3 (sessionId option) is **skipped** --
the SDK docs confirm `sessionId` cannot be used with `resume` unless `forkSession` is also
set, which is incompatible with claude-mem's multi-turn resume pattern.

Phases 4 and 5 from the proposal are combined into this single phase because they both
modify the same code (SDKAgent.ts query options + result handling) and are individually small.

**Problem 1 (Telemetry)**: Result messages are currently ignored. The `message.type === 'result'`
handler is an empty block with a comment. Useful telemetry (`stop_reason`, `total_cost_usd`,
`num_turns`) is discarded, making it hard to debug why sessions end or track costs.

**Problem 2 (Effort)**: The observer agent always uses the SDK's default effort level ('high').
For observation processing (summarizing tool usage, extracting patterns), lower effort would
reduce cost and latency without sacrificing quality.

## Changes

### 1. Extend SDKStreamMessage interface (`src/services/worker/SDKAgent.ts`)

Add result-level fields to the locally-typed interface:

```typescript
interface SDKStreamMessage {
  session_id?: string;
  type?: string;
  subtype?: string;
  message?: unknown;
  // Result fields (present when type === 'result')
  stop_reason?: string | null;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  // Error fields (present when subtype starts with 'error_')
  errors?: string[];
}
```

### 2. Add structured result logging (`src/services/worker/SDKAgent.ts`)

Replace the empty result handler with structured telemetry:

```typescript
if (message.type === 'result') {
  if (message.subtype === 'success') {
    logger.info('SDK', 'Query completed', {
      sessionId: session.sessionDbId,
      stopReason: message.stop_reason,
      totalCostUsd: message.total_cost_usd,
      numTurns: message.num_turns
    });
  } else {
    logger.warn('SDK', `Query ended with error: ${message.subtype ?? 'unknown'}`, {
      sessionId: session.sessionDbId,
      stopReason: message.stop_reason,
      errors: message.errors
    });
  }
}
```

### 3. Add `MAGIC_CLAUDE_MEM_EFFORT` setting (`src/shared/SettingsDefaultsManager.ts`)

Add to the `SettingsDefaults` interface and defaults:

```typescript
// In interface:
MAGIC_CLAUDE_MEM_EFFORT: string;  // 'low' | 'medium' | 'high' | 'max' | '' (empty = SDK default)

// In defaults:
MAGIC_CLAUDE_MEM_EFFORT: ''  // Empty string = don't pass effort option (SDK default: 'high')
```

Using empty string as default means users don't need to configure anything -- behavior is
unchanged from before. Only users who explicitly set a value get the effort option passed.

### 4. Pass effort option to query() (`src/services/worker/SDKAgent.ts`)

In `startSession()`, read the effort setting and pass it if set:

```typescript
const effort = settings.MAGIC_CLAUDE_MEM_EFFORT;
const effortOption = effort && ['low', 'medium', 'high', 'max'].includes(effort)
  ? { effort: effort as 'low' | 'medium' | 'high' | 'max' }
  : {};

const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    ...effortOption,
    // ... existing options
  }
});
```

### 5. Expose settings in getModelId → getSDKOptions refactor (`src/services/worker/SDKAgent.ts`)

Rename `getModelId()` to `getSDKOptions()` to return both model and effort:

```typescript
private getSDKOptions(): { modelId: string; effort?: 'low' | 'medium' | 'high' | 'max' } {
  const settingsPath = path.join(homedir(), '.magic-claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const effort = settings.MAGIC_CLAUDE_MEM_EFFORT;
  const validEffort = effort && ['low', 'medium', 'high', 'max'].includes(effort)
    ? (effort as 'low' | 'medium' | 'high' | 'max')
    : undefined;
  return { modelId: settings.MAGIC_CLAUDE_MEM_MODEL, effort: validEffort };
}
```

### 6. Tests

**Unit tests for telemetry logging** (`tests/sdk-agent-telemetry.test.ts`):
- Result success message logs stop_reason, total_cost_usd, num_turns
- Result error message logs subtype and errors array
- Missing fields handled gracefully (undefined values)

**Unit tests for effort configuration** (`tests/sdk-agent-effort.test.ts` or extend existing):
- Valid effort values pass through to options
- Empty string effort = no effort option
- Invalid effort values ignored
- getSDKOptions returns correct shape

**Existing test updates**:
- `tests/sdk-agent-resume.test.ts`: Update if `getModelId` rename affects test imports

## Files

| File | Change |
|------|--------|
| `src/services/worker/SDKAgent.ts` | Extend SDKStreamMessage, add result logging, pass effort, refactor getModelId |
| `src/shared/SettingsDefaultsManager.ts` | Add MAGIC_CLAUDE_MEM_EFFORT setting + default |
| `tests/sdk-agent-telemetry.test.ts` | New: test result message telemetry logging |
| `tests/sdk-agent-effort.test.ts` | New: test effort option configuration |

## Quality Loop (Applied to This Phase)

After implementation, run this loop until only LOW issues remain:

1. `npx tsc --noEmit` -- zero type errors
2. `npx eslint <changed files>` -- zero errors
3. `npm test` -- all unit tests pass (82+ files, 1629+ tests)
4. Code review (opus) -- fix MEDIUM+ issues
5. If MEDIUM+ found → fix → goto step 1
6. `npm run build` -- clean build
7. `npm run test:sdk` -- all 3 integration tests pass
8. Commit

## Verification

1. `npx tsc --noEmit` -- zero type errors
2. `npm run build` -- clean build
3. `npm test` -- all tests pass, 0 regressions
4. `npm run test:sdk` -- 3/3 integration tests pass
5. Manual: set `MAGIC_CLAUDE_MEM_EFFORT=low` in settings.json, restart worker, verify logs show effort being passed
