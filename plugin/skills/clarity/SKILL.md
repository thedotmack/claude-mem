---
name: clarity
description: Resolve conflicting observations and establish ground truth. Called by mem-search when results are messy.
---

# Clarity

Resolve conflicting observations and establish ground truth on a topic.

## Purpose

You have search results with multiple observations on the same topic that conflict or are redundant. This skill helps you identify the authoritative source and clean up the noise.

## Input

You already have observations from mem-search. You're here because:
- Multiple observations say different things about the same topic
- Some observations are duplicates of others
- Some observations reference other observations (meta)

## Workflow

### Step 1: Fetch and Analyze

For each observation in your search results, fetch full details:
```bash
curl "http://localhost:37777/api/observation/12345"
```

Analyze each observation:
- **When was it created?** Older observations may be outdated
- **What does it say?** Compare content between observations
- **Is it a decision or discovery?** Decisions are more likely to be ground truth
- **Does it reference other observations?** Self-referential = meta_observation

### Step 2: Present Findings to User

Show the user:
1. Which observation is the **ground truth** (authoritative, most accurate)
2. Which are **duplicates** (same info, different words)
3. Which are **outdated** (superseded by newer decisions)
4. Which are **meta** (about the observation system itself)

Example output:
```
Found 5 observations about "search architecture":

GROUND TRUTH:
- #10633 [decision] "Architecture Guidelines for Search" (Nov 18)
  → Original decision establishing MCP as authoritative source

SUPERSEDED (recommend marking):
- #16724 [discovery] "MCP as Single Authoritative Search Source" (Nov 28)
  → Rediscovery of same info, superseded by #10633

META_OBSERVATION (recommend marking):
- #16792 [decision] "Observation 10633 establishes MCP..." (Nov 28)
  → References observation #10633, not about architecture itself
```

### Step 3: Get User Confirmation

Ask the user to confirm before making changes.

### Step 4: Apply Updates

Single update:
```bash
curl -X PATCH "http://localhost:37777/api/observation/16724/status" \
  -H "Content-Type: application/json" \
  -d '{"status": "superseded", "superseded_by": 10633}'
```

Batch update:
```bash
curl -X PATCH "http://localhost:37777/api/observations/batch-status" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {"observation_id": 16724, "status": "superseded", "superseded_by": 10633},
      {"observation_id": 16792, "status": "meta_observation"}
    ]
  }'
```

## Status Values

- `active` - Normal, shows in search (default)
- `meta_observation` - Self-referential (observations about observations)
- `superseded` - Replaced by newer observation (requires superseded_by link)
- `deprecated` - No longer valid/accurate

## Classification Guidelines

**Ground Truth:**
- Usually the oldest decision on a topic
- Contains the most complete/accurate information
- Referenced by other observations

**Superseded:**
- Later discoveries that rediscover the same thing
- Older decisions that were updated/corrected
- Always requires `superseded_by` pointing to ground truth

**Meta_observation:**
- Title contains "Observation #XXXX..."
- About the memory system itself, not the actual topic
- Testing/verification observations ("tested the API", "verified the endpoint")

**Deprecated:**
- Information that is no longer accurate
- Decisions that were reversed
- Does NOT require superseded_by (nothing replaced it, it's just wrong)

## Important

- **Always get user confirmation** before marking observations
- **Never auto-mark** based on patterns alone - human judgment required
- **Preserve ground truth** - when in doubt, keep it active
