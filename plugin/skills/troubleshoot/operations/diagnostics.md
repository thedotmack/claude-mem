# Full System Diagnostics

Comprehensive step-by-step diagnostic workflow for claude-mem issues.

## Diagnostic Workflow

Run these checks systematically to identify the root cause:

### 1. Check Worker Status

First, verify if the worker service is running:

```bash
# Check worker status using npm script
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:status

# Or check health endpoint directly
curl -s http://127.0.0.1:37777/health
```

**Expected output from npm run worker:status:**
```
✓ Worker is running (PID: 12345)
  Port: 37777
  Uptime: 45m
  Health: OK
```

**Expected output from health endpoint:** `{"status":"ok"}`

**If worker not running:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:start
```

**If health endpoint fails but worker reports running:**
Check for stale PID file:
```bash
cat ~/.claude-mem/worker.pid
ps -p $(cat ~/.claude-mem/worker.pid 2>/dev/null | grep -o '"pid":[0-9]*' | grep -o '[0-9]*') 2>/dev/null || echo "Stale PID - worker not actually running"
rm ~/.claude-mem/worker.pid
npm run worker:start
```

### 2. Check Worker Service Health

Test if the worker service responds to HTTP requests:

```bash
# Default port is 37777
curl -s http://127.0.0.1:37777/health

# Check custom port from settings
PORT=$(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_WORKER_PORT | grep -o '[0-9]\+' || echo "37777")
curl -s http://127.0.0.1:$PORT/health
```

**Expected output:** `{"status":"ok"}`

**If connection refused:**
- Worker not running → Go back to step 1
- Port conflict → Check what's using the port:
  ```bash
  lsof -i :37777 || netstat -tlnp | grep 37777
  ```

### 3. Check Database

Verify the database exists and contains data:

```bash
# Check if database file exists
ls -lh ~/.claude-mem/claude-mem.db

# Check database size (should be > 0 bytes)
du -h ~/.claude-mem/claude-mem.db

# Query database for observation count (requires sqlite3)
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) as observation_count FROM observations;" 2>&1

# Query for session count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) as session_count FROM sessions;" 2>&1

# Check recent observations
sqlite3 ~/.claude-mem/claude-mem.db "SELECT created_at, type, title FROM observations ORDER BY created_at DESC LIMIT 5;" 2>&1
```

**Expected:**
- Database file exists (typically 100KB - 10MB+)
- Contains observations and sessions
- Recent observations visible

**If database missing or empty:**
- New installation - this is normal, database will populate as you work
- After `/clear` - sessions are marked complete but not deleted, data should persist
- Corrupted database - backup and recreate:
  ```bash
  cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup
  # Worker will recreate on next observation
  ```

### 4. Check Dependencies Installation

Verify all required npm packages are installed:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/

# Check for critical packages
ls node_modules/@anthropic-ai/claude-agent-sdk 2>&1 | head -1
ls node_modules/express 2>&1 | head -1

# Check if Bun is available
bun --version 2>&1
```

**Expected:** All critical packages present, Bun installed

**If dependencies missing:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm install
```

### 5. Check Worker Logs

Review recent worker logs for errors:

```bash
# View logs using npm script
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:logs

# View today's log file directly
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Last 50 lines
tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Check for specific errors
grep -iE "error|exception|failed" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -20
```

**Common error patterns to look for:**
- `SQLITE_ERROR` - Database issues
- `EADDRINUSE` - Port conflict
- `ENOENT` - Missing files
- `Module not found` - Dependency issues

### 6. Test Viewer UI

Check if the web viewer is accessible:

```bash
# Test viewer endpoint
curl -s http://127.0.0.1:37777/ | head -20

# Test stats endpoint
curl -s http://127.0.0.1:37777/api/stats
```

**Expected:**
- `/` returns HTML page with React viewer
- `/api/stats` returns JSON with database counts

### 7. Check Port Configuration

Verify port settings and availability:

```bash
# Check if custom port is configured
cat ~/.claude-mem/settings.json 2>/dev/null
cat ~/.claude/settings.json 2>/dev/null

# Check what's listening on default port
lsof -i :37777 2>&1 || netstat -tlnp 2>&1 | grep 37777

