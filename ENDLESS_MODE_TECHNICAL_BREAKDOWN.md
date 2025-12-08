# Endless Mode Technical Breakdown

**Author**: Analysis for alex to evaluate what to keep/discard for reimplementation
**Date**: 2025-12-08
**Branch**: beta/7.0

## Executive Summary

Endless Mode compresses tool outputs in the Claude Code transcript file by replacing them with AI-compressed observations. This prevents context window overflow during long sessions.

**Core Concept**: When a tool executes → save-hook blocks → SDK compresses output → transcript file is modified to replace full output with compressed markdown → Claude resumes with smaller context.

---

## 1. Core Architecture Files

### 1.1 Configuration Layer

**File**: `src/services/worker/EndlessModeConfig.ts` (127 lines)

**Purpose**: Central configuration loader for all Endless Mode settings

**Settings Loaded**:
```typescript
{
  enabled: boolean;                      // Master switch (default: false)
  fallbackToOriginal: boolean;           // Use original output on errors (default: true)
  maxLookupTime: number;                 // Timeout for observation lookup (default: 500ms)
  keepRecentToolUses: number;            // How many recent tools to skip (default: 0)
  maxToolHistoryMB: number;              // Backup file size limit (default: 50MB)
  enableSynchronousMode: boolean;        // Block hooks waiting for compression (default: same as enabled)
}
```

**Priority**: `settings.json > environment variables > defaults`

**Called by**:
- `src/hooks/new-hook.ts` - To check if transformation enabled
- `src/services/worker/SessionManager.ts` - For sync mode behavior
- Anywhere Endless Mode behavior needs to be checked

**Dependencies**: None (reads settings file directly)

**Keep/Discard Decision Points**:
- Config structure is clean and follows existing patterns
- Settings names could be simplified if you change the approach
- The sync/async mode toggle might not be needed in your redesign

---

### 1.2 Transcript Transformation

**File**: `src/services/transcript-transformer.ts` (348 lines)

**Purpose**: Core class that rewrites transcript JSONL files

**Two Main Classes**:

#### TranscriptTransformer
- Reads transcript file (JSONL format)
- Queries database for observations matching tool_use_id
- Concatenates ALL observations for a tool_use_id
- Replaces tool_use input with compressed observation references
- Writes back to file atomically (temp file + rename)

**Key Method**: `transform(toolUseId: string, outputPath?: string): Promise<TransformStats>`

**Process**:
```
1. Query DB: getAllObservationsForToolUseId(toolUseId)
2. Read transcript JSONL
3. Find assistant message with tool_use matching ID
4. Replace item.input with observation references
5. Atomic write (temp file → validate → rename)
```

**Observation Format**:
```typescript
{
  _observation_refs: [obs.id, obs.id, ...],
  _observation_count: number,
  _note: "Original input compressed - N observation(s) for details"
}
```

#### TranscriptBackupManager
- Creates timestamped backups before transformation
- Manages backup directory
- Trims backups to size limit

**Called by**:
- `src/hooks/new-hook.ts` - Batch transforms at UserPromptSubmit
- Restore script - To reverse transformations

**Dependencies**:
- `SessionStore.getAllObservationsForToolUseId()` - NEW database method
- `tool-output-backup.ts` - For original output storage
- `paths.ts` - Backup directory management

**Keep/Discard Decision Points**:
- **Core logic is sound** but operates on the WRONG place (tool_use.input)
  - Current: Replaces tool_use.input (what Claude SENT to the tool)
  - Should be: Replace tool_result.content (what the tool RETURNED)
- Atomic write pattern is good, keep it
- formatObservationAsMarkdown() could be useful
- Backup manager might not be needed if you take a different approach

---

### 1.3 Tool Output Backup System

**File**: `src/shared/tool-output-backup.ts` (186 lines)

**Purpose**: Rolling backup of original tool outputs for restoration

