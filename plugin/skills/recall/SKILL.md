---
name: recall
description: This skill should be used when the user asks about past work, previous decisions, how something was fixed, what was the approach for a task, or when Claude needs context from previous sessions. Use this skill when encountering questions like "How did we fix X?", "What was our approach for Y?", "Why did we decide Z?", or when feeling uncertain about context that should be available from past work.
version: 1.0.0
---

# Memory Recall for Claude Code

You have persistent memory across sessions. This skill helps you recall past work efficiently using a token-efficient 2-step workflow.

## When to Use This Skill

- User asks about past work ("How did we fix X?", "What was the approach for Y?")
- You're struggling with a task you may have done before
- You need context about a feature, bug, or decision
- You want to avoid repeating past mistakes
- User references something from a previous session
- You feel like you're missing context that you should have

## How to Execute (2-Step Workflow)

### Step 1: Search for relevant memories

```bash
curl -s "http://127.0.0.1:37777/api/search?query=<topic>&limit=15"
```

Replace `<topic>` with the search terms based on what the user is asking about.

This returns an **index** of matching observations with:
- **ID** - The observation ID (you'll need this for step 2)
- **Title** - What this memory is about
- **Type** - decision, bugfix, discovery, change, etc.
- **Date** - When this was recorded

### Step 2: Decide which are relevant, then fetch

Look at the search results. Based on your current conversation context, decide which observations are most relevant to what the user needs.

Then fetch the full details for just those IDs:

```bash
curl -s "http://127.0.0.1:37777/api/recall?ids=123,456,789"
```

Replace `123,456,789` with the actual IDs you selected.

## Why This 2-Step Process?

You have access to thousands of memories. Loading all of them would be wasteful. Instead:
1. Search gives you a quick index (~100 tokens per result)
2. You use your judgment to pick the relevant ones
3. Fetch gives you full details (~500 tokens per result)

This keeps token usage efficient while letting you make informed choices about what context you actually need.

## Example

User asks: "How did we handle the rate limiting issue?"

**Step 1 - Search:**
```bash
curl -s "http://127.0.0.1:37777/api/search?query=rate+limiting&limit=15"
```

Returns index like:
- #234: "Rate limiting middleware implementation" (bugfix, Dec 15)
- #567: "API rate limit configuration" (decision, Dec 10)
- #891: "Rate limit error handling" (change, Dec 12)
- #123: "Database rate limiting discussion" (discovery, Nov 20)

**Step 2 - Decide and fetch:**
The user asked about "handling" the issue, so #234 (bugfix) and #891 (error handling) look most relevant. #123 is about database which seems unrelated.

```bash
curl -s "http://127.0.0.1:37777/api/recall?ids=234,567,891"
```

Now you have full context to help the user.

## Installation Note

This skill is bundled with the claude-mem plugin. By default, plugin skills are namespaced:
- **As bundled**: `/claude-mem:recall`

For the shorter `/recall` command, copy this file to your personal skills directory:
```bash
mkdir -p ~/.claude/skills/recall
cp <plugin-path>/skills/recall/SKILL.md ~/.claude/skills/recall/
```
