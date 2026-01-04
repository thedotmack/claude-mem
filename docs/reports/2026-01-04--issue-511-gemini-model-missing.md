# Issue #511: GeminiAgent Missing gemini-3-flash Model

## Summary

**Issue**: `gemini-3-flash` model missing from GeminiAgent validation
**Type**: Bug - Configuration Mismatch
**Status**: Open

The `GeminiAgent` class is missing `gemini-3-flash` in its `validModels` array and `GeminiModel` type, while `SettingsRoutes` correctly validates it. This causes a silent fallback to `gemini-2.5-flash` when users configure `gemini-3-flash`.

## Root Cause

Synchronization gap between two configuration validation sources:

| Component | Location | Status |
|-----------|----------|--------|
| SettingsRoutes.ts (line 244) | Settings validation | Includes `gemini-3-flash` |
| GeminiAgent.ts (lines 34-39) | Type definition | **MISSING** |
| GeminiAgent.ts (lines 42-48) | RPM limits | **MISSING** |
| GeminiAgent.ts (lines 370-376) | validModels array | **MISSING** |

## Failure Behavior

1. User configures `gemini-3-flash` in settings
2. Settings validation passes (SettingsRoutes.ts includes it)
3. At runtime, `GeminiAgent.getGeminiConfig()`:
   - Checks `validModels` - model not found
   - Logs warning: "Invalid Gemini model 'gemini-3-flash', falling back to gemini-2.5-flash"
   - Silently uses wrong model

## Affected Files

| File | Change Required |
|------|-----------------|
| `src/services/worker/GeminiAgent.ts` | Add to type, RPM limits, validModels |

## Recommended Fix

**3 additions to GeminiAgent.ts:**

```typescript
// 1. Type definition (lines 34-39)
export type GeminiModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-3-flash';  // ADD

// 2. RPM limits (lines 42-48)
const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  // ... existing entries ...
  'gemini-3-flash': 5,  // ADD
};

// 3. validModels (lines 370-376)
const validModels: GeminiModel[] = [
  // ... existing entries ...
  'gemini-3-flash',  // ADD
];
```

## Complexity

**Trivial** - < 5 minutes

- 3 lines to add in 1 file
- No test changes required
- Fully backward compatible
