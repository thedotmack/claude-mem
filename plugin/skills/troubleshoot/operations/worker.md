# Worker Service Diagnostics

Worker-specific troubleshooting for claude-mem.

## Worker Overview

The claude-mem worker is a persistent background service managed by Bun. It:
- Runs Express.js server on port 37777 (default)
- Processes observations asynchronously
- Serves the viewer UI
- Provides search API endpoints

## Check Worker Status

### Basic Status Check

```bash
# Check worker using npm script
npm run worker:status

# Or check PID file directly
cat ~/.claude-mem/worker.pid

# Check if process is running
cat ~/.claude-mem/worker.pid | grep -o '"pid":[0-9]*' | grep -o '[0-9]*' | xargs ps -p
```

**Expected output from `worker:status`:**
```
Worker is running
  PID: 12345
  Port: 37777
  Uptime: 2h 15m
```

**Status meanings:**
- `Worker is running` - Worker running correctly
- `Worker is not running` - Worker stopped or never started

### Detailed Worker Info

```bash
# View PID file contents
cat ~/.claude-mem/worker.pid

# Example output:
# {
#   "pid": 12345,
#   "port": 37777,
#   "startedAt": "2024-01-15T10:30:00.000Z",
#   "version": "7.1.14"
# }

# Check process details
ps aux | grep -i "worker-service.cjs"
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

The worker logs to daily files in `~/.claude-mem/logs/`.

```bash
# View today's logs (last 50 lines)
tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# View today's logs (last 200 lines)
tail -200 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Follow logs in real-time (npm script)
npm run worker:logs

# Follow logs manually
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

### Search Logs for Errors

```bash
# Find errors in today's logs
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Find exceptions
grep -i "exception" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Find failed requests
grep -i "failed" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# All error patterns
grep -iE "error|exception|failed|crash" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
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
Worker process exited with code 1
Process terminated unexpectedly
```

## Starting the Worker

### Basic Start

The worker starts automatically when Claude Code starts. To manually start:

```bash
# Using npm script (recommended)
npm run worker:start

# Or using bun directly
bun plugin/scripts/worker-cli.js start
```

### Check Startup Status

After starting, verify the worker is running:

```bash
# Check status
npm run worker:status

# Check health endpoint
curl -s http://127.0.0.1:37777/health
```

### Force Restart

```bash
# Restart worker (stops and starts)
npm run worker:restart
```

## Stopping the Worker

```bash
# Graceful stop using npm script
npm run worker:stop

# Or using bun directly
bun plugin/scripts/worker-cli.js stop

# Force kill if not responding
kill -TERM $(cat ~/.claude-mem/worker.pid | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
```

## Worker Not Starting

### Diagnostic Steps

1. **Try manual start to see error:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   bun plugin/scripts/worker-service.cjs
   ```
   This runs the worker directly, showing full error output.

2. **Check Bun is installed:**
   ```bash
   which bun
   bun --version
   ```
   If Bun not found, install from https://bun.sh

3. **Check dependencies:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   ls node_modules/@anthropic-ai/claude-agent-sdk
   ls node_modules/express
   ```

4. **Check port availability:**
   ```bash
   lsof -i :37777
   # Or on Linux:
   netstat -tlnp | grep 37777
   ```
   If port in use, either kill that process or change claude-mem port.

### Common Fixes

**Dependencies missing:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm install
npm run worker:start
```

**Port conflict:**
```bash
# Change to port 37778
mkdir -p ~/.claude-mem
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json
npm run worker:restart
```

**Bun not installed:**
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
# Then restart worker
npm run worker:start
```

## Worker Crashing Repeatedly

If worker keeps restarting (check logs or process keeps dying):

### Find the Cause

1. **Check error logs:**
   ```bash
   grep -i "error\|crash\|exception" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -50
   ```

2. **Look for crash pattern:**
   ```bash
   grep "exited with code\|terminated" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -20
   ```

3. **Check if process exists:**
   ```bash
   npm run worker:status
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
npm run worker:restart
```

**Port conflict race condition:**
Another process grabbing port intermittently. Change port:
```bash
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json
npm run worker:restart
```

## Worker Management Commands

```bash
# Check status
npm run worker:status

# Start worker
npm run worker:start

# Stop worker
npm run worker:stop

# Restart worker
npm run worker:restart

# View logs in real-time
npm run worker:logs

# View specific log file
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Check PID file
cat ~/.claude-mem/worker.pid

# Kill worker process (if not responding)
kill -TERM $(cat ~/.claude-mem/worker.pid | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
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
