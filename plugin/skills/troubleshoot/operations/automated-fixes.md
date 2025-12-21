# Automated Fix Sequences

One-command fix sequences for common claude-mem issues.

## Quick Fix: Complete Reset and Restart

**Use when:** General issues, worker not responding, after updates

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm run worker:stop; \
npm install && \
npm run worker:start && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

**Expected output:** `{"status":"ok"}`

**What it does:**
1. Stops the worker (if running)
2. Ensures dependencies are installed
3. Starts worker
4. Waits for startup
5. Verifies health

## Fix: Worker Not Running

**Use when:** Worker status shows it's not running

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm run worker:start && \
sleep 2 && \
npm run worker:status
```

**Expected output:** Worker running with PID and health OK

## Fix: Dependencies Missing

**Use when:** Worker won't start due to missing packages

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm install && \
claude-mem restart
```

## Fix: Stale PID File

**Use when:** Worker reports running but health check fails

```bash
rm -f ~/.claude-mem/worker.pid && \
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm run worker:start && \
sleep 2 && \
curl -s http://127.0.0.1:37777/health
```

**Expected output:** `{"status":"ok"}`

## Fix: Port Conflict

**Use when:** Error shows port already in use

```bash
# Change to port 37778
mkdir -p ~/.claude-mem && \
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json && \
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
claude-mem restart && \
sleep 2 && \
curl -s http://127.0.0.1:37778/health
```

**Expected output:** `{"status":"ok"}`

## Fix: Database Issues

**Use when:** Database appears corrupted or out of sync

```bash
# Backup and test integrity
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup && \
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;" && \
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
claude-mem restart
```

**If integrity check fails, recreate database:**
```bash
# WARNING: This deletes all memory data
mv ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.old && \
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
claude-mem restart
```

## Fix: Clean Reinstall

**Use when:** All else fails, nuclear option

```bash
# Backup data first
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup 2>/dev/null

# Stop worker
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:stop

# Clean PID file
rm -f ~/.claude-mem/worker.pid

# Reinstall dependencies
rm -rf node_modules && \
npm install

# Start worker
npm run worker:start && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

## Fix: Clear Old Logs

**Use when:** Want to start with fresh logs

```bash
# Archive old logs
tar -czf ~/.claude-mem/logs-archive-$(date +%Y-%m-%d).tar.gz ~/.claude-mem/logs/*.log 2>/dev/null

# Remove logs older than 7 days
find ~/.claude-mem/logs/ -name "worker-*.log" -mtime +7 -delete

# Restart worker for fresh log
cd ~/.claude/plugins/marketplaces/thedotmack/
claude-mem restart
```

**Note:** Logs auto-rotate daily, manual cleanup rarely needed.

## Verification Commands

**After running any fix, verify with these:**

```bash
# Check worker status
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:status

# Check health
curl -s http://127.0.0.1:37777/health

# Check database
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"

# Check viewer
curl -s http://127.0.0.1:37777/api/stats

# Check logs for errors
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -20
```

**All checks should pass:**
- Worker status: Shows PID and "Health: OK"
- Health endpoint: `{"status":"ok"}`
- Database: Shows count (may be 0 if new)
- Stats: Returns JSON with counts
- Logs: No recent errors

## One-Line Complete Diagnostic

**Quick health check:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && npm run worker:status && curl -s http://127.0.0.1:37777/health && echo " ✓ All systems OK"
```

## Troubleshooting the Fixes

**If automated fix fails:**
1. Run the diagnostic script from [diagnostics.md](diagnostics.md)
2. Check specific error in worker logs:
   ```bash
   tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
   ```
3. Try manual worker start to see detailed error:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   bun plugin/scripts/worker-service.js
   ```
4. Use the bug report tool:
   ```bash
   npm run bug-report
   ```

## Common Error Patterns and Fixes

| Error Pattern | Likely Cause | Quick Fix |
|---------------|--------------|-----------|
| `EADDRINUSE` | Port conflict | Change port in settings.json |
| `SQLITE_ERROR` | Database corruption | Run integrity check, recreate if needed |
| `ENOENT` | Missing files | Run `npm install` |
| `Module not found` | Dependency issue | Clean reinstall |
| Connection refused | Worker not running | `npm run worker:start` |
| Stale PID | Old PID file | Remove `~/.claude-mem/worker.pid` |
