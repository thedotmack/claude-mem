# Worker Service Diagnostics

Bun worker-specific troubleshooting for claude-mem.

## Worker Overview

The claude-mem worker is a persistent background service managed by Bun. It:
- Runs Express.js server on port 37777 (default)
- Processes observations asynchronously
- Serves the viewer UI
- Provides search API endpoints

## Check Worker Status

### Basic Status Check

```bash
# Check worker status using npm script
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:status

# Or check health endpoint directly
curl -s http://127.0.0.1:37777/health
```

**Expected npm run worker:status output:**
```
✓ Worker is running (PID: 12345)
  Port: 37777
  Uptime: 45m
  Health: OK
```

**Expected health endpoint output:**
```json
{"status":"ok"}
```

**Status indicators:**
- `Worker is running` - Worker running correctly
- `Worker is not running` - Worker stopped or crashed
- Connection refused - Worker not running
- Timeout - Worker hung (restart needed)

### Detailed Worker Info

```bash
# View PID file
cat ~/.claude-mem/worker.pid

# Check process details
ps aux | grep "bun.*worker-service"
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
# View logs using npm script
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:logs

# View today's log file directly
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Last 50 lines of today's log
tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Follow logs in real-time
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

### Search Logs for Errors

```bash
# Find errors in today's log
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Find exceptions
grep -i "exception" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Find failed requests
grep -i "failed" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# All error patterns
grep -iE "error|exception|failed|crash" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Search across all log files
grep -iE "error|exception|failed|crash" ~/.claude-mem/logs/worker-*.log
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
Worker restarting...
```

## Starting the Worker

### Basic Start

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:start
```

### Force Restart

```bash
# Restart worker (stops and starts)
cd ~/.claude/plugins/marketplaces/thedotmack/
claude-mem restart

# Or manually stop and start
npm run worker:stop
npm run worker:start
```

## Stopping the Worker

```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:stop
```

## Worker Not Starting

### Diagnostic Steps

1. **Try manual start to see error:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   bun plugin/scripts/worker-service.js
   ```
   This runs the worker directly, showing full error output.

2. **Check Bun installation:**
   ```bash
   which bun
   bun --version
   ```
   If Bun not found, run: `npm install` (auto-installs Bun)

3. **Check dependencies:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   ls node_modules/@anthropic-ai/claude-agent-sdk
   ls node_modules/express
   ```

4. **Check port availability:**
   ```bash
   lsof -i :37777
   ```
   If port in use, either kill that process or change claude-mem port.

5. **Check PID file:**
   ```bash
   cat ~/.claude-mem/worker.pid
   ```
   If worker PID exists but process is dead, remove stale PID:
   ```bash
   rm ~/.claude-mem/worker.pid
   npm run worker:start
   ```

### Common Fixes

**Dependencies missing:**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/
npm install
npm run worker:start
```

**Port conflict:**
```bash
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json
claude-mem restart
```

**Stale PID file:**
```bash
rm ~/.claude-mem/worker.pid
npm run worker:start
```

## Worker Crashing Repeatedly

If worker keeps restarting (check logs for repeated startup messages):

### Find the Cause

1. **Check error logs:**
   ```bash
   grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -100
   ```

2. **Look for crash pattern:**
   ```bash
   grep -A 5 "exited with code" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
   ```

3. **Run worker in foreground to see crashes:**
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   bun plugin/scripts/worker-service.js
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
claude-mem restart
```

**Port conflict race condition:**
Another process grabbing port intermittently. Change port:
```bash
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json
claude-mem restart
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
claude-mem restart

# View logs
npm run worker:logs

# Check health endpoint
curl -s http://127.0.0.1:37777/health

# View PID
cat ~/.claude-mem/worker.pid

# View today's log file
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# List all log files
ls -lh ~/.claude-mem/logs/worker-*.log
```

## Log File Management

Worker logs are stored in `~/.claude-mem/logs/` with daily rotation:

```bash
# View today's log
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# View yesterday's log
cat ~/.claude-mem/logs/worker-$(date -d "yesterday" +%Y-%m-%d).log  # Linux
cat ~/.claude-mem/logs/worker-$(date -v-1d +%Y-%m-%d).log          # macOS

# List all logs
ls -lh ~/.claude-mem/logs/

# Clean old logs (older than 7 days)
find ~/.claude-mem/logs/ -name "worker-*.log" -mtime +7 -delete

# Archive logs
tar -czf ~/claude-mem-logs-backup-$(date +%Y-%m-%d).tar.gz ~/.claude-mem/logs/
```

**Note:** Logs auto-rotate daily. No manual flush required.

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
curl -s "http://127.0.0.1:37777/api/search?query=test&limit=5"

# Recent context
curl -s "http://127.0.0.1:37777/api/context/recent?limit=3"
```

All should return appropriate responses (HTML for viewer, JSON for APIs).

## Troubleshooting Quick Reference

| Problem | Command | Expected Result |
|---------|---------|----------------|
| Check if running | `npm run worker:status` | Shows PID and uptime |
| Worker not running | `npm run worker:start` | Worker starts successfully |
| Worker crashed | `claude-mem restart` | Worker restarts |
| View recent errors | `grep -i error ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log \| tail -20` | Shows recent errors |
| Port in use | `lsof -i :37777` | Shows process using port |
| Stale PID | `rm ~/.claude-mem/worker.pid && npm run worker:start` | Removes stale PID and starts |
| Dependencies missing | `npm install && npm run worker:start` | Installs deps and starts |
