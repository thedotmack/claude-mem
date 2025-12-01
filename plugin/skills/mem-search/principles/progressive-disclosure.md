# Progressive Disclosure Pattern (MANDATORY)

**Core Principle**: Find the smallest set of high-signal tokens first (index format), then drill down to full details only for relevant items.

## The 4-Step Workflow

### Step 1: Start with Index Format

**Action:**
- Use `format=index` (default in most operations)
- Set `limit=3-5` (not 20)
- Review titles and dates ONLY

**Token Cost:** ~50-100 tokens per result

**Why:** Minimal token investment for maximum signal. Get overview before committing to full details.

**Example:**
```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
```

**Response:**
```json
{
  "query": "authentication",
  "count": 5,
  "format": "index",
  "results": [
    {
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "subtitle": "Added token-based auth with refresh tokens",
      "created_at_epoch": 1699564800000,
      "project": "api-server"
    }
  ]
}
```

### Step 2: Identify Relevant Items

**Cognitive Task:**
- Scan index results for relevance
- Note which items need full details
- Discard irrelevant items

**Why:** Human-in-the-loop filtering before expensive operations. Don't load full details for items you'll ignore.

### Step 3: Request Full Details (Selectively)

**Action:**
- Use `format=full` ONLY for specific items of interest
- Target by ID or use refined search query

**Token Cost:** ~500-1000 tokens per result

**Principle:** Load only what you need

**Example:**
```bash
# After reviewing index, get full details for observation #1234
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=full&limit=1&offset=2"
```

**Why:** Targeted token expenditure with high ROI. 10x cost difference means selectivity matters.

### Step 4: Refine with Filters (If Needed)

**Techniques:**
- Use `type`, `dateStart`/`dateEnd`, `concepts`, `files` filters
- Narrow scope BEFORE requesting more results
- Use `offset` for pagination instead of large limits

**Why:** Reduce result set first, then expand selectively. Don't load 20 results when filters could narrow to 3.

## Token Budget Awareness

**Costs:**
- Index result: ~50-100 tokens
- Full result: ~500-1000 tokens
- 10x cost difference

**Starting Points:**
- Start with `limit=3-5` (not 20)
- Reduce limit if hitting token errors

**Savings Example:**
- Naive: 10 items × 750 tokens (avg full) = 7,500 tokens
- Progressive: (5 items × 75 tokens index) + (2 items × 750 tokens full) = 1,875 tokens
- **Savings: 5,625 tokens (75% reduction)**

## What Problems This Solves

1. **Token exhaustion**: Without this, LLMs load everything in full format (9,000+ tokens for 10 items)
2. **Poor signal-to-noise**: Loading full details for irrelevant items wastes tokens
3. **MCP limits**: Large payloads hit protocol limits (system failures)
4. **Inefficiency**: Loading 20 full results when only 2 are relevant

## How It Scales

**With 10 records:**
- Index (500 tokens) → Full (2,000 tokens for 2 relevant) = 2,500 tokens
- Without pattern: Full (10,000 tokens for all 10) = 4x more expensive

**With 1,000 records:**
- Index (500 tokens for top 5) → Full (1,000 tokens for 1 relevant) = 1,500 tokens
- Without pattern: Would hit MCP limits before seeing relevant data

## Context Engineering Alignment

This pattern implements core context engineering principles:

- **Just-in-time context**: Load data dynamically at runtime
- **Progressive disclosure**: Lightweight identifiers (index) → full details as needed
- **Token efficiency**: Minimal high-signal tokens first, expand selectively
- **Attention budget**: Treat context as finite resource with diminishing returns

Always start with the smallest set of high-signal tokens that maximize likelihood of desired outcome.
