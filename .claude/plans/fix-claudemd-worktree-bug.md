# Fix CLAUDE.md Worktree Bug - Implementation Plan

## Problem Statement

CLAUDE.md files are being written to the wrong directory when using git worktrees. The worker service writes files relative to its own `process.cwd()` instead of the project's working directory (`cwd`) from the observation.

**Reproduction scenario:**
1. Start Claude Code in `budapest` worktree → worker starts with `cwd=budapest`
2. Run Claude Code in `~/Scripts/claude-mem/` (main repo)
3. Observations created with relative file paths (e.g., `src/utils/foo.ts`)
4. `updateFolderClaudeMdFiles` writes to `budapest/src/utils/CLAUDE.md` instead of main repo

## Root Cause Analysis

The `cwd` (project root path) IS captured and stored:
- `SessionRoutes.ts:309,403` - receives `cwd` from hooks
- `PendingMessageStore.ts:70` - stores `cwd` in database
- `SDKAgent.ts:295` - passes `cwd` to prompt builder

But `cwd` is NOT passed to file writing:
- `ResponseProcessor.ts:222-225` - calls `updateFolderClaudeMdFiles(allFilePaths, session.project, port)` without `cwd`
- `claude-md-utils.ts:219` - uses `path.dirname(filePath)` which produces relative paths
- Relative paths resolve against worker's `process.cwd()`, not project root

---

## Phase 0: Documentation & API Inventory

### Allowed APIs (from codebase analysis)

**File: `src/utils/claude-md-utils.ts`**
```typescript
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  port: number
): Promise<void>
```

**File: `src/sdk/parser.ts`**
```typescript
export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  // NOTE: Does NOT include cwd
}
```

**File: `src/services/worker-types.ts`**
```typescript
export interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt_number?: number;
  cwd?: string;  // <-- Source of project root
  last_assistant_message?: string;
}
```

**File: `src/shared/paths.ts`** - Path utilities
```typescript
import path from 'path';
// Standard pattern: path.join(baseDir, relativePath)
```

### Anti-Patterns to Avoid

1. **DO NOT** add `cwd` to `ParsedObservation` - it comes from message, not agent response
2. **DO NOT** use `process.cwd()` for project-specific paths
3. **DO NOT** assume file paths are absolute - they are relative from agent response
4. **DO NOT** modify the parser - file paths come from agent XML output

---

## Phase 1: Add `projectRoot` Parameter to `updateFolderClaudeMdFiles`

### What to implement

Modify the function signature to accept an optional `projectRoot` parameter for resolving relative paths to absolute paths.

### Files to modify

**File: `src/utils/claude-md-utils.ts`**

**Location: Lines 206-210 (function signature)**

Current:
```typescript
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  port: number
): Promise<void>
```

New:
```typescript
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  port: number,
  projectRoot?: string
): Promise<void>
```

**Location: Lines 215-228 (folder extraction logic)**

Current:
```typescript
const folderPaths = new Set<string>();
for (const filePath of filePaths) {
  if (!filePath || filePath === '') continue;
  const folderPath = path.dirname(filePath);
  if (folderPath && folderPath !== '.' && folderPath !== '/') {
    if (isProjectRoot(folderPath)) {
      logger.debug('FOLDER_INDEX', 'Skipping project root CLAUDE.md', { folderPath });
      continue;
    }
    folderPaths.add(folderPath);
  }
}
```

New:
```typescript
const folderPaths = new Set<string>();
for (const filePath of filePaths) {
  if (!filePath || filePath === '') continue;

  // Resolve relative paths to absolute using projectRoot
  let absoluteFilePath = filePath;
  if (projectRoot && !path.isAbsolute(filePath)) {
    absoluteFilePath = path.join(projectRoot, filePath);
  }

  const folderPath = path.dirname(absoluteFilePath);
  if (folderPath && folderPath !== '.' && folderPath !== '/') {
    if (isProjectRoot(folderPath)) {
      logger.debug('FOLDER_INDEX', 'Skipping project root CLAUDE.md', { folderPath });
      continue;
    }
    folderPaths.add(folderPath);
  }
}
```

### Documentation references

- Pattern for `path.isAbsolute()`: Standard Node.js path module
- Pattern for `path.join(base, relative)`: Used throughout `src/shared/paths.ts`

### Verification checklist

