# Fix: Null Pointer Crash in SDKAgent Observation Logging

## Problem

Worker service crashes when processing observations with null titles or summaries with null requests.

**Error (Session 17, 2025-11-13 21:01:54):**
```
[ERROR] [SDK] Cannot read properties of null (reading 'substring')
```

**Impact:**
- PostToolUse hook fails
- Database drops observations
- Terminal shows hook errors
- Worker loses data but continues running

---

## Root Cause

### Type Definitions (`src/services/sqlite/types.ts`)

```typescript
export interface ObservationRow {
  title: string | null;              // Line 210
  subtitle: string | null;            // Line 211
  narrative: string | null;           // Line 213
  // ...
}

export interface SessionSummaryRow {
  request: string | null;             // Line 226
  // ...
}
```

### Unsafe Operations (`src/services/worker/SDKAgent.ts`)

Code calls `.substring()` on nullable fields without null checks:

**Line 224 - Observation logger:**
```typescript
// ❌ Crashes on null
title: obs.title.substring(0, 60) + (obs.title.length > 60 ? '...' : '')
```

**Lines 243, 256 - Chroma sync logger:**
```typescript
// ❌ Crashes on null
const truncatedTitle = obsTitle.length > 50
  ? obsTitle.substring(0, 50) + '...'
  : obsTitle;
```

**Lines 301, 319, 330 - Summary logger:**
```typescript
// ❌ Crashes on null
request: summary.request.substring(0, 60) + (summary.request.length > 60 ? '...' : '')
```

### Why Null Occurs

SDK agent extracts observations via Claude API. When AI response omits title or request fields, parser returns `null` by design.

---

## Fix

### Pattern

```typescript
// Before
field.substring(0, N)

// After
(field || '').substring(0, N)
```

Coalesces `null`/`undefined` to empty string before calling `.substring()`.

### Files Changed

**`src/services/worker/SDKAgent.ts`** - 6 locations:

| Line | Field | Context |
|------|-------|---------|
| 224 | `obs.title` | Observation logger |
| 242-244 | `obsTitle` | Chroma sync success |
| 256 | `obsTitle` | Chroma sync error |
| 301 | `summary.request` | Summary logger |
| 318-320 | `summaryRequest` | Chroma sync success |
| 330 | `summaryRequest` | Chroma sync error |

**`tests/sdk-agent-null-safety.test.ts`** - 22 tests:
- Null/undefined handling (10 tests)
- Ellipsis patterns (4 tests)
- Edge cases (4 tests)
- Regression tests (4 tests)

---

## Verification

### Confirm Bug

```bash
# Type definitions allow null
git show HEAD~2:src/services/sqlite/types.ts | grep "title: string"
# → title: string | null;

# Old code crashes
git show HEAD~2:src/services/worker/SDKAgent.ts | grep -n "obs.title.substring"
# → 224:  title: obs.title.substring(0, 60)
```

### Confirm Fix

```bash
# New code safe
git show HEAD:src/services/worker/SDKAgent.ts | grep -n "(obs.title || '')"
# → 224:  title: (obs.title || '').substring(0, 60)

# See diff
git diff HEAD~2 HEAD -- src/services/worker/SDKAgent.ts
```

### Run Tests

```bash
node --test tests/sdk-agent-null-safety.test.ts
# → tests 22, pass 22, fail 0
```

### Production Check

```bash
npm run build && npm run sync-marketplace && npm run worker:restart
cd ~/.claude/plugins/marketplaces/thedotmack
npx pm2 logs claude-mem-worker --err --lines 50 --nostream | grep "substring"
# → No errors (before fix: "Cannot read properties of null")
```

### Search Similar Bugs

```bash
grep -rn "\.substring" src/services/worker/SDKAgent.ts | grep -v "|| ''"
# → Line 76 safe (protected by length check)

---

## Test Results

**File:** `tests/sdk-agent-null-safety.test.ts` (22 tests, all passing)

Covers:
- Null/undefined title and request fields
- Empty strings preserved
- Long strings truncated correctly
- Ellipsis patterns match code
- Whitespace, special characters, newlines
- Exact regression of production crash

**Worker logs:** No substring errors after restart (previously crashed at 21:01:54)

---

## Completeness

**SDKAgent.ts substring calls:**
- Line 76: Safe (protected by `if (responseSize > 0)`)
- Lines 224, 243, 256, 301, 319, 330: Fixed ✅

**parser.ts:** No substring calls found

All unsafe calls on nullable fields are fixed.

---

## Review Checklist

- [ ] Run tests: `node --test tests/sdk-agent-null-safety.test.ts`
- [ ] Check diff: `git diff main...fix/substring-null-crash`
- [ ] Verify 6 locations use `(field || '')`  pattern
- [ ] Confirm types allow null: `src/services/sqlite/types.ts:210, 226`
- [ ] Check PM2 logs: no substring errors
- [ ] Build succeeds: `npm run build`

---

## Commits

- `c110326` - fix: Add null checks for obs.title and summary.request
- `2b0d235` - test: Add 22 null safety tests for SDKAgent

---

## Related

- Bug report: `docs/context/bug-null-substring-sdk-agent.md`
- Production crash: Session 17, 2025-11-13 21:01:54
- Fixed null-safety errors in SDKAgent observation and summary logging