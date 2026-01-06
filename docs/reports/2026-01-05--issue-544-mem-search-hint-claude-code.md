# Investigation Report: Issue #544 - mem-search Skill Hint Shown to Claude Code Users

**Date:** 2026-01-05
**Issue:** https://github.com/thedotmack/claude-mem/issues/544
**Author:** m.woelk (@neifgmbh)
**Status:** Open

---

## Issue Summary

The context footer displayed to users includes the message:

> "Use the mem-search skill to access memories by ID instead of re-reading files."

This hint is misleading because:
1. **For Claude Code users**: The "mem-search skill" terminology is confusing. In Claude Code, memory search is available through **MCP tools** (`search`, `timeline`, `get_observations`), not a "skill"
2. **For all users**: The skill directories in `plugin/skills/` are empty - no SKILL.md files exist

A second user (@niteeshm) confirmed the issue with "+1 the mem-search skill is missing."

---

## Code Location Verification

### Confirmed Locations

The message appears in **two formatters** and is rendered via **FooterRenderer.ts**:

#### 1. MarkdownFormatter.ts (line 228-234)

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/context/formatters/MarkdownFormatter.ts`

```typescript
export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`
  ];
}
```

#### 2. ColorFormatter.ts (line 225-231)

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/context/formatters/ColorFormatter.ts`

```typescript
export function renderColorFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `${colors.dim}Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${colors.reset}`
  ];
}
```

#### 3. Additional References in Context Instructions

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/context/formatters/MarkdownFormatter.ts` (lines 70-79)

```typescript
export function renderMarkdownContextIndex(): string[] {
  return [
    `**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`,
    '',
    `When you need implementation details, rationale, or debugging context:`,
    `- Use the mem-search skill to fetch full observations on-demand`,
    `- Critical types ( bugfix, decision) often need detailed fetching`,
    `- Trust this index over re-reading code for past decisions and learnings`,
    ''
  ];
}
```

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/context/formatters/ColorFormatter.ts` (lines 72-81)

```typescript
export function renderColorContextIndex(): string[] {
  return [
    `${colors.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${colors.reset}`,
    '',
    `${colors.dim}When you need implementation details, rationale, or debugging context:${colors.reset}`,
    `${colors.dim}  - Use the mem-search skill to fetch full observations on-demand${colors.reset}`,
    ...
  ];
}
```

#### 4. Footer Rendering Logic

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/context/sections/FooterRenderer.ts`

```typescript
export function renderFooter(
  economics: TokenEconomics,
  config: ContextConfig,
  useColors: boolean
): string[] {
  // Only show footer if we have savings to display
  if (!shouldShowContextEconomics(config) || economics.totalDiscoveryTokens <= 0 || economics.savings <= 0) {
    return [];
  }

  if (useColors) {
    return Color.renderColorFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
  }
  return Markdown.renderMarkdownFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
}
```

---

## Environment Detection Analysis

### Current State: No Detection Exists

**Finding:** Claude-mem does **NOT** currently differentiate between Claude Code and Claude Desktop environments.

**Evidence:**
1. Searched entire `src/` directory for environment detection patterns:
   - `claude.?code`, `claude.?desktop`, `isClaudeCode`, `isClaudeDesktop`, `environment`
   - Found 22 files, but none contain Claude Code vs Claude Desktop detection logic

2. Hook input analysis (`SessionStartInput` in `context-hook.ts`):
   ```typescript
   export interface SessionStartInput {
     session_id: string;
     transcript_path: string;
     cwd: string;
     hook_event_name?: string;
   }
   ```
   No environment identifier is passed to hooks.

3. The `ContextConfig` type has no environment field:
   ```typescript
   export interface ContextConfig {
     totalObservationCount: number;
     fullObservationCount: number;
     sessionCount: number;
     showReadTokens: boolean;
     showWorkTokens: boolean;
     // ... no environment field
   }
   ```

### Why Detection Would Be Difficult