1. [ ] `grep -n "updateFolderClaudeMdFiles" src/utils/claude-md-utils.ts` shows new signature
2. [ ] `grep -n "path.isAbsolute" src/utils/claude-md-utils.ts` confirms new check added
3. [ ] `grep -n "projectRoot" src/utils/claude-md-utils.ts` shows parameter usage
4. [ ] Existing callers still compile (optional param is backward compatible)

### Anti-pattern guards

- **DO NOT** make `projectRoot` required - breaks existing callers
- **DO NOT** use `process.cwd()` as default - defeats purpose of fix
- **DO NOT** modify the API endpoint format - path resolution is caller's responsibility

---

## Phase 2: Pass `cwd` from Message to `updateFolderClaudeMdFiles`

### What to implement

Extract `cwd` from the original messages being processed and pass it to `updateFolderClaudeMdFiles`.

### Challenge

The `syncAndBroadcastObservations` function receives `ParsedObservation[]` which does NOT include `cwd`. The `cwd` is in the original `PendingMessage` but is consumed during prompt generation.

### Solution

Add `projectRoot` parameter to `syncAndBroadcastObservations` and `processAgentResponse`, sourced from `session` or passed through from message processing.

### Files to modify

**File: `src/services/worker/agents/ResponseProcessor.ts`**

**Step 1: Update `processAgentResponse` signature (lines 46-55)**

Current:
```typescript
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string
): Promise<void>
```

New:
```typescript
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string
): Promise<void>
```

**Step 2: Pass `projectRoot` to `syncAndBroadcastObservations` (line 101-109)**

Current:
```typescript
await syncAndBroadcastObservations(
  observations,
  result,
  session,
  dbManager,
  worker,
  discoveryTokens,
  agentName
);
```

New:
```typescript
await syncAndBroadcastObservations(
  observations,
  result,
  session,
  dbManager,
  worker,
  discoveryTokens,
  agentName,
  projectRoot
);
```

**Step 3: Update `syncAndBroadcastObservations` signature (lines 153-161)**

Current:
```typescript
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void>
```

New:
```typescript
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void>
```

**Step 4: Update `updateFolderClaudeMdFiles` call (lines 222-229)**

Current:
```typescript
if (allFilePaths.length > 0) {
  updateFolderClaudeMdFiles(
    allFilePaths,
    session.project,
    getWorkerPort()
  ).catch(error => {
    logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
  });
}
```

New:
```typescript
if (allFilePaths.length > 0) {
  updateFolderClaudeMdFiles(
    allFilePaths,
    session.project,
    getWorkerPort(),
    projectRoot
  ).catch(error => {
    logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
  });
}
```

### Verification checklist

1. [ ] `grep -n "projectRoot" src/services/worker/agents/ResponseProcessor.ts` shows parameter throughout
2. [ ] `grep -n "processAgentResponse" src/services/worker/*.ts` to find all callers
3. [ ] TypeScript compiles without errors

### Anti-pattern guards

- **DO NOT** extract `cwd` from `ParsedObservation` - it doesn't have one
- **DO NOT** store `cwd` on session globally - messages may come from different cwds (edge case)

---

## Phase 3: Update Agent Callers to Pass `cwd`

### What to implement

Update SDKAgent, GeminiAgent, and OpenRouterAgent to pass `message.cwd` to `processAgentResponse`.

### Files to modify

**File: `src/services/worker/SDKAgent.ts`**

Find the `processAgentResponse` call and add the `projectRoot` parameter from `message.cwd`.

**Pattern to follow (from SDKAgent.ts:289-296):**
```typescript
const obsPrompt = buildObservationPrompt({
  id: 0,
  tool_name: message.tool_name!,
  tool_input: JSON.stringify(message.tool_input),
  tool_output: JSON.stringify(message.tool_response),
  created_at_epoch: Date.now(),
  cwd: message.cwd  // <-- This is available
});
```

**Challenge:** `processAgentResponse` is called after the SDK response, not in the message loop. Need to track `lastCwd` from messages.

**Solution:** Store `lastCwd` from messages being processed and pass to `processAgentResponse`.

**File: `src/services/worker/GeminiAgent.ts`** - Same pattern
**File: `src/services/worker/OpenRouterAgent.ts`** - Same pattern

### Implementation pattern for each agent

Add tracking variable:
```typescript
let lastCwd: string | undefined;
```

In message loop, capture cwd:
```typescript
if (message.cwd) {
  lastCwd = message.cwd;
}
```

