 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Endless Mode Cleanup Plan

 Approved Changes

 1. Delete Dead Code - TransformLayer.ts ✓

 File: src/services/worker/TransformLayer.ts (330 lines)
 Action: Delete entire file
 Reason: Historical artifact from old "in-memory transformation" approach that was replaced by "file-based transformation"
 (deferred-transformation.ts). Never imported or used.

 2. Extract SKIP_TOOLS Constant ✓

 Files: src/services/worker-service.ts line 32, src/hooks/save-hook.ts line 38
 Action:
 - Create src/shared/skip-tools.ts exporting the constant
 - Update both files to import from shared location
 Reason: DRY violation - identical Set duplicated in 2 files

 3. Simplify EndlessModeConfig.ts ✓

 File: src/services/worker/EndlessModeConfig.ts (160 lines → ~20 lines)
 Action: Replace class with simple function
 - Remove static caching (settings don't change at runtime)
 - Keep priority logic (settings.json > env > defaults) but inline it
 - Remove getBooleanSetting/getNumberSetting helper methods
 Reason: Over-abstraction for simple config reading

 4. Synchronous Mode: Flag + Helper ✓

 File: src/services/worker-service.ts lines 516-593 (78 lines)
 Action:
 - Add config flag to enable/disable synchronous waiting
 - Extract waiting logic to waitForObservation() helper function
 Reason: Makes feature optional and reduces handleObservations complexity

 5. Remove Transcript Backups ✓

 File: src/shared/deferred-transformation.ts lines 152-163
 Action: Delete backup creation before transformation
 Reason: tool-output-backup.ts already backs up original outputs. Redundant system.

 6. Use Template Literal for Markdown ✓

 File: src/shared/deferred-transformation.ts formatObservationAsMarkdown (52 lines)
 Action: Replace array-push-join pattern with template string
 Reason: Clearer, fewer lines, easier to read

 7. Remove JSONL Validation ✓

 File: src/shared/deferred-transformation.ts lines 246-253
 Action: Delete validation that reads back temp file
 Reason: If JSON.stringify worked, parsing will work. Defensive paranoia.

 8. Document cleanupOrphanedProcesses ✓

 File: src/services/worker-service.ts lines 199-226
 Action: Add comment explaining this cleans up orphaned processes from v6.0.3-6 bug
 Reason: Prevents housekeeping code from looking like unnecessary defensive programming

 Items Marked "Keep As-Is" (With Rationale)

 1. JSONL backup system - Restore data, not search data. SQLite overhead not justified.
 2. tool_use_id extraction - PRIMARY action (not fallback). tool_use_id not sent with input.
 3. Error handling (26 lines) - Different error types need different user messages.
 4. File scanning (extractPendingToolUseIds) - Intentional for catching deferred work. Fast.
 5. restore CLI (195 lines) - Detailed feedback valuable for rare but critical operation.
 6. paths.ts helpers - Cross-platform compatibility critical.
 7. parseArrayField helper - Used 3x, handles edge cases properly.
 8. cleanupOrphanedProcesses - Solves real problem from version upgrade.

 Not Yet Reviewed (Needs Discussion)

 1. Magic numbers - Hardcoded values like timeoutMs = 2000 without named constants
 2. Logging verbosity - Extensive debug/info/success logging throughout
 3. summarizeRequestBody - 25 lines just to format log messages
 4. Stats tracking - Overhead in various places for metrics nobody uses
 5. Comment quality - Missing WHY explanations for non-obvious choices

 ---
 Estimated Impact:
 - Lines removed: ~500
 - Lines added: ~50 (refactored code)
 - Net reduction: ~450 lines (15%)
 - Files deleted: 1 (TransformLayer.ts)
 - Risk level: Low (mostly deletions and simplifications)