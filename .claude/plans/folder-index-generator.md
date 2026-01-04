# Folder Index Generator: Auto-Generated CLAUDE.md with IDE Symlinks

## Overview

This feature automatically generates and maintains folder-level CLAUDE.md files containing filtered timelines of observations. IDE symlinks (Cursor, Copilot, Windsurf, Cline, AGENTS.md) provide cross-tool compatibility.

**Trigger**: Observation save (event-driven, inline)
**Content**: Timeline of observations filtered by folder's files
**Tag Strategy**: `<claude-mem-context>` wraps auto-generated content only
**IDE Support**: All major tools via symlinks (Phase 2)
**Analytics**: Git-committed indexes enable public usage analysis via GitHub search

### Release Strategy

Each phase is an independently releasable feature. Evaluate adoption and user feedback between phases before proceeding to the next:

- **Phase 1**: Core CLAUDE.md generation → Ship, evaluate
- **Phase 2**: IDE symlinks → Ship if Phase 1 shows demand for cross-tool support
- **Phase 3**: Root CLAUDE.md integration → Ship if users want centralized context

This incremental approach validates value at each step before adding complexity.

---

## Architecture: Event-Driven Regeneration

Unlike batch processing at session end, folder indexes regenerate **inline** when observations are saved:

```typescript
await observation.save()
await regenerateFolderIndexes(observation.files)
```

**Why this works:**
- Observations are infrequent (handful per session)
- No batching infrastructure needed
- Folder context stays current during the session
- Zero latency at session end
- IDEs watching rule files get live context updates

**Live Context Flow:**
1. Developer edits `src/services/sqlite/foo.ts`
2. Observation saves
3. `src/services/sqlite/CLAUDE.md` regenerates
4. Cursor/Copilot/Windsurf detects file change, reloads context
5. AI suggestions now reflect what was just learned about that folder

Claude-Mem becomes the context backbone; IDEs are downstream consumers.

### Why Circular Regeneration Isn't a Concern

The observation pipeline is architecturally isolated:

- **Observer agent**: Read-only, no tool access, cannot see file writes
- **Primary agent**: Does work, generates observations as side-effect
- **Selective observation**: Only specific prompts/tools/messages get observed

Folder CLAUDE.md regeneration is internal housekeeping—the observer never sees these writes, so no feedback loop occurs. The `<claude-mem-context>` tag stripping at the hook layer provides additional protection.

### Fully Automated Maintenance

Generated CLAUDE.md files require zero manual maintenance:

- Auto-generated on observation save
- Auto-updated when new observations arrive
- Tag isolation preserves any manual content

Users make a one-time decision: **commit** (enables analytics, collaborator context) or **gitignore** (local-only, cleaner diffs). No ongoing work required.

---

## Phase 0: Documentation Discovery

### Existing APIs and Patterns

**Timeline/Search APIs** (from `src/services/sqlite/`):
- `getTimelineAroundObservation()` - Get context around observation ID
- `findByFile(filePath)` - Find observations by file path (supports wildcards)
- `searchObservations(query, options)` - Full search with filters

**Filter Capabilities** (from `src/services/sqlite/SessionSearch.ts`):
```typescript
interface SearchOptions {
  project?: string;
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  files?: string | string[];  // Supports partial path matching via LIKE
  dateRange?: { start?: string; end?: string; };
  limit?: number;
  orderBy?: 'relevance' | 'date_desc' | 'date_asc';
}
```

**File Path Matching** (line 203-218 of SessionSearch.ts):
- Uses `LIKE '%path%'` for partial matching
- Searches both `files_read` and `files_modified` JSON arrays

**Existing Cursor Rules Infrastructure:**
- Already writes to Cursor rules files
- Can leverage existing patterns for folder index generation
- Cursor rules support auto-load options (already in use for timeline)

**IDE Rule File Conventions**:
| Tool | File Path | Format |
|------|-----------|--------|
| Cursor | `.cursor/rules/*.mdc` or `.cursorrules` | Markdown + YAML frontmatter |
| Copilot | `.github/copilot-instructions.md` | Markdown + YAML frontmatter |
| Windsurf | `.windsurf/rules/rules.md` | Markdown |
| Cline | `.clinerules` or `.clinerules/*.md` | Markdown |
| AGENTS.md | `AGENTS.md` | Plain Markdown |
| Claude Code | `CLAUDE.md` | Plain Markdown |

**Anti-Patterns to Avoid**:
- Don't invent new database fields - use existing `files_read`/`files_modified`
- Don't create new hooks - extend existing observation save flow
- Don't modify core CLAUDE.md format - use clearly marked `<claude-mem-context>` tags

---

## Phase 1: Core CLAUDE.md Generation

**Goal**: Generate folder-level CLAUDE.md files on observation save.

### 1.1 Folder Discovery Service

**Create `src/services/folder-index/FolderDiscovery.ts`**