In `processAgentResponse` call:
```typescript
await processAgentResponse(
  responseText,
  session,
  this.dbManager,
  this.sessionManager,
  worker,
  discoveryTokens,
  originalTimestamp,
  'SDK',  // or 'Gemini' or 'OpenRouter'
  lastCwd
);
```

### Verification checklist

1. [ ] `grep -n "lastCwd" src/services/worker/SDKAgent.ts` shows tracking
2. [ ] `grep -n "lastCwd" src/services/worker/GeminiAgent.ts` shows tracking
3. [ ] `grep -n "lastCwd" src/services/worker/OpenRouterAgent.ts` shows tracking
4. [ ] `grep -n "processAgentResponse.*lastCwd" src/services/worker/` shows all calls updated

### Anti-pattern guards

- **DO NOT** use `session.cwd` - sessions can have messages from multiple cwds
- **DO NOT** default to `process.cwd()` - defeats the fix

---

## Phase 4: Update Tests

### What to implement

Update existing tests and add new tests for the `projectRoot` functionality.

### Files to modify

**File: `tests/utils/claude-md-utils.test.ts`**

Add test cases for:
1. Relative paths with `projectRoot` resolve correctly
2. Absolute paths ignore `projectRoot`
3. Missing `projectRoot` maintains backward compatibility

### Test pattern to copy

From `tests/utils/claude-md-utils.test.ts:245-266` (folder deduplication test):
```typescript
it('should deduplicate folders from multiple files', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: [{ text: mockApiResponse }] })
  });

  await updateFolderClaudeMdFiles(
    ['/project/src/utils/file1.ts', '/project/src/utils/file2.ts'],
    'test-project',
    37777
  );

  // Should only call API once for the deduplicated folder
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
```

### New test to add

```typescript
it('should resolve relative paths using projectRoot', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: [{ text: mockApiResponse }] })
  });

  await updateFolderClaudeMdFiles(
    ['src/utils/file.ts'],  // relative path
    'test-project',
    37777,
    '/home/user/my-project'  // projectRoot
  );

  // Should write to absolute path /home/user/my-project/src/utils/CLAUDE.md
  expect(mockWriteClaudeMd).toHaveBeenCalledWith(
    '/home/user/my-project/src/utils',
    expect.any(String)
  );
});
```

### Verification checklist

1. [ ] `bun test tests/utils/claude-md-utils.test.ts` passes
2. [ ] New test case for `projectRoot` exists and passes

---

## Phase 5: Final Verification

### Verification commands

```bash
# 1. Confirm new parameter exists
grep -n "projectRoot" src/utils/claude-md-utils.ts
grep -n "projectRoot" src/services/worker/agents/ResponseProcessor.ts
grep -n "lastCwd" src/services/worker/SDKAgent.ts

# 2. Confirm path.isAbsolute check added
grep -n "path.isAbsolute" src/utils/claude-md-utils.ts

# 3. Confirm all agents updated
grep -n "processAgentResponse.*lastCwd" src/services/worker/*.ts

# 4. Run tests
bun test tests/utils/claude-md-utils.test.ts

# 5. Build and verify no TypeScript errors
npm run build
```

### Anti-pattern grep checks

```bash
# Should NOT find process.cwd() in updateFolderClaudeMdFiles path logic
grep -n "process.cwd" src/utils/claude-md-utils.ts

# Should NOT find cwd in ParsedObservation interface
grep -A 10 "interface ParsedObservation" src/sdk/parser.ts | grep cwd
```

### Manual testing

1. Start worker in one directory
2. Run Claude Code in a different directory (worktree)
3. Make a code change that creates an observation
4. Verify CLAUDE.md is written to the correct project directory

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/utils/claude-md-utils.ts` | Add `projectRoot` param, resolve relative paths |
| `src/services/worker/agents/ResponseProcessor.ts` | Pass `projectRoot` through call chain |
| `src/services/worker/SDKAgent.ts` | Track `lastCwd`, pass to `processAgentResponse` |
| `src/services/worker/GeminiAgent.ts` | Track `lastCwd`, pass to `processAgentResponse` |
| `src/services/worker/OpenRouterAgent.ts` | Track `lastCwd`, pass to `processAgentResponse` |
| `tests/utils/claude-md-utils.test.ts` | Add tests for `projectRoot` behavior |