**Data Structure**:
```typescript
interface ToolOutputBackupEntry {
  tool_use_id: string;
  content: string | Array<Record<string, any>>;  // Original tool output
  timestamp: number;
  size_bytes: number;
}
```

**Storage**: `~/.claude-mem/backups/tool-outputs.jsonl` (append-only JSONL)

**Key Functions**:

1. `appendToolOutput(toolUseId, content, timestamp)` - Add to backup
2. `lookupToolOutput(toolUseId)` - Retrieve original output
3. `trimBackupFile(maxSizeMB)` - Remove oldest entries when over limit
4. `getBackupInfo()` - Diagnostics (size, count, age range)

**Trimming Strategy**: Keep newest entries until under size limit

**Called by**:
- `save-hook.ts` - Backs up original output before compression
- `restore-endless-mode.ts` - Restores from backup
- `TranscriptBackupManager` - Trim operations

**Dependencies**: None (pure file I/O)

**Keep/Discard Decision Points**:
- **Useful if you want reversibility** (disable Endless Mode → restore originals)
- **Not needed if you trust compression** or use a different storage model
- Rolling backup with size limit is smart
- Linear search backwards is fine for small-ish datasets

---

### 1.4 Restoration CLI Tool

**File**: `src/bin/restore-endless-mode.ts` (206 lines)

**Purpose**: CLI tool to restore compressed transcripts to original state

**Usage**:
```bash
npm run endless-mode:restore <transcript-path>
npm run endless-mode:restore -- --info
```

**Process**:
1. Read compressed transcript
2. Find all tool_result entries
3. Look up original output from backup file
4. Replace compressed content with original
5. Write restored transcript

**Handles**:
- Multi-observation tool uses (strips `__1`, `__2` suffixes from tool_use_id)
- Missing backups (warns but continues)
- Malformed JSONL (skips bad lines)

**Called by**: User via npm script

**Dependencies**:
- `tool-output-backup.ts` - Backup file lookup

**Keep/Discard Decision Points**:
- **Only needed if you implement backup system**
- Good for safety/experimentation phase
- Could be simplified or removed if you commit to compression approach

---

## 2. Hook Integration Points

### 2.1 UserPromptSubmit Hook

**File**: `src/hooks/new-hook.ts`

**Changes** (lines 91-118 added):
```typescript
// Transform transcript BEFORE processing new prompt
const config = EndlessModeConfig.getConfig();
if (config.enabled && transcript_path) {
  try {
    logger.info('HOOK', '🔄 Batch transforming transcript at UserPromptSubmit');
    const stats = await transformTranscriptWithAgents(transcript_path, `user-prompt-${promptNumber}`);
    logger.success('HOOK', '✅ Batch transformation complete', { ... });
  } catch (error) {
    logger.warn('HOOK', 'Batch transformation failed - continuing anyway');
  }
}
```

**Purpose**: Batch compress all pending tool outputs before user submits next prompt

**Behavior**:
- Checks if Endless Mode enabled
- If yes, calls `transformTranscriptWithAgents()` from save-hook
- Non-blocking: failure doesn't block the hook
- Logs success/failure

**Called by**: Claude Code when user submits prompt #2, #3, etc.

**Dependencies**:
- `EndlessModeConfig` - Check if enabled
- `save-hook.transformTranscriptWithAgents()` - Do the work

**Keep/Discard Decision Points**:
- **Good hook point for batch operations**
- **Bad timing if you want real-time compression** (Claude already saw full outputs)
- Consider moving to PostToolUse hook instead?

---

### 2.2 PostToolUse Hook (save-hook)

**File**: `src/hooks/save-hook.ts`

**Note**: I don't see the diff for save-hook changes - let me check if it exists

---

### 2.3 SessionManager Changes

**File**: `src/services/worker/SessionManager.ts`

**Changes**:
- Added fields to ActiveSession:
  ```typescript
  currentToolUseId: string | null;
  pendingObservationResolvers: Map<string, (obs: Observation) => void>;
  lastObservationToolUseId: string | null;
  toolUsesInCurrentCycle: string[];
  ```
