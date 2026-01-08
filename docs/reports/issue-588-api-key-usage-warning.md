# Issue #588: Unexpected API Charges from ANTHROPIC_API_KEY Discovery

**Date:** January 7, 2026
**Status:** INVESTIGATION COMPLETE - Critical UX/Financial Issue
**Priority:** HIGH
**Labels:** bug, financial-impact, ux
**Author:** imkane
**Version Affected:** 9.0.0 and earlier

---

## Executive Summary

A user with a Claude Max subscription ($100/month) began receiving unexpected "Auto-recharge credits" invoice emails from Anthropic after installing the claude-mem plugin. The plugin discovered an `ANTHROPIC_API_KEY` in a `.env` file in the project root and used it for AI operations (observation compression, summary generation), causing direct API charges that were not anticipated by the user.

**Financial Impact:** The user expected all AI costs to be covered by their Claude Max subscription. Instead, the plugin consumed their Anthropic API credits separately, triggering auto-recharge billing.

**Root Cause:** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) automatically discovers and uses `ANTHROPIC_API_KEY` from environment variables or `.env` files. Claude-mem's worker service runs AI operations (observation compression, summaries) through this SDK, which consumes API credits independently of the user's Claude Max subscription.

---

## Problem Analysis

### User Expectations vs. Reality

| Expectation | Reality |
|-------------|---------|
| Claude Max ($100/mo) covers all Claude usage | Claude Max covers Claude Code IDE usage only |
| Plugin enhances Claude Code without extra cost | Plugin uses separate API calls via SDK |
| No API key needed since using Claude Max | SDK auto-discovers `.env` API keys |
| Billing would be transparent | Silent API key discovery leads to surprise charges |

### The Discovery Flow

1. User installs claude-mem plugin via marketplace
2. User has an `ANTHROPIC_API_KEY` in project `.env` file (for other purposes)
3. Plugin worker starts on first Claude Code session
4. Worker spawns Claude Agent SDK for observation processing
5. SDK auto-discovers `ANTHROPIC_API_KEY` from environment
6. Every observation compression and session summary uses API credits
7. User receives unexpected invoice for API usage

---

## Technical Details

### How claude-mem Uses the Claude Agent SDK

Claude-mem uses `@anthropic-ai/claude-agent-sdk` (version ^0.1.76) for AI-powered operations:

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker/SDKAgent.ts`

```typescript
// Line 26
import { query } from '@anthropic-ai/claude-agent-sdk';

// Lines 100-114 - SDK query execution
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    ...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});
```

### API Key Discovery Chain

The Claude Agent SDK uses a standard discovery mechanism:

1. **Environment Variable:** `process.env.ANTHROPIC_API_KEY`
2. **File Discovery:** `~/.anthropic/api_key` or project `.env` files
3. **Inherited Environment:** Claude Code passes its environment to spawned processes

**From hooks architecture documentation (line 826-828):**
```markdown
### API Key Protection

**Configuration:**
- Anthropic API key in `~/.anthropic/api_key` or `ANTHROPIC_API_KEY` env var
- Worker inherits environment from Claude Code
- Never logged or stored in database
```

### Worker Service Environment Inheritance

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker-service.ts`

```typescript
// Line 263 - Worker spawns with full environment
env: process.env
```

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/infrastructure/ProcessManager.ts`

```typescript
// Line 273 - Process inherits environment
...process.env,
```

This means any `ANTHROPIC_API_KEY` present in the parent process environment or discovered from `.env` files will be used by the worker.

### What Operations Consume API Credits

| Operation | Trigger | API Usage |
|-----------|---------|-----------|
| Observation Compression | PostToolUse hook | ~0.5-2K tokens per observation |
| Session Summary | Summary hook | ~2-5K tokens per session |
| Follow-up Queries | Multi-turn processing | Variable |

**Estimated Usage Per Session:**
- Active coding session: 20-50 tool uses
- At ~1.5K tokens per observation: 30-75K tokens
- Session summary: ~3K tokens
- **Total per session: 33-78K tokens**

### Alternative Providers (Not Using Anthropic API)

Claude-mem supports alternative AI providers that DO NOT use the Anthropic API:

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker/GeminiAgent.ts`

