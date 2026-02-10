# System Environment Variable Fallback for API Credentials

**Date:** 2026-02-08
**Status:** Fixed
**Files Modified:** `src/shared/EnvManager.ts`

## Problem

Users who have API credentials configured at the system level (e.g., via Windows environment variables) could not use claude-mem without manually creating a `~/.claude-mem/.env` file. This was particularly problematic for:

1. **Users of third-party Anthropic-compatible APIs** (e.g., Zhipu AI, OpenRouter) who configure `ANTHROPIC_BASE_URL` at system level
2. **Users with `ANTHROPIC_AUTH_TOKEN`** instead of `ANTHROPIC_API_KEY` (some providers use different naming)
3. **Workflow inconvenience** - requiring duplicate configuration in both system env vars and claude-mem's .env file

### Root Cause

The `buildIsolatedEnv()` function in `EnvManager.ts` only read credentials from `~/.claude-mem/.env` file, with no fallback to system environment variables. This design was intentional (Issue #733) to prevent random project .env files from interfering, but it was too restrictive for legitimate system-level configuration.

## Solution

Modified `EnvManager.ts` to implement **layered credential resolution**:

1. **Priority order:**
   - First: `~/.claude-mem/.env` (explicit claude-mem config, highest priority)
   - Second: System environment variables (fallback for system-level config)

2. **New supported credentials:**
   - `ANTHROPIC_BASE_URL` - For custom API endpoints (e.g., Zhipu AI)
   - `ANTHROPIC_AUTH_TOKEN` - Aliased to `ANTHROPIC_API_KEY` (Zhipu AI naming)

3. **Updated functions:**
   - `buildIsolatedEnv()` - Added fallback logic for all credential types
   - `hasAnthropicApiKey()` - Also checks system env vars
   - `getAuthMethodDescription()` - Reports actual credential source

## Changes

### `src/shared/EnvManager.ts`

```typescript
// Added ANTHROPIC_BASE_URL to managed credentials
export const MANAGED_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',  // NEW
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
];

export interface ClaudeMemEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;  // NEW
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}
```

```typescript
// Layered credential resolution in buildIsolatedEnv()
const apiKey = fileCredentials.ANTHROPIC_API_KEY
  || process.env.ANTHROPIC_API_KEY
  || process.env.ANTHROPIC_AUTH_TOKEN;  // Support Zhipu AI naming

const baseUrl = fileCredentials.ANTHROPIC_BASE_URL
  || process.env.ANTHROPIC_BASE_URL;  // Support custom endpoints
```

## Testing

Verified with:
- **Zhipu AI API** (`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`)
- **System environment variables** (`ANTHROPIC_AUTH_TOKEN`)
- **No `~/.claude-mem/.env` file required**

Log output confirms correct behavior:
```
authMethod=API key (from system env ANTHROPIC_AUTH_TOKEN)
Response received (1223 chars)  ✅
STORED | obsCount=1 | obsIds=[28]  ✅
```

## Compatibility

- **Backward compatible:** Existing `~/.claude-mem/.env` files still work and take priority
- **No breaking changes:** All existing configurations continue to work
- **Respects Issue #733:** Still prevents random project .env files from interfering

## Use Cases

This fix enables:

1. **Third-party API providers:**
   ```bash
   # Zhipu AI
   export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
   export ANTHROPIC_AUTH_TOKEN=your_token
   ```

2. **OpenRouter:**
   ```bash
   export OPENROUTER_API_KEY=your_key
   ```

3. **Gemini:**
   ```bash
   export GEMINI_API_KEY=your_key
   ```

All without requiring `~/.claude-mem/.env` configuration.
