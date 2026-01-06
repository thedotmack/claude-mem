# Folder CLAUDE.md Refactor - Extract to Shared Utils

## CORE DIRECTIVE

**DECOUPLE FOLDER CLAUDE.MD WRITING FROM CURSOR INTEGRATION**

The current implementation incorrectly couples folder-level CLAUDE.md generation to Cursor-specific registry lookups. The file paths from observations are already absolute - no workspace registry lookup is needed.

---

## Phase 0: Documentation Discovery (COMPLETED)

### Current Implementation Location

| Function | Location | Lines | Purpose |
|----------|----------|-------|---------|
| `updateFolderClaudeMd` | CursorHooksInstaller.ts | 128-199 | Orchestrates folder CLAUDE.md updates |
| `formatTimelineForClaudeMd` | CursorHooksInstaller.ts | 221-295 | Parses API response to markdown |
| `replaceTaggedContent` | CursorHooksInstaller.ts | 300-321 | Preserves user content outside tags |
| `writeFolderClaudeMd` | CursorHooksInstaller.ts | 326-353 | Atomic file write |

### Integration Point

**File:** `src/services/worker/agents/ResponseProcessor.ts:274-298`

Current (problematic) code:
```typescript
const registry = readCursorRegistry();
const registryEntry = registry[session.project];

if (registryEntry && (filesModified.length > 0 || filesRead.length > 0)) {
  updateFolderClaudeMd(
    registryEntry.workspacePath,  // <-- PROBLEM: Needs Cursor registry
    filesModified,
    filesRead,
    session.project,
    getWorkerPort()
  ).catch(error => { ... });
}
```

### The Problem

1. `filesModified` and `filesRead` already contain **absolute paths**
2. We don't need `workspacePath` - just extract folder from file path directly
3. Cursor registry is only populated when Cursor hooks are installed
4. This makes folder CLAUDE.md a Cursor-only feature (unintended)

### Project Utils Pattern

**From `src/utils/cursor-utils.ts:97-122`:**
- Pure functions with paths as parameters
- Atomic write pattern: temp file + rename
- `mkdirSync(dir, { recursive: true })` for directory creation

### Related Utils

**`src/utils/tag-stripping.ts`** - Handles *stripping* tags (input filtering)
- `stripMemoryTagsFromJson()` - removes `<claude-mem-context>` content
- `stripMemoryTagsFromPrompt()` - removes `<private>` content

Our `replaceTaggedContent` handles *preserving/replacing* (output writing) - complementary, not duplicative.

---

## Phase 1: Create Shared Utils File

### What to Implement

Create `src/utils/claude-md-utils.ts` with extracted and simplified functions.

### File Structure

```typescript
/**
 * CLAUDE.md File Utilities
 *
 * Shared utilities for writing folder-level CLAUDE.md files with
 * auto-generated context sections. Preserves user content outside
 * <claude-mem-context> tags.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Replace tagged content in existing file, preserving content outside tags.
 *
 * Handles three cases:
 * 1. No existing content → wraps new content in tags
 * 2. Has existing tags → replaces only tagged section
 * 3. No tags in existing content → appends tagged content at end
 */
export function replaceTaggedContent(existingContent: string, newContent: string): string {
  // Copy from CursorHooksInstaller.ts:300-321
}

/**
 * Write CLAUDE.md file to folder with atomic writes.
 * Creates directory structure if needed.
 *
 * @param folderPath - Absolute path to the folder
 * @param newContent - Content to write inside tags
 */
export function writeClaudeMdToFolder(folderPath: string, newContent: string): void {
  // Simplified from writeFolderClaudeMd - no workspacePath needed
  // Copy atomic write pattern from CursorHooksInstaller.ts:326-353
}

/**
 * Format timeline text from API response to compact CLAUDE.md format.
 *
 * @param timelineText - Raw API response text
 * @returns Formatted markdown with date headers and compact table
 */
export function formatTimelineForClaudeMd(timelineText: string): string {
  // Copy from CursorHooksInstaller.ts:221-295
}
```

