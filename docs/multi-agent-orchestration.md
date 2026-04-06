# Multi-Agent Task Orchestration Patterns

Patterns for coordinating multiple Claude Code agents through a single orchestrator, preventing conflicts and ensuring quality.

## Problem

When running multiple Claude Code agents on the same codebase:
- Agents duplicate each other's work
- Two agents modify the same file simultaneously
- Agent claims "done" without verifiable proof
- No audit trail of who did what

## Solution: Single Orchestrator Pattern

One agent receives all tasks and routes them to specialists. It never does specialized work itself.

### Identity Boundaries

Define what the orchestrator IS and IS NOT:

```markdown
You are the Task Orchestrator. You NEVER do specialized work yourself.

WHAT YOU ARE NOT:
- NOT a code writer (delegate to code agents)
- NOT a security auditor (delegate to security agents)
- NOT a researcher (delegate to research agents)
```

This "NOT-block" pattern reduces task drift by keeping the orchestrator focused on routing.

### Anti-Duplication Registry

Before assigning work, check for conflicts:

```python
from difflib import SequenceMatcher
import sqlite3

def check_duplicate(description, threshold=0.55):
    conn = sqlite3.connect("task_registry.db")
    c = conn.cursor()
    c.execute(
        "SELECT id, description, agent, status FROM tasks "
        "WHERE status IN ('pending', 'in_progress')"
    )
    for row in c.fetchall():
        ratio = SequenceMatcher(
            None, description.lower(), row[1].lower()
        ).ratio()
        if ratio >= threshold:
            return {"conflict": True, "task_id": row[0], "agent": row[2]}
    return {"conflict": False}
```

The 55% threshold catches near-duplicates ("fix login bug" vs "fix authentication bug") without false positives on unrelated tasks.

### Keyword-Based Routing

Match tasks to agents without embeddings:

```python
AGENTS = {
    "code-architect":    ["code", "implement", "bug", "fix", "refactor"],
    "security-reviewer": ["security", "vulnerability", "audit", "cve"],
    "test-engineer":     ["test", "coverage", "unittest", "spec"],
}

def route_task(description):
    scores = {}
    for agent, keywords in AGENTS.items():
        scores[agent] = sum(
            1 for kw in keywords if kw in description.lower()
        )
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "code-architect"
```

### Quality Gates

Agent output is a **claim**. Test output is **evidence**.

After an agent reports completion:

1. **File changes exist** - `git diff --stat` must show modifications
2. **Tests pass** - run the relevant test suite
3. **No secrets leaked** - scan changed files for API keys and tokens
4. **Build succeeds** - confirm the project compiles
5. **Scope respected** - only expected files were modified

Mark done ONLY after all checks pass.

### 30-Minute Heartbeat

```text
Every 30 minutes:
1. Check registry for stale assignments (>30 min without update)
2. Follow up with idle agents or reassign their tasks
3. If nothing delegated recently, pull next task from backlog
```

## Delegation Format

```text
[ORCHESTRATOR -> agent-name] TASK: [description]
SCOPE: [files/directories allowed]
VERIFICATION: [command to prove completion]
DEADLINE: [timeframe]
```

## Results

Tested across 10,000+ tasks over 6 months with 57 specialized agents:
- Anti-duplication catches ~12% of incoming tasks as near-duplicates
- Quality gates reject ~8% of "done" claims that lack evidence
- 30-minute heartbeat prevents task stagnation

## Further Reading

- [guardian-agent-prompts](https://github.com/milkomida77/guardian-agent-prompts) - Open-source collection of 57 production agent system prompts
