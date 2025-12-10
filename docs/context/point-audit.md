# Claude-Mem Hooks Cleanup Todo

## ✅ Phase 1: Delete Dead Code (Modified)

**hook-response.ts**

- [ ] Remove `| string` from HookType union to restore type safety
- [ ] Delete PreCompact branch (lines 23-36, 14 lines)
- [x] ~~Delete pointless branches~~ — SKIP (intentional)
- [x] ~~Simplify wrapper function~~ — SKIP (intentional)

**new-hook.ts**

- [ ] Delete 34-line architecture comment block (lines 1-34)
- [ ] Replace 18 lines of debug logging with single 4-line log call (lines 64-81)

**cleanup-hook.ts**

- [ ] Remove `cwd`, `transcript_path`, `hook_event_name` from SessionEndInput interface
- [ ] Replace 12-line manual mode help with simple error throw

**user-message-hook.ts**

- [ ] Delete all 40 lines of expired announcement code (lines 31-70)
- [ ] Add comment explaining exit code 3: `// exit code 3 = show user message that Claude does NOT receive as context`

---

## ✅ Phase 2: Extract Shared Utilities

- [ ] Create `src/shared/hook-error-handler.ts` with `handleWorkerError()`
- [ ] Update all 4 hooks to use shared error handler (context-hook, new-hook, save-hook, summary-hook)
- [ ] Create `src/shared/transcript-parser.ts` — merge `extractLastUserMessage` + `extractLastAssistantMessage` into single parameterized function
- [ ] Create `src/shared/hook-constants.ts` for exit codes, timeouts

---

## ❌ Phase 3: SKIPPED

_(Entry points stay as-is, hook-response.ts wrapper stays as-is)_

---

## ✅ Phase 4: Restore Type Safety

**context-hook.ts**

- [ ] Make `session_id`, `cwd`, `transcript_path` required in SessionStartInput
- [ ] Remove `[key: string]: any`
- [ ] Remove unused `source` field
- [ ] Keep using `happy_path_error__with_fallback` for defaults (hooks use exit codes, logging tool is appropriate)

**All 4 hook interfaces**

- [ ] Remove `[key: string]: any` from all interfaces

**save-hook.ts**

- [ ] Keep `happy_path_error__with_fallback` usage (it's appropriate for hook context)

**summary-hook.ts**

- [ ] Add timeout (2s) and error logging to spinner stop request

---

## ✅ Phase 5: Relocate Business Logic (Modified)

- [ ] Move `SKIP_TOOLS` from save-hook.ts to worker service
- [ ] Make `SKIP_TOOLS` configurable via settings.json
- [x] ~~Move announcements to database~~ — SKIP
- [x] ~~Merge context-hook + user-message-hook~~ — SKIP (intentionally separate)

---

## Summary

| Action            | Count |
| ----------------- | ----- |
| Lines to delete   | ~150  |
| New shared files  | 3     |
| Interfaces to fix | 4     |
| Items skipped     | 5     |
