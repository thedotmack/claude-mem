---
name: knowledge-agent
description: Build and query AI-powered knowledge bases from claude-mem observations. Use when users want to create focused "brains" from their observation history, ask questions about past work patterns, or compile expertise on specific topics.
---

# Knowledge Agent

Build and query AI-powered knowledge bases from claude-mem observations.

## What Are Knowledge Agents?

Knowledge agents are filtered corpora of observations compiled into a conversational AI session. Build a corpus from your observation history, prime it (loads the knowledge into an AI session), then ask it questions conversationally.

Think of them as custom "brains": "everything about hooks", "all decisions from the last month", "all bugfixes for the worker service".

## Workflow

### Step 1: Build a corpus

```text
build_corpus name="hooks-expertise" description="Everything about the hooks lifecycle" project="claude-mem" concepts="hooks" limit=500
```

Filter options:
- `project` — filter by project name
- `types` — comma-separated: decision, bugfix, feature, refactor, discovery, change
- `concepts` — comma-separated concept tags
- `files` — comma-separated file paths (prefix match)
- `query` — semantic search query
- `dateStart` / `dateEnd` — ISO date range
- `limit` — max observations (default 500)

### Step 2: Prime the corpus

```text
prime_corpus name="hooks-expertise"
```

This creates an AI session loaded with all the corpus knowledge. Takes a moment for large corpora.

### Step 3: Query

```text
query_corpus name="hooks-expertise" question="What are the 5 lifecycle hooks and when does each fire?"
```

The knowledge agent answers from its corpus. Follow-up questions maintain context.

### Step 4: List corpora

```text
list_corpora
```

Shows all corpora with stats and priming status.

## Tips

- **Focused corpora work best** — "hooks architecture" beats "everything ever"
- **Prime once, query many times** — the session persists across queries
- **Reprime for fresh context** — if the conversation drifts, reprime to reset
- **Rebuild to update** — when new observations are added, rebuild then reprime

## Maintenance

### Rebuild a corpus (refresh with new observations)

```text
rebuild_corpus name="hooks-expertise"
```

After rebuilding, reprime to load the updated knowledge:

### Reprime (fresh session)

```text
reprime_corpus name="hooks-expertise"
```

Clears prior Q&A context and reloads the corpus into a new session.