### Key Simplification

**OLD `writeFolderClaudeMd` signature:**
```typescript
async function writeFolderClaudeMd(
  workspacePath: string,  // <-- REMOVE
  folderPath: string,
  newContent: string
): Promise<void>
```

**NEW `writeClaudeMdToFolder` signature:**
```typescript
export function writeClaudeMdToFolder(
  folderPath: string,     // Must be absolute path
  newContent: string
): void                   // Sync is fine, atomic anyway
```

### Verification Checklist
- [ ] File created at `src/utils/claude-md-utils.ts`
- [ ] `replaceTaggedContent` exported and handles all 3 cases
- [ ] `writeClaudeMdToFolder` exported with atomic writes
- [ ] `formatTimelineForClaudeMd` exported
- [ ] Build passes: `npm run build`

---

## Phase 2: Create Folder Index Service Function

### What to Implement

Create a new orchestrating function that replaces `updateFolderClaudeMd`. This should NOT be in CursorHooksInstaller - it's a general feature.

**Option A:** Add to `src/utils/claude-md-utils.ts` (keeps it simple)
**Option B:** Create `src/services/folder-index-service.ts` (follows service pattern)

Recommend **Option A** for simplicity - it's just one function.

### New Function

```typescript
/**
 * Update CLAUDE.md files for folders containing the given files.
 * Fetches timeline from worker API and writes formatted content.
 *
 * @param filePaths - Array of absolute file paths (modified or read)
 * @param project - Project identifier for API query
 * @param port - Worker API port
 */
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  port: number
): Promise<void> {
  // Extract unique folder paths from file paths
  const folderPaths = new Set<string>();
  for (const filePath of filePaths) {
    if (!filePath || filePath === '') continue;
    const folderPath = path.dirname(filePath);
    if (folderPath && folderPath !== '.' && folderPath !== '/') {
      folderPaths.add(folderPath);
    }
  }

  if (folderPaths.size === 0) return;

  logger.debug('FOLDER_INDEX', 'Updating CLAUDE.md files', {
    project,
    folderCount: folderPaths.size
  });

  // Process each folder
  for (const folderPath of folderPaths) {
    try {
      // Fetch timeline via existing API
      const response = await fetch(
        `http://127.0.0.1:${port}/api/search/by-file?filePath=${encodeURIComponent(folderPath)}&limit=10&project=${encodeURIComponent(project)}`
      );

      if (!response.ok) {
        logger.warn('FOLDER_INDEX', 'Failed to fetch timeline', { folderPath, status: response.status });
        continue;
      }

      const result = await response.json();
      if (!result.content?.[0]?.text) {
        logger.debug('FOLDER_INDEX', 'No content for folder', { folderPath });
        continue;
      }

      const formatted = formatTimelineForClaudeMd(result.content[0].text);
      writeClaudeMdToFolder(folderPath, formatted);

      logger.debug('FOLDER_INDEX', 'Updated CLAUDE.md', { folderPath });
    } catch (error) {
      logger.warn('FOLDER_INDEX', 'Failed to update CLAUDE.md', { folderPath }, error as Error);
    }
  }
}
```

### Verification Checklist
- [ ] `updateFolderClaudeMdFiles` function added
- [ ] Takes only `filePaths`, `project`, `port` (no workspacePath)
- [ ] Extracts folder paths from absolute file paths
- [ ] Uses `writeClaudeMdToFolder` for atomic writes
- [ ] Build passes: `npm run build`

---

## Phase 3: Update ResponseProcessor Integration

### What to Implement

Simplify the call site in `src/services/worker/agents/ResponseProcessor.ts`.

### Current Code (lines 274-298)
```typescript
// Update folder CLAUDE.md files for touched folders (fire-and-forget)
const filesModified: string[] = [];
const filesRead: string[] = [];