- New method: `queueContinuation()` - For prompt #2+ in same session
- Changed `silentDebug()` calls to `happy_path_error__with_fallback()`

**Purpose**: Track tool use IDs for correlation with observations

**Keep/Discard Decision Points**:
- **Session state tracking is good**
- Resolver pattern for async observation creation is clean
- Could simplify if you change compression timing

---

## 3. Supporting Infrastructure

### 3.1 Database Schema Changes

**File**: `src/services/sqlite/SessionStore.ts`

**New Method** (inferred, need to verify):
```typescript
getAllObservationsForToolUseId(toolUseId: string): Observation[]
```

**Purpose**: Query all observations for a specific tool use (handles multi-observation responses)

**Keep/Discard Decision Points**:
- **Essential if using observation-based compression**
- Simple query, low complexity

---

### 3.2 Tool Skipping Logic

**File**: `src/shared/skip-tools.ts` (12 lines)

**Purpose**: Define which tools NEVER get compressed

**List**:
```typescript
SKIP_TOOLS = [
  'ListMcpResourcesTool',  // MCP infrastructure
  'SlashCommand',          // Command wrapper
  'Skill',                 // Skill wrapper
  'TodoWrite',             // Task management
  'AskUserQuestion'        // User interaction
]
```

**Rationale**: Meta-tools that don't produce compressible work

**Keep/Discard Decision Points**:
- **Good concept** - not all tools need compression
- List might need adjustment for your approach
- Consider making configurable?

---

### 3.3 Utility Changes

**File**: `src/utils/silent-debug.ts`

**Changes**: Added `happy_path_error__with_fallback()` function

**Purpose**: Unclear - seems like a debug/error logging helper

**Keep/Discard Decision Points**:
- **Investigate what this does** before deciding
- Naming is confusing

---

**File**: `src/shared/paths.ts`

**Changes**: Added backup directory paths

**Keep/Discard Decision Points**:
- Keep if using backup system
- Remove if not

---

**File**: `src/services/sqlite/Database.ts`

**Changes**: Minor (need to review diff)

---

**File**: `src/services/sqlite/types.ts`

**Changes**: Added types for tool_use_id tracking?

---

## 4. UI/Viewer Changes

### 4.1 Transcript Viewer

**File**: `src/ui/transcript-viewer.html` (614 lines) - NEW FILE

**Purpose**: Standalone HTML viewer for transcript files

**Keep/Discard Decision Points**:
- **Nice-to-have for debugging**
- Not core to compression functionality
- Could be useful for visualizing before/after

---

### 4.2 Main Viewer Updates

**Files**:
- `src/ui/viewer-template.html` - Minor updates
- `src/ui/viewer/components/Feed.tsx` - Minor
- `src/ui/viewer/components/ObservationCard.tsx` - Minor
- `src/ui/viewer/constants/settings.ts` - Settings UI

**Keep/Discard Decision Points**:
- Review diffs to see if needed
- Likely just UI polish

---

## 5. Scripts & Tooling

**Multiple analysis/testing scripts** (not core functionality):
- `scripts/analyze-tool-use-records.js` (348 lines)
- `scripts/analyze-transcript-schema.js` (37 lines)
- `scripts/analyze-transcript-size.js` (115 lines)
- `scripts/endless-mode-metrics.js` (298 lines)
- `scripts/endless-mode-token-calculator.js` (344 lines)
- `scripts/test-defensive-fallbacks.js` (60 lines)
- `scripts/test-endless-mode-toggle.sh` (97 lines)
- `scripts/test-transformation.ts` (221 lines)
- `scripts/transform-transcript.js` (43 lines)
- `scripts/validate-endless-mode-behavior.sh` (135 lines)

**Purpose**: Development, testing, metrics

