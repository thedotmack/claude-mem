# Automated Fix Sequences

One-command fix sequences for common claude-mem issues.

## Quick Fix: Complete Reset and Restart

**Use when:** General issues, worker not responding, after updates

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
pm2 delete claude-mem-worker 2>/dev/null; \
npm install && \
node_modules/.bin/pm2 start ecosystem.config.cjs && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

**Expected output:** `{"status":"ok"}`

**What it does:**
1. Stops the worker (if running)
2. Ensures dependencies are installed
3. Starts worker with local PM2
4. Waits for startup
5. Verifies health

## Fix: Worker Not Running

**Use when:** PM2 shows worker as stopped or not listed

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
node_modules/.bin/pm2 start ecosystem.config.cjs && \
sleep 2 && \
pm2 status
```

**Expected output:** Worker shows as "online"

## Fix: Dependencies Missing

**Use when:** Worker won't start due to missing packages

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
npm install && \
pm2 restart claude-mem-worker
```

## Fix: Port Conflict

**Use when:** Error shows port already in use

```bash
# Change to port 37778
mkdir -p ~/.claude-mem && \
echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json && \
pm2 restart claude-mem-worker && \
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
pm2 restart claude-mem-worker
```

**If integrity check fails, recreate database:**
```bash
# WARNING: This deletes all memory data
mv ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.old && \
pm2 restart claude-mem-worker
```

## Fix: Clean Reinstall

**Use when:** All else fails, nuclear option

```bash
# Backup data first
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup 2>/dev/null

# Stop and remove worker
pm2 delete claude-mem-worker 2>/dev/null

# Reinstall dependencies
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
rm -rf node_modules && \
npm install

# Start worker
node_modules/.bin/pm2 start ecosystem.config.cjs && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

## Fix: Clear PM2 Logs

**Use when:** Logs are too large, want fresh start

```bash
pm2 flush claude-mem-worker && \
pm2 restart claude-mem-worker
```

## Verification Commands

**After running any fix, verify with these:**

```bash
# Check worker status
pm2 status | grep claude-mem-worker

# Check health
curl -s http://127.0.0.1:37777/health

# Check database
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"

# Check viewer
curl -s http://127.0.0.1:37777/api/stats

# Check logs for errors
pm2 logs claude-mem-worker --lines 20 --nostream | grep -i error
```

**All checks should pass:**
- Worker status: "online"
- Health: `{"status":"ok"}`
- Database: Shows count (may be 0 if new)
- Stats: Returns JSON with counts
- Logs: No recent errors

## Troubleshooting the Fixes

**If automated fix fails:**
1. Run the diagnostic script from [diagnostics.md](diagnostics.md)
2. Check specific error in PM2 logs
3. Try manual worker start to see detailed error:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   node plugin/scripts/worker-service.cjs
   ```
