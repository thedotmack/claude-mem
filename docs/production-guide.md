# claude-mem Production Guide

Practical guide based on 23 days of production usage with 3,400+ observations across two physical servers and 8 projects.

## Recommended Settings

| Setting | Default | Recommended | Why |
|---------|---------|-------------|-----|
| CLAUDE_MEM_MAX_CONCURRENT_AGENTS | 2 | 3 | Better throughput without overload |
| CLAUDE_MEM_SEMANTIC_INJECT | true | true | Relevant context >> recent context |
| CLAUDE_MEM_SEMANTIC_INJECT_LIMIT | 5 | 5 | Sweet spot for token cost vs coverage |
| CLAUDE_MEM_TIER_ROUTING_ENABLED | true | true | ~52% cost savings, no quality loss |

## Health Monitoring

### Key metrics to watch

| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| pending_messages (pending) | 0-5 | >10 | Check worker logs, may need restart |
| pending_messages (failed) | 0 | >0 growing | Circuit-breaker may be tripping |
| sdk_sessions (active) | 0-3 | >5 stuck | Orphan sessions, worker restart |
| WAL size | <10 MB | >20 MB | Run `PRAGMA wal_checkpoint(TRUNCATE)` |
| Chroma size | Growing slowly | Sudden jump | Check for sync loops |
| Errors/day in logs | 0-2 | >10 | Investigate log patterns |

### Quick health check

```bash
# Check worker status
curl -s http://127.0.0.1:37777/api/health | python3 -m json.tool

# Check database stats
sqlite3 ~/.claude-mem/claude-mem.db "
  SELECT 'observations' as metric, COUNT(*) as value FROM observations
  UNION ALL SELECT 'summaries', COUNT(*) FROM session_summaries
  UNION ALL SELECT 'pending', COUNT(*) FROM pending_messages WHERE status='pending'
  UNION ALL SELECT 'active_sessions', COUNT(*) FROM sdk_sessions WHERE status='active';
"
```

## Multi-Machine Setup

If running claude-mem on multiple machines, use `claude-mem-sync` to keep observations in sync:

```bash
claude-mem-sync push <remote-host>    # local -> remote
claude-mem-sync pull <remote-host>    # remote -> local
claude-mem-sync sync <remote-host>    # bidirectional
claude-mem-sync status <remote-host>  # compare counts
```

Deduplication is by `(created_at, title)` — safe to run repeatedly.

## Growth Expectations

Based on active daily development usage:

| Metric | Per day | Per month | Notes |
|--------|---------|-----------|-------|
| Observations | ~120 | ~3,600 | Varies with coding activity |
| Summaries | ~40 | ~1,200 | One per session |
| SQLite | ~0.8 MB | ~24 MB | ~5 KB per observation |
| Chroma | ~4 MB | ~120 MB | ~50 KB per observation (embeddings) |

## Common Issues and Solutions

### Summarize error loop

**Symptom:** Repeated `[ERROR] Missing last_assistant_message` in logs.
**Cause:** Transcript with no assistant messages triggers summary attempt that fails repeatedly.
**Fix:** PR #1566 — skip summary when transcript is empty.

### Chroma sync failures

**Symptom:** `[ERROR] Batch add failed... IDs already exist`
**Cause:** MCP timeout during add leaves partial writes; retry fails on existing IDs.
**Fix:** PR #1566 — fallback to delete+add reconciliation.

### Port conflict on startup

**Symptom:** `Worker failed to start... Is port 37777 in use?`
**Cause:** Two sessions starting simultaneously — HTTP check is non-atomic (TOCTOU race).
**Fix:** PR #1566 — atomic socket bind on Unix.

### Orphaned pending messages

**Symptom:** `pending_messages` table growing with old entries for completed sessions.
**Cause:** SIGTERM kills generator before queue is drained.
**Fix:** PR #1567 — drain after deleteSession().

### Context not relevant to current topic

**Symptom:** Claude receives observations about CSS when you're asking about authentication.
**Cause:** Default recency-based injection selects most recent, not most relevant.
**Fix:** PR #1568 — semantic injection via Chroma on every prompt.

## Log Analysis Tips

```bash
# Count errors by day
grep '\[ERROR\]' ~/.claude-mem/logs/claude-mem-*.log | \
  sed 's/\[20[0-9][0-9]-[0-9][0-9]-/\n&/g' | \
  grep -oP '^\[20\d{2}-\d{2}-\d{2}' | sort | uniq -c

# Find circuit-breaker trips
grep 'circuit\|Circuit\|ABANDONED\|abandoned' ~/.claude-mem/logs/claude-mem-*.log

# Check pending message health
grep 'CLAIMED\|CONFIRMED\|FAILED\|ABANDONED' ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log | tail -20
```
