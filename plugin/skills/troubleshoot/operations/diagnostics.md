# Full System Diagnostics

Comprehensive step-by-step diagnostic workflow for claude-mem issues.

## Diagnostic Workflow

Run these checks systematically to identify the root cause:

### 1. Check PM2 Worker Status

First, verify if the worker service is running:

```bash
# Check if PM2 is available
which pm2 || echo "PM2 not found in PATH"

# List PM2 processes
pm2 jlist 2>&1

# If pm2 is not found, try the local installation
~/.claude/plugins/marketplaces/thedotmack/node_modules/.bin/pm2 jlist 2>&1
```

**Expected output:** JSON array with `claude-mem-worker` process showing `"status": "online"`

**If worker not running or status is not "online":**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
pm2 start ecosystem.config.cjs
# Or use local pm2:
node_modules/.bin/pm2 start ecosystem.config.cjs
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
ls node_modules/better-sqlite3 2>&1 | head -1
ls node_modules/express 2>&1 | head -1
ls node_modules/pm2 2>&1 | head -1
```

**Expected:** All critical packages present

**If dependencies missing:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm install
```

### 5. Check Worker Logs

Review recent worker logs for errors:

```bash
# View last 50 lines of worker logs
pm2 logs claude-mem-worker --lines 50 --nostream

# Or use local pm2:
cd ~/.claude/plugins/marketplaces/thedotmack/
node_modules/.bin/pm2 logs claude-mem-worker --lines 50 --nostream

# Check for specific errors
pm2 logs claude-mem-worker --lines 100 --nostream | grep -i "error\|exception\|failed"
```

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
PM2_PATH=$(which pm2 2>/dev/null || echo "~/.claude/plugins/marketplaces/thedotmack/node_modules/.bin/pm2")
echo "   PM2 path: $PM2_PATH"
WORKER_STATUS=$($PM2_PATH jlist 2>/dev/null | grep -o '"name":"claude-mem-worker".*"status":"[^"]*"' | grep -o 'status":"[^"]*"' | cut -d'"' -f3 || echo 'not running')
echo "   Worker status: $WORKER_STATUS"
echo "   Health check: $(curl -s http://127.0.0.1:37777/health 2>/dev/null || echo 'FAILED')"
echo ""
echo "5. Configuration"
echo "   Port setting: $(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_WORKER_PORT || echo 'default (37777)')"
echo "   Observation count: $(cat ~/.claude-mem/settings.json 2>/dev/null | grep CLAUDE_MEM_CONTEXT_OBSERVATIONS || echo 'default (50)')"
echo ""
echo "6. Recent Activity"
echo "   Latest observation: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT created_at FROM observations ORDER BY created_at DESC LIMIT 1;' 2>/dev/null || echo 'N/A')"
echo "   Latest session: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1;' 2>/dev/null || echo 'N/A')"
echo ""
echo "=== End Report ==="
```

Save this as `/tmp/claude-mem-diagnostics.sh` and run:
```bash
bash /tmp/claude-mem-diagnostics.sh
```

## Reporting Issues

If troubleshooting doesn't resolve the issue, collect this information for a bug report:

1. Full diagnostic report (run script above)
2. Worker logs: `pm2 logs claude-mem-worker --lines 100 --nostream`
3. Your setup:
   - Claude version: Check with Claude
   - OS: `uname -a`
   - Node version: `node --version`
   - Plugin version: In package.json
4. Steps to reproduce the issue
5. Expected vs actual behavior

Post to: https://github.com/thedotmack/claude-mem/issues