# Test connectivity
nc -zv 127.0.0.1 37777 2>&1
```

## Full System Diagnosis Script

Run this comprehensive diagnostic script to collect all information:

```bash
#!/bin/bash
echo "=== Claude-Mem Troubleshooting Report ==="
echo ""
echo "1. Environment"
echo "   OS: $(uname -s)"
echo "   Node version: $(node --version 2>/dev/null || echo 'N/A')"
echo "   Bun version: $(bun --version 2>/dev/null || echo 'N/A')"
echo ""
echo "2. Plugin Installation"
echo "   Plugin directory exists: $([ -d ~/.claude/plugins/marketplaces/thedotmack ] && echo 'YES' || echo 'NO')"
echo "   Package version: $(grep '"version"' ~/.claude/plugins/marketplaces/thedotmack/package.json 2>/dev/null | head -1)"
echo ""
echo "3. Database"
echo "   Database exists: $([ -f ~/.claude-mem/claude-mem.db ] && echo 'YES' || echo 'NO')"
echo "   Database size: $(du -h ~/.claude-mem/claude-mem.db 2>/dev/null | cut -f1)"
echo "   Observation count: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM observations;' 2>/dev/null || echo 'N/A')"
echo "   Session count: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM sessions;' 2>/dev/null || echo 'N/A')"
echo ""
echo "4. Worker Service"
echo "   Worker PID file: $([ -f ~/.claude-mem/worker.pid ] && echo 'EXISTS' || echo 'MISSING')"
if [ -f ~/.claude-mem/worker.pid ]; then
  WORKER_PID=$(cat ~/.claude-mem/worker.pid 2>/dev/null | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
  echo "   Worker PID: $WORKER_PID"
  echo "   Process running: $(ps -p $WORKER_PID >/dev/null 2>&1 && echo 'YES' || echo 'NO (stale PID)')"
fi
echo "   Health check: $(curl -s http://127.0.0.1:37777/health 2>/dev/null || echo 'FAILED')"
echo ""
echo "5. Configuration"
echo "   Port setting: $(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_WORKER_PORT || echo 'default (37777)')"
echo "   Observation count: $(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_CONTEXT_OBSERVATIONS || echo 'default (50)')"
echo "   Model: $(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_MODEL || echo 'default (claude-sonnet-4-5)')"
echo ""
echo "6. Recent Activity"
echo "   Latest observation: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT created_at FROM observations ORDER BY created_at DESC LIMIT 1;' 2>/dev/null || echo 'N/A')"
echo "   Latest session: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1;' 2>/dev/null || echo 'N/A')"
echo ""
echo "7. Logs"
echo "   Today's log file: $([ -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log ] && echo 'EXISTS' || echo 'MISSING')"
echo "   Log file size: $(du -h ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log 2>/dev/null | cut -f1 || echo 'N/A')"
echo "   Recent errors: $(grep -c -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log 2>/dev/null || echo '0')"
echo ""
echo "=== End Report ==="
```

Save this as `/tmp/claude-mem-diagnostics.sh` and run:
```bash
bash /tmp/claude-mem-diagnostics.sh
```

## Quick Diagnostic One-Liners

```bash
# Full status check
npm run worker:status && curl -s http://127.0.0.1:37777/health && echo " - All systems OK"

# Database stats
echo "DB: $(du -h ~/.claude-mem/claude-mem.db | cut -f1) | Obs: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM observations;' 2>/dev/null) | Sessions: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM sessions;' 2>/dev/null)"

# Recent errors
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log 2>/dev/null | tail -5 || echo "No recent errors"

# Port check
lsof -i :37777 || echo "Port 37777 is free"

# Worker process check
ps aux | grep -E "bun.*worker-service" | grep -v grep || echo "Worker not running"
```

## Automated Fix Sequence

If diagnostics show issues, run this automated fix sequence:

```bash
#!/bin/bash
echo "Running automated fix sequence..."

# 1. Stop worker if running
echo "1. Stopping worker..."
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:stop

# 2. Clean stale PID if exists
echo "2. Cleaning stale PID file..."
rm -f ~/.claude-mem/worker.pid

# 3. Reinstall dependencies
echo "3. Reinstalling dependencies..."
npm install

# 4. Start worker
echo "4. Starting worker..."
npm run worker:start

# 5. Wait for startup
echo "5. Waiting for worker to start..."
sleep 3

# 6. Verify health
echo "6. Verifying health..."
curl -s http://127.0.0.1:37777/health || echo "Worker health check FAILED"

echo "Fix sequence complete!"
```

## Reporting Issues

If troubleshooting doesn't resolve the issue, run the built-in bug report tool:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run bug-report
```

This will collect:
1. Full diagnostic report
2. Worker logs
3. System information
4. Configuration details
5. Database stats

Post the generated report to: https://github.com/thedotmack/claude-mem/issues