```typescript
// Line 376
const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
```

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker/OpenRouterAgent.ts`

```typescript
// Line 418
const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
```

These providers require explicit configuration and do not auto-discover.

---

## Impact Assessment

### Financial Impact

| Scenario | Estimated Monthly Cost |
|----------|------------------------|
| Light usage (5 sessions/day) | $10-30 |
| Moderate usage (15 sessions/day) | $30-90 |
| Heavy usage (30+ sessions/day) | $90-200+ |

**Compounding Factors:**
- Auto-recharge enabled by default on Anthropic accounts
- No notification before charges occur
- User may not realize plugin is source of usage

### User Experience Impact

1. **Trust Violation:** Users expect plugins to be transparent about costs
2. **Subscription Confusion:** Claude Max subscription doesn't cover SDK API usage
3. **No Consent:** API key used without explicit opt-in
4. **Discovery Difficulty:** Source of charges not immediately obvious

### Affected User Base

- Users with `ANTHROPIC_API_KEY` in project `.env` files
- Users with API key in `~/.anthropic/api_key`
- Users who exported `ANTHROPIC_API_KEY` for other tools
- Users who don't know they have an API key configured

---

## Root Cause Analysis

### Primary Root Cause

**Silent API key auto-discovery by the Claude Agent SDK without user consent or notification.**

The SDK is designed for developer use cases where explicit API key configuration is expected. When used within a plugin context, the automatic discovery behavior creates a mismatch between user expectations and system behavior.

### Contributing Factors

1. **No Pre-Flight Check:** Plugin doesn't warn users that it will use API credits
2. **No Opt-In Flow:** API key usage happens automatically without consent
3. **No Usage Visibility:** No way to see API consumption before it happens
4. **Documentation Gap:** Not clearly documented that separate API credits are used
5. **Provider Default:** Default provider is 'claude' which uses Anthropic API

### Why This Wasn't Caught Earlier

- Developer testing uses API keys intentionally
- Claude Max subscription model is newer
- Auto-discovery is a feature for SDK users, not plugin users
- No telemetry on API key discovery

---

## Recommended Solutions

### Immediate Fixes (v9.0.1)

#### 1. Add First-Run Warning

Display a prominent warning on first plugin activation:

```
[claude-mem] IMPORTANT: This plugin uses the Claude Agent SDK for AI operations.

If you have an ANTHROPIC_API_KEY configured, it will be used for:
- Observation compression
- Session summaries

This may incur separate API charges beyond your Claude Max subscription.

To avoid charges, configure an alternative provider in ~/.claude-mem/settings.json:
- Set CLAUDE_MEM_PROVIDER to "gemini" or "openrouter"
- Or ensure no ANTHROPIC_API_KEY is accessible to the plugin

Continue? [Y/n]
```

#### 2. Detect and Warn About API Key

Add a check during worker initialization:

```typescript
// Pseudo-code for worker-service.ts
const hasAnthropicKey = !!(
  process.env.ANTHROPIC_API_KEY ||
  existsSync(join(homedir(), '.anthropic', 'api_key'))
);