```typescript
// Extract unique parent folders from observation files
function extractFoldersFromObservation(observation: Observation): string[] {
  const allFiles = [
    ...(observation.files_read || []),
    ...(observation.files_modified || [])
  ];

  const folders = new Set<string>();
  for (const file of allFiles) {
    const parentFolder = path.dirname(file);
    folders.add(parentFolder);
  }

  return [...folders];
}
```

**Add folder depth configuration** to `src/services/settings/SettingsDefaultsManager.ts`:
```typescript
folderIndex: {
  enabled: boolean;
  maxDepth: number;  // e.g., 3 = src/services/sqlite but not deeper
  excludeFolders: string[];  // e.g., ['node_modules', '.git', 'dist']
  minActivityThreshold: number;  // Min observations to create CLAUDE.md
}
```

### 1.2 Folder Timeline Compiler

**Create `src/services/folder-index/FolderTimelineCompiler.ts`**

- Copy pattern from `src/services/context/ObservationCompiler.ts`
- Use existing `findByFile()` with folder path as filter
- Format using existing `MarkdownFormatter` patterns

```typescript
interface FolderTimelineContent {
  folderPath: string;
  lastUpdated: string;  // ISO timestamp
  observationCount: number;
  timeline: Array<{
    date: string;
    observations: Array<{
      type: string;
      title: string;
      files: string[];
      summary: string;
    }>;
  }>;
}

async function compileTimeline(project: string, folderPath: string): Promise<FolderTimelineContent>
```

### 1.3 CLAUDE.md Generator

**Create `src/services/folder-index/ClaudeMdGenerator.ts`**

**Tag Strategy**: Wrap only auto-generated content with `<claude-mem-context>`. Everything outside the tags is untouched.

```markdown
# [FolderName]

Any manual content here is completely safe.
Claude-Mem never touches content outside its tags.

## My Notes
- Whatever the developer writes stays here

<claude-mem-context>
## Recent Activity Timeline

Last updated: {timestamp}

### {date}
- **{type}**: {title}
  - Files: {files}
  - {summary}

</claude-mem-context>

More manual content can go here too.
```

**Regeneration Logic**:
1. Read existing CLAUDE.md if present
2. Find `<claude-mem-context>` tags
3. Replace content between tags (or append tags if missing)
4. All content outside tags is preserved automatically

**Why this approach**:
- If tags are accidentally deleted → just regenerate them
- Manual content is untouchable by default
- No backup system needed
- Simple string replacement

### 1.4 Event-Driven Integration

**Extend observation save flow:**

```typescript
// In observation save handler
async function saveObservation(observation: Observation) {
  await db.insert(observation);

  if (settings.folderIndex.enabled) {
    const folders = extractFoldersFromObservation(observation);
    for (const folder of folders) {
      await regenerateFolderIndex(observation.project, folder);
    }
  }
}

async function regenerateFolderIndex(project: string, folderPath: string) {
  const timeline = await compileTimeline(project, folderPath);
  await writeClaudeMd(folderPath, timeline);
}
```

### 1.5 HTTP Endpoints

Add to `src/services/worker/http/routes/`:

```
GET  /api/folders/discover?project={project}
GET  /api/folders/:folderPath/timeline?project={project}
POST /api/folders/:folderPath/generate-claude-md?project={project}
```

### 1.6 Verification

```bash
# Discover active folders
curl "http://localhost:37777/api/folders/discover?project=claude-mem"

# Get timeline for a folder
curl "http://localhost:37777/api/folders/src%2Fservices/timeline?project=claude-mem"

# Manually trigger generation
curl -X POST "http://localhost:37777/api/folders/src%2Fservices/generate-claude-md?project=claude-mem"

# Verify files exist
find . -name "CLAUDE.md" -type f

# Verify tag structure
grep -l "claude-mem-context" $(find . -name "CLAUDE.md")
```

---

## Phase 2: IDE Symlink Manager

**Goal**: Create and maintain symlinks from IDE rule files to CLAUDE.md.

### 2.1 Symlink Manager Service

**Create `src/services/folder-index/IdeSymlinkManager.ts`**

```typescript
const IDE_SYMLINKS = {
  cursor: {
    legacy: '.cursorrules',
    modern: '.cursor/rules/claude-mem.mdc'
  },
  copilot: '.github/copilot-instructions.md',
  windsurf: '.windsurf/rules/claude-mem.md',
  cline: '.clinerules/claude-mem.md',
  agents: 'AGENTS.md'
};
```

**Leverage existing Cursor rules infrastructure** — the codebase already writes to Cursor rules files with auto-load options.

### 2.2 Symlink Creation Logic

```typescript
async function createSymlink(target: string, linkPath: string) {
  // Check if target exists
  if (!await exists(linkPath)) {
    await symlink(target, linkPath);
    return 'created';
  }

  // If exists and is symlink pointing to our target, skip
  if (await isSymlinkTo(linkPath, target)) {
    return 'unchanged';
  }

  // If exists and is regular file, warn (don't overwrite)
  if (await isRegularFile(linkPath)) {
    console.warn(`${linkPath} exists as regular file, skipping`);
    return 'skipped';
  }
}
```

### 2.3 Special Cases

