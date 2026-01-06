# Issue #531: Export Script Type Duplication

## Summary

**Issue**: Reduce code duplication in export scripts with shared type definitions
**Type**: Code Quality/Maintainability
**Status**: Open
**Author**: @rjmurillo

The `export-memories.ts` script defines type interfaces inline that duplicate definitions already present in `src/types/database.ts`. This creates a maintenance burden and prevents DRY principles.

## Root Cause

Type duplication exists across two locations:

**Location 1: `scripts/export-memories.ts` (lines 13-85)**
- `ObservationRecord` (18 lines)
- `SdkSessionRecord` (12 lines)
- `SessionSummaryRecord` (17 lines)
- `UserPromptRecord` (8 lines)
- `ExportData` (14 lines)

**Location 2: `src/types/database.ts` (lines 46-108)**
- `SdkSessionRecord`, `ObservationRecord`, `SessionSummaryRecord`, `UserPromptRecord`

**Total Duplication**: ~73 lines that mirror existing type definitions

## Type Discrepancies

| Type | Export Script | Database Type |
|------|---------------|---------------|
| ObservationRecord.title | `string` (required) | `string?` (optional) |
| SdkSessionRecord.user_prompt | `string` (required) | `string \| null` |
| SessionSummaryRecord | Includes `files_read`, `files_edited` | Missing these fields |
| ExportData | Unique wrapper | No equivalent |

## Affected Files

1. `scripts/export-memories.ts` - Primary duplication source
2. `src/types/database.ts` - Master type definitions
3. `scripts/import-memories.ts` - Uses export data structure
4. `src/services/worker-types.ts` - Related types with different naming

## Recommended Fix

1. Create `scripts/types/export.ts` with export-specific type extensions
2. Use type composition to handle optionality differences:
   ```typescript
   export interface ExportObservationRecord extends Omit<DatabaseObservationRecord, 'title'> {
     title: string; // Override: required for exports
   }
   ```
3. Update import paths in export/import scripts

## Complexity

**Medium** - 2-3 hours

- Type discrepancies require careful mapping
- Only 4 files need updates
- No breaking changes (internal scripts)
- Existing tests should continue to pass
