# Plan: Change Folder CLAUDE.md to Timeline Format

## Goal

Replace the simple table format in folder-level CLAUDE.md files with the timeline format used by search results.

## Current vs Target Format

### Current Format (Simple)
```markdown
# Recent Activity

### Recent

| Time | Type | Title |
|------|------|-------|
| 6:33pm | feature | Multiple CLAUDE.md files generated |
| 6:32pm | feature | CLAUDE.md file successfully generated |
```

### Target Format (Timeline)
```markdown
# Recent Activity

### Jan 4, 2026

**src/services/worker/agents/ResponseProcessor.ts**
| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #37110 | 6:35 PM | 🔴 | Folder CLAUDE.md updates moved from summary | ~85 |
| #37109 | " | ✅ | ResponseProcessor.ts modified | ~92 |

**General**
| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #37108 | 6:33 PM | 🟣 | Multiple CLAUDE.md files generated | ~78 |
```

## Key Changes

1. **Group by date** - Use `### Jan 4, 2026` instead of `### Recent`
2. **Group by file within each date** - Add `**filename**` headers
3. **Expand columns** - Add ID and Read columns: `| ID | Time | T | Title | Read |`
4. **Use type emojis** - Use `🔴` `🟣` `✅` etc. instead of text
5. **Show ditto marks** - Use `"` for repeated times

---

## Phase 1: Refactor formatTimelineForClaudeMd

**File:** `src/utils/claude-md-utils.ts`

**Tasks:**

1. Add imports from shared utilities:
   ```typescript
   import { formatDate, formatTime, extractFirstFile, estimateTokens, groupByDate } from '../shared/timeline-formatting.js';
   import { ModeManager } from '../services/domain/ModeManager.js';
   ```

2. Replace `formatTimelineForClaudeMd()` (lines 78-151) with new implementation that:
   - Parses API response to extract full observation data (id, time, type emoji, title, files)
   - Groups observations by date using `groupByDate()`
   - Within each date, groups by file using a Map
   - Renders file sections with `**filename**` headers
   - Uses search table format: `| ID | Time | T | Title | Read |`
   - Uses ditto marks for repeated times

**Pattern to Copy From:** `src/services/worker/search/ResultFormatter.ts` lines 56-108

**Key APIs:**
- `groupByDate(items, getDate)` - from `src/shared/timeline-formatting.ts:104-127`
- `formatTime(epoch)` - from `src/shared/timeline-formatting.ts:46-53`
- `formatDate(epoch)` - from `src/shared/timeline-formatting.ts:59-66`
- `extractFirstFile(filesModified, cwd)` - from `src/shared/timeline-formatting.ts:81-84`
- `estimateTokens(text)` - from `src/shared/timeline-formatting.ts:89-92`
- `ModeManager.getInstance().getTypeIcon(type)` - from `src/services/domain/ModeManager.ts`

**Verification:**
1. Run `npm run build` - no errors
2. Restart worker: `npm run worker:restart`
3. Make a test edit to trigger observation
4. Check generated CLAUDE.md files for new format

---

## Phase 2: Parse Full Observation Data from API

**Context:** The current regex parsing extracts only time, type emoji, and title. Need to also extract:
- Observation ID (for `#123` column)
- File path (from files_modified in API response, for grouping)
- Token estimate (for `Read` column)

**Challenge:** The current API returns formatted text, not structured data. We need to:
1. Parse the existing text format more thoroughly, OR
2. Use a different API endpoint that returns JSON

**Decision Point:** Check what data the `/api/search/by-file` endpoint returns. If it returns structured JSON with observations, use that. Otherwise, enhance parsing.

**Investigation Required:**
- Read `src/services/worker/http/routes/SearchRoutes.ts` to see by-file response format
- Determine if we can access raw observation data or just formatted text

**Verification:**
- Confirm API response structure
- Update parsing to extract all needed fields

---

## Phase 3: Integrate File-Based Grouping

**File:** `src/utils/claude-md-utils.ts`

**Tasks:**

1. Create helper to group by file:
   ```typescript
   function groupByFile(observations: ParsedObservation[]): Map<string, ParsedObservation[]> {
     const byFile = new Map<string, ParsedObservation[]>();
     for (const obs of observations) {
       const file = obs.file || 'General';
       if (!byFile.has(file)) byFile.set(file, []);
       byFile.get(file)!.push(obs);
     }
     return byFile;
   }
   ```

2. Render with file sections:
   ```typescript
   for (const [file, fileObs] of resultsByFile) {
     lines.push(`**${file}**`);
     lines.push(`| ID | Time | T | Title | Read |`);
     lines.push(`|----|------|---|-------|------|`);
     // render rows with ditto marks
   }
   ```

**Pattern to Copy From:** `ResultFormatter.formatSearchResults()` lines 60-108

**Verification:**
- Generated CLAUDE.md shows file grouping
- Files are displayed as relative paths when possible

---

## Phase 4: Final Verification

**Checklist:**

1. **Build passes:** `npm run build`
2. **Worker restarts cleanly:** `npm run worker:restart`
3. **Format matches target:**
   - Date headers: `### Jan 4, 2026`
   - File sections: `**filename**`
   - Table columns: `| ID | Time | T | Title | Read |`
   - Type emojis: `🔴` `🟣` `✅` not text
   - Ditto marks: `"` for repeated times
4. **Anti-pattern checks:**
   - No hardcoded type maps (use ModeManager)
   - No invented APIs
   - Reuses existing formatters from shared utils
5. **Graceful degradation:** Empty results still show `*No recent activity*`

---

## Files to Modify

| File | Change |
|------|--------|
| `src/utils/claude-md-utils.ts` | Replace `formatTimelineForClaudeMd()` with timeline format |

## Files to Read (Patterns to Copy)

| File | Pattern |
|------|---------|
| `src/services/worker/search/ResultFormatter.ts:56-108` | Date/file grouping logic |
| `src/shared/timeline-formatting.ts` | All formatting utilities |
| `src/services/domain/ModeManager.ts` | Type icon lookup |

## Anti-Patterns to Avoid

- ❌ Creating new hardcoded type→emoji maps (use ModeManager)
- ❌ Parsing dates manually (use shared formatters)
- ❌ Skipping the existing groupByDate utility
- ❌ Not handling ditto marks for repeated times