**Cursor .mdc format** — Requires YAML frontmatter, create copy not symlink:
```yaml
---
description: "Auto-generated from claude-mem observations"
alwaysApply: true
globs: ["src/services/**/*.ts"]  # Auto-generated from observation file patterns
---
```

**Copilot** — Must be in `.github/` folder

**Root-level only** — IDE symlinks at project root only; folder-level CLAUDE.md files are discovered naturally by IDEs

### 2.4 Windows Compatibility

Windows symlinks require admin privileges or Developer Mode. Implement fallback:
- Detect Windows
- If symlink fails, create file copy with header comment:
  ```markdown
  <!-- Generated by claude-mem. Source: CLAUDE.md -->
  ```
- Log warning about enabling Developer Mode for proper symlinks

### 2.5 Configuration

```typescript
folderIndex: {
  // ... existing settings
  ideSymlinks: {
    cursor: true,
    copilot: true,
    windsurf: true,
    cline: true,
    agents: true
  }
}
```

### 2.6 Verification

```bash
# Verify symlinks
ls -la .cursorrules AGENTS.md .github/copilot-instructions.md 2>/dev/null
file .cursorrules AGENTS.md  # Should show "symbolic link"

# Verify targets
readlink .cursorrules  # Should show CLAUDE.md
```

---

## Phase 3: Root CLAUDE.md Integration

**Goal**: Update root CLAUDE.md with folder index and aggregate timeline.

### Why This Isn't Invasive

Root CLAUDE.md modification is opt-in and clearly isolated:

- **Tag-wrapped**: All auto-generated content lives inside `<claude-mem-context>` tags
- **Configurable**: Users can enable/disable via settings
- **Non-duplicative**: If CLAUDE.md has the context, startup injection skips it
- **Hot-updating benefit**: IDEs watching the file get live context refreshes without session restart

This provides an alternate location for context with the added benefit of real-time updates during development. Users who prefer startup injection can disable folder index integration entirely.

### 3.1 Root CLAUDE.md Structure

```markdown
# Project Name

[All existing manual content preserved]

<claude-mem-context>
## Folder Documentation

- [src/services/CLAUDE.md](src/services/CLAUDE.md) - 15 observations
- [src/hooks/CLAUDE.md](src/hooks/CLAUDE.md) - 8 observations
- [src/ui/viewer/CLAUDE.md](src/ui/viewer/CLAUDE.md) - 5 observations

## Recent Timeline

### 2024-01-15
- **decision**: Switched to event-driven folder index generation
  - Files: src/services/folder-index/
  - Inline regeneration on observation save

</claude-mem-context>

[More manual content can be here too]
```

### 3.2 Implementation

Same tag-based approach as folder CLAUDE.md files. Root regeneration triggered when any folder index updates.

### 3.3 Verification

```bash
# Verify root CLAUDE.md has both sections
cat CLAUDE.md | grep "claude-mem-context"
cat CLAUDE.md | grep "Architecture"  # Manual section preserved
```

---

## Analytics: Git as Usage Tracking

**Intentional git commits** of CLAUDE.md files enable public usage analysis:

- Search GitHub for `<claude-mem-context>` tag
- Analyze from open repos (consent through public commit):
  - Programming languages used
  - Natural languages (international usage)
  - Observation types and patterns
  - Project sizes and structures
  - Real-world timeline content examples

**No opt-in tracking code needed.** Privacy-respecting by design.

---

## Settings Schema

```typescript
// In SettingsDefaultsManager.ts
folderIndex: {
  enabled: true,
  maxDepth: 3,
  excludeFolders: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'],
  minActivityThreshold: 3,
  ideSymlinks: {
    cursor: true,
    copilot: true,
    windsurf: true,
    cline: true,
    agents: true
  }
}
```

---

## File Structure

```
src/services/folder-index/
├── FolderDiscovery.ts
├── FolderTimelineCompiler.ts
├── ClaudeMdGenerator.ts
├── IdeSymlinkManager.ts        # Phase 2
└── index.ts

tests/folder-index/
├── folder-discovery.test.ts
├── folder-timeline.test.ts
├── claude-md-generator.test.ts
├── ide-symlink-manager.test.ts
└── integration.test.ts
```

---

## Future Enhancements (Deferred)

### Semantic Grouping
Cluster related observations instead of flat chronological timeline. Low priority—timeline is already high-value.

### Priority Weighting
Weight observations by type: `decision` > `bugfix` > `feature` > `change`. Decisions are highest-signal for AI context.

### IDE-Specific Template Refinements
Optimize templates per-IDE based on their specific capabilities and conventions.

---

## Future Phase: Team Sync (Cloud/Pro)

Team-level memory synchronization. Architecture TBD—requires cloud service infrastructure and careful consideration of how team context flows work.

---

## Risk Mitigation

1. **Manual content safety** — `<claude-mem-context>` tags isolate auto-generated content
2. **Tag deletion** — Just regenerate tags; no data loss possible
3. **Symlink safety** — Never overwrite existing non-symlink files
4. **Windows compatibility** — Fall back to file copies with header comments
5. **Graceful degradation** — If any step fails, log and continue