for (const obs of observations) {
  filesModified.push(...(obs.files_modified || []));
  filesRead.push(...(obs.files_read || []));
}

// Get workspace path from project registry
const registry = readCursorRegistry();
const registryEntry = registry[session.project];

if (registryEntry && (filesModified.length > 0 || filesRead.length > 0)) {
  updateFolderClaudeMd(
    registryEntry.workspacePath,
    filesModified,
    filesRead,
    session.project,
    getWorkerPort()
  ).catch(error => {
    logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
  });
}
```

### New Code
```typescript
// Update folder CLAUDE.md files for touched folders (fire-and-forget)
const allFilePaths: string[] = [];
for (const obs of observations) {
  allFilePaths.push(...(obs.files_modified || []));
  allFilePaths.push(...(obs.files_read || []));
}

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

### Import Changes

**Remove:**
```typescript
import { updateFolderClaudeMd, readCursorRegistry } from '../../integrations/CursorHooksInstaller.js';
```

**Add:**
```typescript
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
```

**Keep (if still needed for Cursor context):**
```typescript
import { updateCursorContextForProject } from '../../worker-service.js';
```

### Verification Checklist
- [ ] Import updated to use `claude-md-utils.ts`
- [ ] `readCursorRegistry` import removed (if no longer needed)
- [ ] Call site simplified - no registry lookup
- [ ] Fire-and-forget pattern preserved
- [ ] Build passes: `npm run build`

---

## Phase 4: Clean Up CursorHooksInstaller

### What to Implement

Remove the extracted functions from `src/services/integrations/CursorHooksInstaller.ts`.

### Functions to Remove
- `updateFolderClaudeMd` (lines 128-199)
- `formatTimelineForClaudeMd` (lines 221-295)
- `replaceTaggedContent` (lines 300-321)
- `writeFolderClaudeMd` (lines 326-353)

### Verification Checklist
- [ ] All 4 functions removed from CursorHooksInstaller.ts
- [ ] No dangling references to removed functions
- [ ] CursorHooksInstaller still exports what it needs for Cursor integration
- [ ] Build passes: `npm run build`
- [ ] Grep shows no references to old function locations

---

## Phase 5: Verification

### Build Check
```bash
npm run build
```

### Anti-Pattern Grep (should find NOTHING in CursorHooksInstaller)
```bash
grep -n "updateFolderClaudeMd\|formatTimelineForClaudeMd\|replaceTaggedContent\|writeFolderClaudeMd" src/services/integrations/CursorHooksInstaller.ts
```

### Correct Location Grep (should find in claude-md-utils)
```bash
grep -rn "updateFolderClaudeMdFiles\|writeClaudeMdToFolder\|formatTimelineForClaudeMd" src/utils/
```

### Integration Check
```bash
grep -n "updateFolderClaudeMdFiles" src/services/worker/agents/ResponseProcessor.ts
```

### No Cursor Registry Dependency
```bash
grep -n "readCursorRegistry" src/services/worker/agents/ResponseProcessor.ts
# Should return nothing (or only for Cursor context, not folder index)
```

---

## Summary

**~150 lines moved** from CursorHooksInstaller.ts to claude-md-utils.ts with simplification:

| Before | After |
|--------|-------|
| 4 functions in CursorHooksInstaller | 4 functions in claude-md-utils |
| Requires Cursor registry lookup | Works with absolute paths directly |
| `updateFolderClaudeMd(workspacePath, ...)` | `updateFolderClaudeMdFiles(filePaths, ...)` |
| Coupled to Cursor integration | Independent utility |

**Files Changed:**
1. `src/utils/claude-md-utils.ts` - NEW (create)
2. `src/services/worker/agents/ResponseProcessor.ts` - UPDATE (simplify call site)
3. `src/services/integrations/CursorHooksInstaller.ts` - UPDATE (remove extracted functions)
