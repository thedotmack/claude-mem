# Automated Fix Sequences

One-command fix sequences for common claude-mem issues.

## Quick Fix: Complete Reset and Restart

**Use when:** General issues, worker not responding, after updates

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm run worker:stop 2>/dev/null; \
npm install && \
npm run worker:start && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

**Expected output:** `{"status":"ok"}`

**What it does:**
1. Stops the worker (if running)
2. Ensures dependencies are installed
3. Starts worker with Bun
4. Waits for startup
5. Verifies health

## Fix: Worker Not Running

**Use when:** Worker status shows not running

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm run worker:start && \
sleep 2 && \
npm run worker:status
```

**Expected output:** Worker shows as "running" with PID and uptime

## Fix: Dependencies Missing

**Use when:** Worker won't start due to missing packages

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm install && \
npm run worker:restart
```

## Fix: Port Conflict

**Use when:** Error shows port already in use

```bash
# Change to port 37778
mkdir -p ~/.claude-mem && \
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json && \
npm run worker:restart && \
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
npm run worker:restart
```

**If integrity check fails, recreate database:**
```bash
# WARNING: This deletes all memory data
mv ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.old && \
npm run worker:restart
```

## Fix: Clean Reinstall

**Use when:** All else fails, nuclear option

```bash
# Backup data first
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup 2>/dev/null

# Stop worker
npm run worker:stop 2>/dev/null

# Reinstall dependencies
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
rm -rf node_modules && \
npm install

# Start worker
npm run worker:start && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

## Fix: Clear Worker Logs

**Use when:** Logs are too large, want fresh start

```bash
# Archive old logs
mkdir -p ~/.claude-mem/logs/archive
mv ~/.claude-mem/logs/worker-*.log ~/.claude-mem/logs/archive/ 2>/dev/null

# Restart worker to create new log file
npm run worker:restart
```

## Verification Commands

**After running any fix, verify with these:**

```bash
# Check worker status
npm run worker:status

# Check health
curl -s http://127.0.0.1:37777/health

# Check database
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"

# Check viewer
curl -s http://127.0.0.1:37777/api/stats

# Check logs for errors
tail -20 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | grep -i error
```

**All checks should pass:**
- Worker status: "running"
- Health: `{"status":"ok"}`
- Database: Shows count (may be 0 if new)
- Stats: Returns JSON with counts
- Logs: No recent errors

## Troubleshooting the Fixes

**If automated fix fails:**
1. Run the diagnostic script from [diagnostics.md](diagnostics.md)
2. Check specific error in worker logs
3. Try manual worker start to see detailed error:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   bun plugin/scripts/worker-service.cjs
   ```
