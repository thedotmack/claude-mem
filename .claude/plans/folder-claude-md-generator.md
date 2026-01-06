# Folder CLAUDE.md Generator

## CORE DIRECTIVE (NON-NEGOTIABLE)

**EXTEND THE EXISTING CURSOR RULES TIMELINE GENERATION SYSTEM TO ALSO WRITE CLAUDE.MD FILES**

- DO NOT create new services
- DO NOT create new orchestrators
- DO NOT create new HTTP routes
- DO NOT create new database query functions
- EXTEND existing functions to add folder-level output

---

## Approved Directives (From Planning Conversation)

### Trigger Mechanism
- Observation save triggers folder CLAUDE.md regeneration **INLINE**
- NO batching
- NO debouncing
- NO Set-based queuing
- NO session-end hook
- Synchronous: `observation.save()` → update folder CLAUDE.md files → done

### Tag Strategy
- Wrap ONLY auto-generated content with `<claude-mem-context>` tags
- Everything outside tags is untouched (user's manual content preserved)
- If tags are deleted, just regenerate them
- NO backup system
- NO manual content markers

### Git Behavior
- CLAUDE.md files SHOULD be committed (intentional)
- `<claude-mem-context>` tag is searchable fingerprint for GitHub analytics
- NO .gitignore for these files

### Phasing
- **Phase 1**: CLAUDE.md generation only (THIS PLAN)
- **Phase 2**: IDE symlinks (FUTURE)

### REJECTED
- Cross-folder linking — NO
- Semantic grouping — deferred enhancement only
- Team sync — future phase

### DEFERRED
- Priority weighting by observation type
- IDE-specific template refinements

---

## Phase 0: Documentation Discovery (COMPLETED)

### Existing APIs to USE (Not Rebuild)

| Function | Location | Purpose |
|----------|----------|---------|
| `findByFile(filePath, options)` | `src/services/sqlite/SessionSearch.ts:342` | Query observations by folder prefix (already supports LIKE wildcards) |
| `updateCursorContextForProject()` | `src/services/integrations/CursorHooksInstaller.ts:98` | Write context files after observation save |
| `writeContextFile()` | `src/utils/cursor-utils.ts:97` | Atomic file write with temp file + rename |
| `extractFirstFile()` | `src/shared/timeline-formatting.ts` | Extract file paths from JSON arrays |
| `groupByDate()` | `src/shared/timeline-formatting.ts` | Group items chronologically |
| `formatTime()`, `formatDate()` | `src/shared/timeline-formatting.ts` | Time formatting |

### Existing Integration Points

| Location | What Happens | Extension Point |
|----------|--------------|-----------------|
| `ResponseProcessor.ts:266` | Calls `updateCursorContextForProject()` after summary save | Add folder CLAUDE.md update here |
| `CursorHooksInstaller.ts:98` | `updateCursorContextForProject()` fetches context and writes file | Add sibling function for folder updates |

### Anti-Patterns to AVOID
- Creating `FolderIndexOrchestrator.ts` — NO
- Creating `FolderTimelineCompiler.ts` — NO
- Creating `FolderDiscovery.ts` — NO
- Creating `ClaudeMdGenerator.ts` — NO
- Creating `FolderIndexRoutes.ts` — NO
- Adding new HTTP endpoints — NO
- Adding new settings in `SettingsDefaultsManager.ts` — NO (use sensible defaults inline)

---

## Phase 1: Extend CursorHooksInstaller

### What to Implement

Add ONE new function to `src/services/integrations/CursorHooksInstaller.ts`:

```typescript
/**
 * Update CLAUDE.md files for folders touched by an observation.
 * Called inline after observation save, similar to updateCursorContextForProject.
 */
export async function updateFolderClaudeMd(
  workspacePath: string,
  filesModified: string[],
  filesRead: string[],
  project: string,
  port: number
): Promise<void>
```

### Implementation Pattern (Copy From)

Follow the EXACT pattern of `updateCursorContextForProject()` at line 98:
1. Extract unique folder paths from filesModified and filesRead
2. For each folder, fetch timeline via existing `/api/search/file?files=<folderPath>` endpoint
3. Format as simple timeline (reuse existing formatters)
4. Write to `<folder>/CLAUDE.md` preserving content outside `<claude-mem-context>` tags

### Tag Preservation Logic

```typescript
function replaceTaggedContent(existingContent: string, newContent: string): string {
  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  // If no existing content, wrap new content in tags
  if (!existingContent) {
    return `${startTag}\n${newContent}\n${endTag}`;
  }

  // If existing has tags, replace only tagged section
  const startIdx = existingContent.indexOf(startTag);
  const endIdx = existingContent.indexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1) {
    return existingContent.substring(0, startIdx) +
           `${startTag}\n${newContent}\n${endTag}` +
           existingContent.substring(endIdx + endTag.length);
  }

  // If no tags exist, append tagged content at end
  return existingContent + `\n\n${startTag}\n${newContent}\n${endTag}`;
}
```

### Verification Checklist
- [ ] Function added to CursorHooksInstaller.ts
- [ ] Uses existing `findByFile` endpoint (no new database queries)
- [ ] Preserves content outside `<claude-mem-context>` tags
- [ ] Atomic writes (temp file + rename)
- [ ] Build passes: `npm run build`

---

## Phase 2: Hook Into ResponseProcessor

### What to Implement

Add call to `updateFolderClaudeMd()` in `src/services/worker/agents/ResponseProcessor.ts`, right after the existing `updateCursorContextForProject()` call at line 266.

### Code Location

In `syncAndBroadcastSummary()` function, after line 269:

```typescript
// EXISTING: Update Cursor context file for registered projects (fire-and-forget)
updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
  logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
});

// NEW: Update folder CLAUDE.md files for touched folders (fire-and-forget)
// Extract file paths from the saved observations
updateFolderClaudeMd(
  workspacePath,  // From registry lookup
  filesModified,  // From observations
  filesRead,      // From observations
  session.project,
  getWorkerPort()
).catch(error => {
  logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
});
```

### Data Flow
1. `processAgentResponse()` saves observations → gets back `observationIds`
2. Fetch observation records to get `files_read` and `files_modified`
3. Pass to `updateFolderClaudeMd()`

### Verification Checklist
- [ ] Call added to ResponseProcessor.ts
- [ ] Fire-and-forget pattern (non-blocking, errors logged)
- [ ] Uses existing observation data (no new queries)
- [ ] Build passes: `npm run build`

---

## Phase 3: Timeline Formatting

### What to Implement

Create a minimal timeline formatter for CLAUDE.md output. This can be:
1. A simple function in CursorHooksInstaller.ts, OR
2. Reuse existing `ResultFormatter.formatSearchResults()` from `src/services/worker/search/ResultFormatter.ts`

### Output Format

```markdown
# Recent Activity

<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->
<claude-mem-context>

### 2026-01-04

| Time | Type | Title |
|------|------|-------|
| 4:30pm | feature | Added folder index support |
| 3:15pm | bugfix | Fixed file path handling |

### 2026-01-03

| Time | Type | Title |
|------|------|-------|
| 11:00am | refactor | Cleaned up cursor utils |

</claude-mem-context>
```

### Key Points
- Compact format (time, type emoji, title only)
- Grouped by date
- Limited to last N days or observations (sensible default: 10)
- NO token counts
- NO file columns (redundant - we're IN the folder)

### Verification Checklist
- [ ] Formatter produces clean markdown
- [ ] Output is concise (not verbose)
- [ ] Grouped by date
- [ ] Build passes: `npm run build`

---

## Phase 4: Verification

### Functional Tests

1. **Manual Test**:
   - Start worker: `npm run dev`
   - Create a test observation touching `src/services/sqlite/`
   - Verify `src/services/sqlite/CLAUDE.md` is created/updated
   - Verify `<claude-mem-context>` tags are present
   - Verify manual content outside tags is preserved

2. **Build Check**:
   ```bash
   npm run build
   ```

3. **Grep for Anti-Patterns**:
   ```bash
   # Should find NOTHING
   grep -r "FolderIndexOrchestrator" src/
   grep -r "FolderTimelineCompiler" src/
   grep -r "FolderDiscovery" src/
   grep -r "ClaudeMdGenerator" src/
   grep -r "FolderIndexRoutes" src/
   ```

4. **Grep for Correct Implementation**:
   ```bash
   # Should find the new function
   grep -r "updateFolderClaudeMd" src/
   ```

### Tag Preservation Test

1. Create `src/test-folder/CLAUDE.md` with manual content:
   ```markdown
   # My Notes
   This is manual content I wrote.
   ```

2. Trigger observation save touching files in `src/test-folder/`

3. Verify result:
   ```markdown
   # My Notes
   This is manual content I wrote.

   <claude-mem-context>
   ### 2026-01-04
   | Time | Type | Title |
   ...
   </claude-mem-context>
   ```

---

## Summary

This is a **~100 line change** spread across 2 files:
1. `CursorHooksInstaller.ts` — Add `updateFolderClaudeMd()` function (~60 lines)
2. `ResponseProcessor.ts` — Add call to the new function (~10 lines)

NO new files. NO new services. NO new routes. Just extending existing patterns.