**Keep/Discard Decision Points**:
- **Discard most** - nice for their development, but not needed for yours
- **Keep metrics script** if you want to measure compression ratios
- **Keep transform-transcript.js** if it's a useful standalone tool

---

## 6. Call Chain & Data Flow

### Current Flow (as implemented in beta/7.0):

```
┌─────────────────────────────────────────────────────────────┐
│ 1. USER SUBMITS PROMPT #1                                   │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Claude executes tools (Read, Bash, etc.)                 │
│    • Tools write full outputs to transcript                 │
│    • Claude sees full outputs in context                    │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. PostToolUse (save-hook) fires after each tool            │
│    • Creates observation via SDK Agent                      │
│    • Backs up original output to tool-outputs.jsonl        │
│    • Stores observation in database                         │
│    • Does NOT transform transcript yet                      │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. USER SUBMITS PROMPT #2                                   │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. UserPromptSubmit (new-hook) fires                        │
│    • Checks EndlessModeConfig.enabled                       │
│    • Calls transformTranscriptWithAgents()                  │
│      - Queries DB for all observations                      │
│      - Reads transcript file                                │
│      - Replaces tool_use.input with observation refs       │
│      - Writes modified transcript                           │
│    • Continues normal hook processing                       │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Claude reads transcript for context                      │
│    • Sees compressed tool_use.input (observation refs)     │
│    • Still sees full tool_result.content (NOT compressed!) │
│    • Context window still fills up!                         │
└─────────────────────────────────────────────────────────────┘
```

### THE CRITICAL BUG:

**Current implementation compresses the WRONG field!**

- Compresses: `tool_use.input` (what Claude sent TO the tool)
- Should compress: `tool_result.content` (what the tool RETURNED)

**Why this matters**:
- tool_use.input is usually tiny (file path, command, etc.)
- tool_result.content is HUGE (file contents, command output, etc.)
- Compressing input saves almost nothing
- Tool outputs still bloat the context window

**Example**:
```json
// Before compression
{
  "type": "tool_use",
  "id": "toolu_123",
  "input": { "file_path": "/path/to/large-file.js" }  // ~50 chars
}
// Later in transcript...
{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": "... 50,000 lines of code ..."  // HUGE! This needs compression!
}

// Current (broken) compression
{
  "type": "tool_use",
  "id": "toolu_123",
  "input": { "_observation_refs": [...] }  // Saved ~50 chars, useless!
}
// tool_result still has full 50k lines!

// Correct compression should be
{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": { "_observation_refs": [...] }  // This is what matters!
}
```

---

## 7. What to Keep vs Discard

### KEEP (Good Architecture)

1. **EndlessModeConfig.ts** - Clean config pattern
   - Modify: Simplify settings for your approach

2. **Atomic file write pattern** from TranscriptTransformer
   - temp file → validate → rename
   - Prevents corruption

3. **skip-tools.ts concept** - Not all tools need compression
   - Modify: Adjust list for your needs

4. **Database correlation** - Link observations to tool_use_ids
   - Keep if using observation-based approach

5. **Backup system concept** (if you want reversibility)
   - tool-output-backup.ts
   - restore-endless-mode.ts
   - Decision: Do you need to undo compression?

### DISCARD (Wrong Approach / Not Needed)

1. **Current TranscriptTransformer logic** - Compresses wrong field!
   - Rewrite to compress tool_result.content, not tool_use.input

2. **Batch transformation timing** - Too late!
   - Current: Transforms at UserPromptSubmit (after Claude saw full outputs)
   - Better: Transform immediately after tool execution

3. **Most analysis scripts** - Dev tools, not core functionality
   - Keep metrics script if useful

4. **SessionManager complexity** - If you simplify approach
   - pendingObservationResolvers map might not be needed

5. **Synchronous mode toggle** - Overly complex
   - Either block or don't, no need for config

6. **TranscriptBackupManager** - Redundant with tool-output-backup
   - Consolidate or remove

