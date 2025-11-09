# Worker Service Diagnostics

PM2 worker-specific troubleshooting for claude-mem.

## PM2 Worker Overview

The claude-mem worker is a persistent background service managed by PM2. It:
- Runs Express.js server on port 37777 (default)
- Processes observations asynchronously
- Serves the viewer UI
- Provides search API endpoints

## Check Worker Status

### Basic Status Check

```bash
# List all PM2 processes
pm2 list

# JSON format (parseable)
pm2 jlist

# Filter for claude-mem-worker
pm2 status | grep claude-mem-worker
```

**Expected output:**
```
│ claude-mem-worker │ online    │ 12345  │ 0    │ 45m │ 0% │ 85.6mb │
```

**Status meanings:**
- `online` - Worker running correctly
- `stopped` - Worker stopped (normal shutdown)
- `errored` - Worker crashed (check logs)
- `stopping` - Worker shutting down
- Not listed - Worker never started

### Detailed Worker Info

```bash
# Show detailed information
pm2 show claude-mem-worker

# JSON format
pm2 jlist | grep -A 20 '"name":"claude-mem-worker"'
```

## Worker Health Endpoint

The worker exposes a health endpoint at `/health`:

```bash
# Check health (default port)
curl -s http://127.0.0.1:37777/health

# With custom port
PORT=$(grep CLAUDE_MEM_WORKER_PORT ~/.claude-mem/settings.json | grep -o '[0-9]\+' || echo "37777")
curl -s http://127.0.0.1:$PORT/health
```

**Expected response:** `{"status":"ok"}`

**Error responses:**
- Connection refused - Worker not running
- Timeout - Worker hung (restart needed)
- Empty response - Worker crashed mid-request

## Worker Logs

### View Recent Logs

```bash
# Last 50 lines
pm2 logs claude-mem-worker --lines 50 --nostream

# Last 200 lines
pm2 logs claude-mem-worker --lines 200 --nostream

# Follow logs in real-time
pm2 logs claude-mem-worker
```

### Search Logs for Errors

```bash
# Find errors
pm2 logs claude-mem-worker --lines 500 --nostream | grep -i "error"

# Find exceptions
pm2 logs claude-mem-worker --lines 500 --nostream | grep -i "exception"

# Find failed requests
pm2 logs claude-mem-worker --lines 500 --nostream | grep -i "failed"

# All error patterns
pm2 logs claude-mem-worker --lines 500 --nostream | grep -iE "error|exception|failed|crash"
```

### Common Log Patterns

**Good startup:**
```
Worker service started on port 37777
Database initialized
Express server listening
```

**Database errors:**
```
Error: SQLITE_ERROR
Error initializing database
Database locked
```

**Port conflicts:**
```
Error: listen EADDRINUSE
Port 37777 already in use
```

**Crashes:**
```
PM2        | App [claude-mem-worker] exited with code [1]
PM2        | App [claude-mem-worker] will restart in 100ms
```

## Starting the Worker

### Basic Start

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
pm2 start ecosystem.config.cjs
```

### Start with Local PM2

If `pm2` command not in PATH:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
node_modules/.bin/pm2 start ecosystem.config.cjs
```

### Force Restart

```bash
# Restart if already running
pm2 restart claude-mem-worker

# Delete and start fresh
pm2 delete claude-mem-worker
pm2 start ecosystem.config.cjs
```

## Stopping the Worker

```bash
# Graceful stop
pm2 stop claude-mem-worker

# Delete completely (also removes from PM2 list)
pm2 delete claude-mem-worker
```

## Worker Not Starting

### Diagnostic Steps

1. **Try manual start to see error:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   node plugin/scripts/worker-service.cjs
   ```
   This runs the worker directly without PM2, showing full error output.

2. **Check PM2 itself:**
   ```bash
   which pm2
   pm2 --version
   ```
   If PM2 not found, dependencies not installed.

3. **Check dependencies:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   ls node_modules/@anthropic-ai/claude-agent-sdk
   ls node_modules/better-sqlite3
   ls node_modules/express
   ls node_modules/pm2
   ```

4. **Check port availability:**
   ```bash
   lsof -i :37777
   ```
   If port in use, either kill that process or change claude-mem port.

### Common Fixes

**Dependencies missing:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm install
pm2 start ecosystem.config.cjs
```

**Port conflict:**
```bash
echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json
pm2 restart claude-mem-worker
```

**Corrupted PM2:**
```bash
pm2 kill  # Stop PM2 daemon
cd ~/.claude/plugins/marketplaces/thedotmack/
pm2 start ecosystem.config.cjs
```

## Worker Crashing Repeatedly

If worker keeps restarting (check with `pm2 status` showing high restart count):

### Find the Cause

1. **Check error logs:**
   ```bash
   pm2 logs claude-mem-worker --err --lines 100 --nostream
   ```

2. **Look for crash pattern:**
   ```bash
   pm2 logs claude-mem-worker --lines 200 --nostream | grep -A 5 "exited with code"
   ```

### Common Crash Causes

**Database corruption:**
```bash
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
```
If fails, backup and recreate database.

**Out of memory:**
Check if database is too large or memory leak. Restart:
```bash
pm2 restart claude-mem-worker
```

**Port conflict race condition:**
Another process grabbing port intermittently. Change port:
```bash
echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json
pm2 restart claude-mem-worker
```

## PM2 Management Commands

```bash
# List processes
pm2 list
pm2 jlist  # JSON format

# Show detailed info
pm2 show claude-mem-worker

# Monitor resources
pm2 monit

# Clear logs
pm2 flush claude-mem-worker

# Restart PM2 daemon
pm2 kill
pm2 resurrect  # Restore saved processes

# Save current process list
pm2 save

# Update PM2
npm install -g pm2
```

## Testing Worker Endpoints

Once worker is running, test all endpoints:

```bash
# Health check
curl -s http://127.0.0.1:37777/health

# Viewer HTML
curl -s http://127.0.0.1:37777/ | head -20

# Stats API
curl -s http://127.0.0.1:37777/api/stats

# Search API
curl -s "http://127.0.0.1:37777/api/search/observations?q=test&format=index"

# Prompts API
curl -s "http://127.0.0.1:37777/api/prompts?limit=5"
```

All should return appropriate responses (HTML for viewer, JSON for APIs).
