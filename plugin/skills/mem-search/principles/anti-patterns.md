# Anti-Pattern Catalogue

Common mistakes to avoid when using the HTTP search API. These anti-patterns address LLM training biases and prevent token-wasting behaviors.

## Anti-Pattern 1: Skipping Index Format

**The Mistake:**
```bash
# ❌ Bad: Jump straight to full format
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=full&limit=20"
```

**Why It's Wrong:**
- 20 × 750 tokens = 15,000 tokens
- May hit MCP token limits
- 99% wasted on irrelevant results

**The Correction:**
```bash
# ✅ Good: Start with index, review, then request full selectively
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
# Review results, identify relevant items
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=full&limit=1&offset=2"
```

**What It Teaches:**
Progressive disclosure isn't optional - it's essential for scale.

**LLM Behavior Insight:**
LLMs trained on code examples may have seen `format=full` as "more complete" and default to it.

---

## Anti-Pattern 2: Over-Requesting Results

**The Mistake:**
```bash
# ❌ Bad: Request limit=20 without reviewing index first
curl -s "http://localhost:37777/api/search/observations?query=auth&format=index&limit=20"
```

**Why It's Wrong:**
- Most of 20 results will be irrelevant
- Wastes tokens and time
- Overwhelms review process

**The Correction:**
```bash
# ✅ Good: Start small, paginate if needed
curl -s "http://localhost:37777/api/search/observations?query=auth&format=index&limit=5"
# If needed, paginate:
curl -s "http://localhost:37777/api/search/observations?query=auth&format=index&limit=5&offset=5"
```

**What It Teaches:**
Start small (limit=3-5), review, paginate if needed.

**LLM Behavior Insight:**
LLMs may think "more results = more thorough" without considering relevance.

---

## Anti-Pattern 3: Ignoring Tool Specialization

**The Mistake:**
```bash
# ❌ Bad: Use generic search for everything
curl -s "http://localhost:37777/api/search/observations?query=bugfix&format=index&limit=10"
```

**Why It's Wrong:**
- Specialized tools (by-type, by-concept, by-file) are more efficient
- Generic search mixes all result types
- Misses filtering optimization

**The Correction:**
```bash
# ✅ Good: Use specialized endpoint when applicable
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=index&limit=10"
```

**What It Teaches:**
The decision tree exists for a reason - follow it.

**LLM Behavior Insight:**
LLMs may gravitate toward "general purpose" tools to avoid decision-making.

---

## Anti-Pattern 4: Loading Full Context Prematurely

**The Mistake:**
```bash
# ❌ Bad: Request full format before understanding what's relevant
curl -s "http://localhost:37777/api/search/observations?query=database&format=full&limit=10"
```

**Why It's Wrong:**
- Can't filter relevance without seeing index first
- Wastes tokens on irrelevant full details
- 10 × 750 = 7,500 tokens for potentially zero useful results

**The Correction:**
```bash
# ✅ Good: Index first to identify relevance
curl -s "http://localhost:37777/api/search/observations?query=database&format=index&limit=10"
# Identify relevant: #1234 and #1250
curl -s "http://localhost:37777/api/search/observations?query=database+1234&format=full&limit=1"
curl -s "http://localhost:37777/api/search/observations?query=database+1250&format=full&limit=1"
```

**What It Teaches:**
Filtering is a prerequisite for expansion.

**LLM Behavior Insight:**
LLMs may try to "get everything at once" to avoid multiple tool calls.

---

## Anti-Pattern 5: Not Using Timeline Tools

**The Mistake:**
```bash
# ❌ Bad: Search for individual observations separately
curl -s "http://localhost:37777/api/search/observations?query=before+deployment"
curl -s "http://localhost:37777/api/search/observations?query=during+deployment"
curl -s "http://localhost:37777/api/search/observations?query=after+deployment"
```

**Why It's Wrong:**
- Misses context around events
- Inefficient (N searches vs 1 timeline)
- Temporal relationships lost

**The Correction:**
```bash
# ✅ Good: Use timeline tool for contextual investigation
curl -s "http://localhost:37777/api/timeline/by-query?query=deployment&depth_before=10&depth_after=10"
```

**What It Teaches:**
Tool composition - some tools are designed to work together.

**LLM Behavior Insight:**
LLMs may not naturally discover tool composition patterns.

---

## Why These Anti-Patterns Matter

**Addresses LLM Training Bias:**
LLMs default to "load everything" behavior from web scraping training data where thoroughness was rewarded.

**Teaches Protocol Awareness:**
HTTP APIs and MCP have real token limits that can break the system.

**Prevents User Frustration:**
Token limit errors confuse users and break workflows.

**Builds Good Habits:**
Anti-patterns teach the "why" behind best practices.

**Makes Implicit Explicit:**
Surfaces mental models that experienced users internalize but novices miss.

---

## What Happens If These Are Ignored

- **No progressive disclosure**: Every search loads limit=20 in full format → token exhaustion
- **Over-requesting**: 15,000 token searches for 2 relevant results
- **Wrong tool**: Generic search when specialized filters would be 10x faster
- **Premature expansion**: Load full details before knowing relevance
- **Missing composition**: Single-tool thinking, missing powerful multi-step workflows

**Bottom Line:** These anti-patterns waste 5-10x more tokens than necessary and frequently cause system failures.