### REWRITE (Good Idea, Wrong Implementation)

1. **Core compression logic**
   - Keep: Concept of replacing full outputs with observations
   - Fix: Compress tool_result.content, not tool_use.input
   - Fix: Do it immediately, not in batch later

2. **Hook timing**
   - Current: UserPromptSubmit (too late)
   - Better: PostToolUse (right after tool execution)
   - Or: Custom hook between tool execution and returning to Claude

---

## 8. Key Questions for Your Redesign

1. **When to compress?**
   - Real-time after each tool? (Better UX, more complex)
   - Batch at prompt submit? (Simpler, but Claude sees full outputs first)

2. **What to compress?**
   - All tool outputs?
   - Only large outputs (>N tokens)?
   - Only specific tool types?

3. **Reversibility?**
   - Keep backup system for restore capability?
   - Or commit to compression being permanent?

4. **Storage model?**
   - Modify transcript file (current approach)?
   - Separate compressed/original transcripts?
   - Hybrid with pointer system?

5. **Error handling?**
   - Fallback to original on compression failure?
   - Block tool execution until compressed?
   - Async compress with eventual consistency?

6. **Multi-observation responses?**
   - Keep current approach (concatenate all observations)?
   - Show only most relevant observation?
   - User-configurable?

---

## 9. Recommended Rewrite Approach

Based on the code analysis, here's a suggested path:

### Phase 1: Fix Core Compression
```typescript
// In save-hook.ts (PostToolUse)
async function compressToolResult(
  transcriptPath: string,
  toolUseId: string,
  observations: Observation[]
): Promise<void> {
  // 1. Read transcript
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n');

  // 2. Find tool_result with matching tool_use_id
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const item of entry.message.content) {
        if (item.type === 'tool_result' && item.tool_use_id === toolUseId) {
          // 3. Replace content with observation markdown
          item.content = formatObservationsAsMarkdown(observations);
          lines[i] = JSON.stringify(entry);
        }
      }
    }
  }

  // 4. Atomic write
  atomicWrite(transcriptPath, lines.join('\n'));
}
```

### Phase 2: Immediate Compression
- Call `compressToolResult()` at end of save-hook
- Before hook returns, transcript is already compressed
- Claude never sees full output (only compressed version)

### Phase 3: Simplify Config
```typescript
{
  enabled: boolean;              // Master switch
  compressThreshold: number;     // Only compress if >N tokens
  skipTools: string[];           // Tools to never compress
}
```

### Phase 4: Optional Backup
- If you want reversibility, keep backup system
- Otherwise remove it entirely

---

## 10. File-by-File Verdict

| File | Verdict | Reason |
|------|---------|--------|
| `EndlessModeConfig.ts` | **Keep + Modify** | Good config pattern, simplify settings |
| `transcript-transformer.ts` | **Rewrite** | Core logic wrong (compresses input not output) |
| `tool-output-backup.ts` | **Optional** | Only if you want restore capability |
| `restore-endless-mode.ts` | **Optional** | Only if keeping backup system |
| `new-hook.ts` changes | **Discard** | Wrong timing (too late) |
| `save-hook.ts` changes | **Need to see** | Should be main compression point |
| `SessionManager.ts` changes | **Review** | Might be over-complex |
| `skip-tools.ts` | **Keep** | Good concept |
| All `/scripts/*` | **Discard** | Dev tools, not needed |
| UI changes | **Review** | Might be useful for debugging |
| Database changes | **Keep** | If using observation correlation |

---

## Summary

**Total Changes**: 68 files, +16,818 lines

**Core Functionality**: ~1,500 lines of actual compression logic

**Documentation**: ~10,000 lines

**Scripts/Tooling**: ~3,000 lines

**Critical Bug**: Compresses tool_use.input instead of tool_result.content

**Recommended Action**: Cherry-pick good patterns (config, atomic write, skip-tools), rewrite core compression logic with correct field targeting and better timing.
