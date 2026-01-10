# Implementation Plan: Disable Subdirectory CLAUDE.md Files (#641/#609)

## Problem Statement

The CLAUDE.md folder index feature creates files in every project subdirectory touched during Claude sessions. Users report this as "file pollution" - the setting `disableSubdirectoryCLAUDEmd` was documented but never implemented, causing files to be created unconditionally.

Related issues: #641, #609, #635, #632

## Phase 0: Documentation Discovery (Complete)

### Sources Consulted
- `src/shared/SettingsDefaultsManager.ts` (lines 1-185) - Settings interface and defaults
- `src/utils/claude-md-utils.ts` (lines 1-336) - CLAUDE.md generation logic
- `src/services/worker/agents/ResponseProcessor.ts` (lines 215-234) - Caller of updateFolderClaudeMdFiles
- `src/ui/viewer/constants/settings.ts` (lines 1-39) - UI settings defaults

### Allowed APIs
1. **SettingsDefaultsManager.loadFromFile(path)** → Returns `SettingsDefaults` with all settings merged
2. **Settings access pattern**: `settings.SETTING_NAME` for string values
3. **Boolean conversion**: Compare string value to `'true'` (settings are stored as strings)

### Anti-Patterns to Avoid
- Do NOT use `SettingsDefaultsManager.getBool()` - that's a static method for defaults only, not for loaded settings
- Do NOT assume settings file exists - `loadFromFile` handles creation gracefully

## Phase 1: Add Setting to SettingsDefaultsManager

**What to implement**: Add `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` setting with default `'false'`

### Task 1.1: Update SettingsDefaults interface

**File**: `src/shared/SettingsDefaultsManager.ts`
**Location**: Line 51-53 (after `CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE`)

Add to interface:
```typescript
// Feature Toggles
CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: string;  // ADD THIS
```

### Task 1.2: Update DEFAULTS object

**File**: `src/shared/SettingsDefaultsManager.ts`
**Location**: Line 95-97 (after `CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE`)

Add to defaults:
```typescript
// Feature Toggles
CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',  // ADD THIS - disabled by default
```

### Verification
```bash
# Verify setting exists in file
grep -n "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED" src/shared/SettingsDefaultsManager.ts
# Should show 2 matches (interface + defaults)
```

## Phase 2: Update UI Settings Constants

**What to implement**: Add matching setting to UI constants for consistency

### Task 2.1: Add to DEFAULT_SETTINGS

**File**: `src/ui/viewer/constants/settings.ts`
**Location**: Line 38-39 (after `CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE`)

Add:
```typescript
// Feature Toggles
CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',  // ADD THIS
```

### Verification
```bash
# Verify setting exists in UI constants
grep -n "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED" src/ui/viewer/constants/settings.ts
# Should show 1 match
```

## Phase 3: Implement Setting Check in CLAUDE.md Generation

**What to implement**: Early return in `updateFolderClaudeMdFiles()` when feature is disabled

### Task 3.1: Add early return check

**File**: `src/utils/claude-md-utils.ts`
**Location**: Line 265-266 (immediately after loading settings and limit)

Add check:
```typescript
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  port: number,
  projectRoot?: string
): Promise<void> {
  // Load settings to get configurable observation limit
  const settings = SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  const limit = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10) || 50;

  // ADD THIS: Check if folder CLAUDE.md feature is enabled
  const folderClaudeMdEnabled = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED === 'true';
  if (!folderClaudeMdEnabled) {
    logger.debug('FOLDER_INDEX', 'Folder CLAUDE.md feature disabled via settings');
    return;
  }

  // ... rest of function unchanged
```

### Verification
```bash
# Verify the check exists
grep -A2 "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED" src/utils/claude-md-utils.ts
# Should show the enabled check and early return
```

## Phase 4: Build and Test

### Task 4.1: Build the project
```bash
npm run build
```

### Task 4.2: Verify default behavior (disabled)

1. Delete existing settings file: `rm ~/.claude-mem/settings.json`
2. Start a new Claude Code session
3. Make changes to files in a subdirectory
4. Verify NO new CLAUDE.md files created in subdirectories

### Task 4.3: Verify opt-in behavior (enabled)

1. Edit `~/.claude-mem/settings.json`
2. Add: `"CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED": "true"`
3. Start a new session
4. Make changes to files
5. Verify CLAUDE.md files ARE created in touched subdirectories

## Phase 5: Final Verification Checklist

- [ ] `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` exists in `SettingsDefaults` interface
- [ ] Default value is `'false'` in `DEFAULTS` object
- [ ] UI constants file has matching setting
- [ ] `updateFolderClaudeMdFiles()` checks setting before processing
- [ ] Early return logs a debug message for diagnostics
- [ ] Build succeeds with no TypeScript errors
- [ ] Feature is OFF by default (no CLAUDE.md pollution)
- [ ] Feature can be enabled via settings.json

## Files Modified Summary

| File | Changes |
|------|---------|
| `src/shared/SettingsDefaultsManager.ts` | Add setting to interface and defaults |
| `src/ui/viewer/constants/settings.ts` | Add setting for UI consistency |
| `src/utils/claude-md-utils.ts` | Add early return when disabled |

## Rollback Plan

If issues arise, the setting defaults to `'false'`, so the feature is already disabled. To revert code changes:
```bash
git checkout HEAD -- src/shared/SettingsDefaultsManager.ts src/ui/viewer/constants/settings.ts src/utils/claude-md-utils.ts
```