if (hasAnthropicKey && provider === 'claude') {
  logger.warn('SYSTEM',
    'ANTHROPIC_API_KEY detected. Plugin AI operations will consume API credits. ' +
    'Configure CLAUDE_MEM_PROVIDER in settings.json to use a free alternative.'
  );
}
```

#### 3. Default to Free Provider

Change default provider from 'claude' to 'gemini' (free tier available):

**File:** `src/shared/SettingsDefaultsManager.ts`

```typescript
// Line 66 - Change default
CLAUDE_MEM_PROVIDER: 'gemini',  // Changed from 'claude' - free tier by default
```

### Medium-Term Solutions (v9.1.0)

#### 4. Opt-In API Key Usage

Require explicit configuration to use Anthropic API:

```json
// ~/.claude-mem/settings.json
{
  "CLAUDE_MEM_PROVIDER": "claude",
  "CLAUDE_MEM_ANTHROPIC_API_KEY_CONSENT": true  // New required field
}
```

#### 5. Usage Estimation Before Processing

Show estimated token usage before processing:

```
[claude-mem] Processing 25 observations
Estimated API usage: ~37,500 tokens (~$0.15)
Provider: claude (ANTHROPIC_API_KEY)
```

#### 6. Environment Isolation

Prevent automatic API key inheritance:

```typescript
// In worker spawn
env: {
  ...process.env,
  ANTHROPIC_API_KEY: undefined,  // Explicitly unset unless opted-in
}
```

### Long-Term Solutions (v10.0.0)

#### 7. Built-In Usage Dashboard

Add API usage tracking to the viewer UI at http://localhost:37777:

- Total tokens consumed this session/day/month
- Estimated costs by provider
- Warning thresholds

#### 8. Provider Configuration Wizard

First-run wizard in viewer UI:

1. "Choose your AI provider for memory operations"
2. Options: Free (Gemini), Pay-per-use (Claude/OpenRouter), Self-hosted
3. Configure API keys through UI, not discovery

---

## Priority/Severity Assessment

### Severity: HIGH

**Rationale:**
- Direct financial impact on users
- Trust violation in plugin ecosystem
- No user consent for charges
- Difficult to discover source of charges
- Affects users who believed Claude Max covered all costs

### Priority: P1 - Critical

**Rationale:**
- Active financial harm to users
- Reputation risk for plugin
- Simple fixes available
- User trust requires immediate action

### Recommended Timeline

| Milestone | Target | Description |
|-----------|--------|-------------|
| Hotfix | 48 hours | Add warning message, update docs |
| v9.0.1 | 1 week | Detection, warning, default provider change |
| v9.1.0 | 2 weeks | Opt-in flow, usage estimation |
| v10.0.0 | 1 month | Full usage dashboard, configuration wizard |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/worker-service.ts` | Add API key detection and warning |
| `src/shared/SettingsDefaultsManager.ts` | Change default provider to 'gemini' |
| `plugin/scripts/context-hook.js` | Add first-run warning |
| `docs/public/installation.mdx` | Document API key usage clearly |
| `docs/public/configuration.mdx` | Add provider selection guidance |
| `CHANGELOG.md` | Document the change |

---

## Testing Recommendations

### Test Cases to Add

1. **API Key Detection Test:** Verify warning appears when ANTHROPIC_API_KEY present
2. **Default Provider Test:** Ensure new installs default to gemini
3. **Opt-In Test:** Verify claude provider requires explicit consent
4. **Environment Isolation Test:** Confirm API key not inherited without consent

### Manual Testing

```bash
# Test 1: Clean environment (should default to gemini)
unset ANTHROPIC_API_KEY
claude  # Start Claude Code with plugin

# Test 2: With API key (should show warning)
export ANTHROPIC_API_KEY="sk-test-key"
claude  # Should display warning

# Test 3: Explicit opt-in
# Configure settings.json with consent flag
claude  # Should use claude provider without warning
```

---

## Conclusion

Issue #588 represents a critical UX and financial issue where the plugin's use of the Claude Agent SDK results in unexpected API charges for users who have an `ANTHROPIC_API_KEY` configured. The auto-discovery behavior, while useful for developers, creates a poor user experience for plugin users who expect their Claude Max subscription to cover all costs.

**Immediate Action Required:**
1. Release hotfix with warning message
2. Update documentation to clearly state API usage
3. Change default provider to free tier (gemini)
4. Implement opt-in consent for Anthropic API usage

**The fix is straightforward, but the impact on user trust requires prompt action.**

---

## Appendix: Related Issues and Documentation

| Resource | Description |
|----------|-------------|
| [Claude Agent SDK Docs](https://docs.anthropic.com/claude/docs/agent-sdk) | SDK documentation |
| `docs/public/hooks-architecture.mdx` | Hooks and API key documentation |
| `docs/public/configuration.mdx` | Settings configuration reference |
| Issue #511 | Related: Gemini model support |
| Issue #527 | Related: Provider detection issues |

---

## Appendix: User Communication Template

**Suggested Announcement/Changelog Entry:**

```markdown
## Important Notice for v9.0.1

### API Key Usage Disclosure

Claude-mem uses AI for observation compression and session summaries.
If you have an `ANTHROPIC_API_KEY` configured (in ~/.anthropic/api_key,
environment variables, or project .env files), the plugin will use
Anthropic API credits for these operations.

**This is separate from your Claude Max subscription.**

### Changes in v9.0.1

- **Default provider changed to Gemini** (free tier available)
- **Warning displayed** when ANTHROPIC_API_KEY is detected
- **Opt-in required** to use Anthropic API for plugin operations

### For existing users

If you experienced unexpected charges:
1. Check your provider setting: `~/.claude-mem/settings.json`
2. Set `CLAUDE_MEM_PROVIDER` to `"gemini"` for free operation
3. Or remove/unset `ANTHROPIC_API_KEY` if not needed for other tools

We apologize for any confusion or unexpected charges caused by this behavior.
```