Claude Code and Claude Desktop both:
- Use the same plugin system (hooks)
- Use the same MCP server configuration
- Receive the same hook input structure

**Potential Detection Methods:**
1. **Process name/parent** - Check if running under "claude-code" or "Claude Desktop" process
2. **Environment variables** - Claude may set different env vars (needs research)
3. **MCP config location** - Different config paths for each client
4. **User agent/client header** - If available in MCP protocol

---

## Skill Availability Analysis

### What Actually Exists

#### Claude Code MCP Tools (via `.mcp.json`)

**File:** `/Users/alexnewman/Scripts/claude-mem/plugin/.mcp.json`
```json
{
  "mcpServers": {
    "mcp-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"
    }
  }
}
```

**Available MCP Tools** (from `mcp-server.ts`):
1. `search` - Step 1: Search memory index
2. `timeline` - Step 2: Get context around results
3. `get_observations` - Step 3: Fetch full details by IDs
4. `__IMPORTANT` - Workflow documentation

**These tools ARE available in Claude Code** via MCP protocol.

#### Claude Desktop Setup (Manual)

From documentation (`docs/public/usage/claude-desktop.mdx`):
- Requires manual MCP server configuration in `claude_desktop_config.json`
- Uses the same MCP server and tools as Claude Code
- Documentation refers to this as the "mem-search skill"

#### Plugin Skills Directory (Empty)

**Path:** `/Users/alexnewman/Scripts/claude-mem/plugin/skills/`

```
skills/
  claude-mem-settings/  (empty)
  mem-search/
    operations/  (empty)
    principles/  (empty)
  search/
    operations/  (empty)
  troubleshoot/
    operations/  (empty)
```

**Finding:** All skill directories are empty - no `SKILL.md` files exist.

### Terminology Confusion

| What Users See | What Actually Exists |
|---------------|---------------------|
| "mem-search skill" | MCP tools (`search`, `timeline`, `get_observations`) |
| "skill" | Empty directory structures in `plugin/skills/` |
| "skill to fetch observations" | `get_observations` MCP tool |

**The "skill" terminology is a legacy artifact** from an earlier architecture. The current system uses MCP tools, not skills.

---

## Root Cause

1. **Legacy Terminology**: The footer message uses "skill" language from a previous architecture
2. **Architecture Evolution**: The search system migrated from skill-based to MCP-based (documented in `search-architecture.mdx`):
   > "Skill approach... was removed in favor of streamlined MCP architecture"
3. **Incomplete Migration**: The message text was not updated when the architecture changed
4. **No Skill Files**: The skill directories exist but contain no SKILL.md files

---

## Proposed Fix Options

### Option 1: Update Message to Reference MCP Tools (Recommended)

**Change the message to accurately describe the MCP tools:**

**Before:**
> "Use the mem-search skill to access memories by ID instead of re-reading files."

**After:**
> "Use MCP search tools (search, timeline, get_observations) to access memories by ID."

**Files to modify:**
- `src/services/context/formatters/MarkdownFormatter.ts` (lines 75, 232)
- `src/services/context/formatters/ColorFormatter.ts` (lines 77, 229)

**Pros:**
- Accurate for both Claude Code and Claude Desktop
- No environment detection needed
- Simple change

**Cons:**
- Longer message
- Users need to know about MCP tools

### Option 2: Remove the Hint Entirely

**Simply remove the "Use the mem-search skill..." portion of the message.**

**Before:**
> "Access 5k tokens of past research & decisions for just 1,234t. Use the mem-search skill to access memories by ID instead of re-reading files."

**After:**
> "Access 5k tokens of past research & decisions for just 1,234t."

**Files to modify:**
- `src/services/context/formatters/MarkdownFormatter.ts` (lines 75, 232)
- `src/services/context/formatters/ColorFormatter.ts` (lines 77, 229)

**Pros:**
- Simplest fix
- No confusion about terminology
- Cleaner footer

**Cons:**
- Loses the helpful hint about memory search
- Users may not know about MCP tools

### Option 3: Conditional Message Based on Environment Detection

