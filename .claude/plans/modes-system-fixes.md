# Modes System Fixes - Implementation Plan

## Context

The modes system allows claude-mem to work in different contexts (code development vs email investigation). A comprehensive audit revealed several issues preventing the system from being fully functional for non-code modes.

## Issues to Fix

1. **SettingsRoutes.ts** - Hardcoded validation rejects email-investigation types
2. **Dead migration code** - migration008 never runs (formal migrations not wired to worker)
3. **Duplicate icon mappings** - 4+ places with hardcoded code-mode-only icons
4. **Duplicate mode files** - `/modes/` and `/plugin/modes/` contain same files
5. **Unused ModeManager methods** - `getObservationConcepts()`, `getWorkEmoji()`, `getTypeLabel()`, `getTypeIcon()` defined but not used
6. **Hardcoded legend strings** - Won't show email-investigation type legends

---

## Phase 1: Fix Critical Settings Validation

**Goal:** Allow email-investigation types to be set via API

**Files to modify:**
- `src/services/worker/http/routes/SettingsRoutes.ts`

**Changes:**

1. Import ModeManager:
```typescript
import { ModeManager } from '../../domain/ModeManager.js';
```

2. Replace lines 300-306 (hardcoded OBSERVATION_TYPES validation):
```typescript
// OLD:
if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) {
  return { valid: false, error: `Invalid observation type: ${type}. Valid types: ${OBSERVATION_TYPES.join(', ')}` };
}

// NEW:
// Skip validation - any type string is valid since modes define their own types
// The database accepts any TEXT value, and mode-specific validation happens at parse time
```

3. Similarly update lines 310-316 for concepts validation.

4. Remove unused imports: `OBSERVATION_TYPES`, `OBSERVATION_CONCEPTS`, `ObservationType`, `ObservationConcept` from observation-metadata.ts

**Verification:**
```bash
npm run build
npm test -- -t "Settings"
```

---

## Phase 2: Remove Dead Migration and Duplicate Files

**Goal:** Clean up unused code and duplicate files

**Files to delete:**
- `modes/code.json` (duplicate of `plugin/modes/code.json`)
- `modes/email-investigation.json` (duplicate of `plugin/modes/email-investigation.json`)
- Remove `migration008` from `src/services/sqlite/migrations.ts` (never executed)

**Changes to `src/services/sqlite/migrations.ts`:**

1. Remove entire `migration008` export (lines 498-655)
2. Remove `migration008` from the exports array (line 668)

**Verification:**
```bash
rm modes/code.json modes/email-investigation.json
npm run build
npm test
```

---

## Phase 3: Consolidate Icon Mappings

**Goal:** Single source of truth for type icons using ModeManager

**Files to modify:**
- `src/services/worker/TimelineService.ts`
- `src/services/worker/SearchManager.ts`
- `src/services/worker/FormattingService.ts`
- `src/services/context-generator.ts`

**Strategy:**

Create a shared utility function that gets icon from active mode:

```typescript
// In ModeManager.ts - already has getTypeIcon(), just ensure fallback works
getTypeIcon(typeId: string): string {
  const type = this.getObservationTypes().find(t => t.id === typeId);
  return type?.emoji || '•';
}
```

**Changes per file:**

### TimelineService.ts (lines 212-222)
Replace hardcoded switch with:
```typescript
private getTypeIcon(type: string): string {
  return ModeManager.getInstance().getTypeIcon(type);
}
```

### SearchManager.ts (3 locations: ~595, ~1680, ~1932)
Replace each hardcoded switch with ModeManager.getInstance().getTypeIcon(type)

### FormattingService.ts (lines 58, 119)
Replace TYPE_ICON_MAP usage with ModeManager.getInstance().getTypeIcon(type)

### context-generator.ts (lines 330-332)
Generate legend dynamically from mode:
```typescript
const mode = ModeManager.getInstance().getActiveMode();
const legend = mode.observation_types.map(t => `${t.emoji} ${t.id}`).join(' | ');
output.push(`**Legend:** 🎯 session-request | ${legend}`);
```

**Verification:**
```bash
npm run build
npm test -- -t "Mode System"
```

---

## Phase 4: Clean Up Unused Constants

**Goal:** Remove observation-metadata.ts constants that are now unused

**Files to modify:**
- `src/constants/observation-metadata.ts`
- `src/shared/SettingsDefaultsManager.ts`

**After Phase 3, check which exports are still used:**

Keep only what's still needed:
- `DEFAULT_OBSERVATION_TYPES_STRING` - still used for settings defaults
- `DEFAULT_OBSERVATION_CONCEPTS_STRING` - still used for settings defaults

Remove if unused:
- `OBSERVATION_TYPES` array
- `OBSERVATION_CONCEPTS` array
- `TYPE_ICON_MAP`
- `TYPE_WORK_EMOJI_MAP`
- TypeScript types `ObservationType`, `ObservationConcept`

**Note:** Some of these may still be needed for UI components. Verify with:
```bash
grep -r "OBSERVATION_TYPES\|TYPE_ICON_MAP\|TYPE_WORK_EMOJI_MAP" src/
```

**Verification:**
```bash
npm run build
npm test
```

---

## Phase 5: Final Verification

**Goal:** Ensure everything works end-to-end

**Manual testing checklist:**

1. Start worker with default (code) mode:
```bash
npm run worker:restart
curl http://localhost:37777/health
```

2. Test code mode observations are captured correctly

3. Switch to email-investigation mode:
```bash
# Edit ~/.claude-mem/settings.json
{ "CLAUDE_MEM_MODE": "email-investigation" }
npm run worker:restart
```

4. Verify email-investigation types work:
- Types like `entity`, `relationship` should be accepted
- Icons should display correctly
- Legends should show email-investigation types

**Run full test suite:**
```bash
npm test
npm run build
```

---

## Summary

| Phase | Effort | Risk | Dependencies |
|-------|--------|------|--------------|
| 1 | Low | Low | None |
| 2 | Low | Low | None |
| 3 | Medium | Medium | Phase 1 |
| 4 | Low | Low | Phase 3 |
| 5 | Low | Low | All phases |

**Total estimated changes:**
- ~50 lines removed
- ~30 lines modified
- 2 files deleted

**Key files touched:**
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `src/services/sqlite/migrations.ts`
- `src/services/worker/TimelineService.ts`
- `src/services/worker/SearchManager.ts`
- `src/services/worker/FormattingService.ts`
- `src/services/context-generator.ts`
- `src/constants/observation-metadata.ts`
