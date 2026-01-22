# Plan: Introduce `/recall` Skill for Reliable Memory Retrieval

## Problem Statement

Claude-mem has a sophisticated 3-layer memory retrieval system (search → timeline → get_observations) designed for token efficiency. However, this complexity creates friction:

1. **MCP tools don't get used naturally** - Claude reaches for skills more readily than MCP tools
2. **Tool name mismatch** - Context injection says "use MCP tools (search, get_observations)" but actual names are `mcp__plugin_claude-mem_mcp-search__*`
3. **No clear trigger** - Skills have explicit "when to use" guidance; MCP tools lack this
4. **3-step workflow is friction** - Having to orchestrate 3 tools to do one conceptual thing (recall something) reduces usage

## Solution: `/recall` Skill

A single, simple skill that wraps the 3-layer workflow:

```
/recall How did we fix the Windows popup issue?
```

The skill internally handles the token-efficient workflow while presenting a simple interface.

---

## Implementation Plan

### Phase 1: Create Worker API Endpoint

**File:** `src/services/worker/routes/RecallRoute.ts` (new)

Create a new endpoint that combines search + auto-fetch:

```
GET /api/recall?query=<query>&limit=5&project=<project>
```

**Logic:**
1. Call existing `search()` with the query
2. Extract top N observation IDs from results
3. Fetch full observation details for those IDs
4. Return formatted, ready-to-use context

**Why a new endpoint?** The existing endpoints return either indexes (search) or require IDs (get_observations). We need one that does both in sequence.

**Key files to reference:**
- `src/services/worker/SearchManager.ts:123-357` - existing search() method
- `src/services/worker/SearchManager.ts:362-634` - existing timeline() method
- `src/services/server/Server.ts` - route registration pattern

---

### Phase 2: Create `/recall` Command

**File:** `plugin/commands/recall.md` (new)

```yaml
---
description: "Recall past work, decisions, and context from memory"
argument-hint: "[topic or question]"
---

You have persistent memory across sessions. Use this to recall:
- Past decisions and their rationale
- How problems were solved before
- Context about files, features, or bugs
- What was learned from previous work

## How to Execute

Call the recall API:

```bash
curl -s "http://127.0.0.1:37777/api/recall?query=$ARGUMENTS&limit=5"
```

## What You Get Back

Full observation details including:
- **Title** - What this memory is about
- **Narrative** - Full context and details
- **Type** - decision, bugfix, learning, change, etc.
- **Date** - When this was recorded
- **Files** - Related files

## Example Usage

User asks: "How did we handle the rate limiting issue?"
→ Call `/api/recall?query=rate limiting`
→ Get back full context about past rate limiting work
→ Use that context to help the user
```

---

### Phase 3: Update Context Injection Prompt

**Files to modify:**
- `src/services/context/formatters/MarkdownFormatter.ts:70-79`
- `src/services/context/formatters/ColorFormatter.ts` (equivalent section)

**Current text (lines 70-79):**
```typescript
export function renderMarkdownContextIndex(): string[] {
  return [
    `**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`,
    '',
    `When you need implementation details, rationale, or debugging context:`,
    `- Use MCP tools (search, get_observations) to fetch full observations on-demand`,
    `- Critical types ( bugfix, decision) often need detailed fetching`,
    `- Trust this index over re-reading code for past decisions and learnings`,
    ''
  ];
}
```

**New text:**
```typescript
export function renderMarkdownContextIndex(): string[] {
  return [
    `**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`,
    '',
    `**Memory Retrieval:** When you need details, rationale, or past context:`,
    `- Use \`/recall [topic]\` to recall relevant memories`,
    `- Example: \`/recall how we fixed the auth bug\``,
    `- Trust your memory over re-reading code for past decisions`,
    '',
    `You may sometimes lose context or struggle with tasks you've done before.`,
    `When this happens, use /recall - your memory can help.`,
    ''
  ];
}
```

---

### Phase 4: Update Footer Message

**File:** `src/services/context/formatters/MarkdownFormatter.ts:228-233`

**Current:**
```typescript
export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.`
  ];
}
```

**New:**
```typescript
export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `${workTokensK}k tokens of past work available. Use \`/recall [topic]\` to recall details.`
  ];
}
```

---

## Token Efficiency Preserved

The `/recall` skill maintains the 3-layer efficiency internally:

```
User: /recall auth bug fix

Skill execution:
1. search("auth bug fix") → Returns IDs [#123, #456, #789] (~100 tokens)
2. get_observations([123, 456, 789]) → Fetches only top 3-5 (~1500 tokens)
3. Return formatted context to Claude

Total: ~1600 tokens instead of loading all memory
```

The MCP tools remain available for power users who want fine-grained control:
- `search` - Get index with IDs
- `timeline` - Get context around a result
- `get_observations` - Fetch specific IDs

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/services/worker/routes/RecallRoute.ts` | NEW - API endpoint |
| `src/services/server/Server.ts` | Register new route |
| `plugin/commands/recall.md` | NEW - Slash command |
| `src/services/context/formatters/MarkdownFormatter.ts` | Update prompts |
| `src/services/context/formatters/ColorFormatter.ts` | Update prompts (same changes) |

---

## Verification Checklist

- [ ] `/api/recall?query=test` returns formatted observations
- [ ] `/recall test topic` skill executes and returns results
- [ ] Context injection mentions `/recall` instead of MCP tools
- [ ] MCP tools still work for advanced users
- [ ] Token usage is efficient (not loading entire memory)

---

## Anti-Patterns to Avoid

1. **Don't remove MCP tools** - Keep them for power users and programmatic access
2. **Don't load all observations** - Maintain the filter-first approach
3. **Don't make the skill complex** - Keep it simple: query in, context out
4. **Don't over-engineer** - Start simple, iterate based on usage

---

## Branch Name

`feature/recall-skill`

## PR Title

"feat: introduce /recall skill for reliable memory retrieval"