**Implement environment detection and show different messages:**

```typescript
export function renderFooter(economics: TokenEconomics, config: ContextConfig, useColors: boolean): string[] {
  const isClaudeCode = detectClaudeCodeEnvironment();
  const searchHint = isClaudeCode
    ? "Use MCP search tools to access memories by ID."
    : "Use the mem-search skill to access memories by ID.";
  // ...
}
```

**Files to modify:**
- Create new utility: `src/utils/environment-detection.ts`
- `src/services/context/sections/FooterRenderer.ts`
- `src/services/context/formatters/MarkdownFormatter.ts`
- `src/services/context/formatters/ColorFormatter.ts`

**Pros:**
- Context-appropriate messaging
- Maintains helpful hint

**Cons:**
- Complex to implement
- May be fragile (environment detection methods could break)
- More maintenance burden
- Unclear how to reliably detect environment

### Option 4: Implement Actual Skills for Claude Code

**Create SKILL.md files in `plugin/skills/mem-search/`:**

**Path:** `plugin/skills/mem-search/SKILL.md`
```markdown
---
name: mem-search
description: Search claude-mem memory database using MCP tools
---

# Memory Search

Use MCP tools to search your project memory...
```

**Pros:**
- Makes the message accurate
- Provides better user guidance
- Consistent with skill-based architecture

**Cons:**
- Skills may be deprecated in favor of MCP
- More files to maintain
- May confuse the architecture (skills wrapping MCP tools)

---

## Implementation Recommendation

**Recommended: Option 1 (Update Message to Reference MCP Tools)**

### Rationale

1. **Accuracy**: MCP tools are the actual mechanism, not skills
2. **Simplicity**: Single source of truth, no environment detection needed
3. **Documentation Alignment**: Matches the architecture documentation
4. **Low Risk**: Minimal code changes, no new systems

### Specific Changes

#### MarkdownFormatter.ts

**Line 75** (Context Index section):
```typescript
// Before:
`- Use the mem-search skill to fetch full observations on-demand`,

// After:
`- Use MCP tools (search, get_observations) to fetch full observations on-demand`,
```

**Lines 228-234** (Footer):
```typescript
export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.`
  ];
}
```

#### ColorFormatter.ts

**Line 77** (Context Index section):
```typescript
// Before:
`${colors.dim}  - Use the mem-search skill to fetch full observations on-demand${colors.reset}`,

// After:
`${colors.dim}  - Use MCP tools (search, get_observations) to fetch full observations on-demand${colors.reset}`,
```

**Lines 225-231** (Footer):
```typescript
export function renderColorFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `${colors.dim}Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.${colors.reset}`
  ];
}
```

### Testing

1. Rebuild plugin: `npm run build-and-sync`
2. Restart Claude Code
3. Verify footer message appears correctly
4. Verify context index instructions appear correctly

---

## Additional Considerations

### Empty Skill Directories

The empty `plugin/skills/` directories should be addressed separately:
- Either remove them (if skills are deprecated)
- Or populate them with SKILL.md files (if skills are still supported)

This is a **separate issue** from the message text.

### Documentation Updates

If Option 1 is implemented, documentation should also be reviewed:
- `docs/public/usage/claude-desktop.mdx` references "mem-search skill"
- `README.md` mentions "Skill-Based Search"
- Various i18n README files

Consider creating a follow-up issue for documentation consistency.

---

## Summary

| Aspect | Finding |
|--------|---------|
| **Issue Valid?** | Yes - message is misleading |
| **Location Verified?** | Yes - 4 locations in 2 formatters |
| **Environment Detection?** | Does not exist |
| **Skill Files?** | Empty directories, no SKILL.md |
| **MCP Tools Available?** | Yes - in both Claude Code and Desktop |
| **Recommended Fix** | Option 1: Update message to reference MCP tools |
| **Complexity** | Low - 4 string changes |
| **Risk** | Low - cosmetic text change |

---

*Report prepared for GitHub Issue #544*
