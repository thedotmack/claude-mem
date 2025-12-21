# Quick Commands Reference

Essential commands for troubleshooting claude-mem.

## Worker Management

```bash
# Check worker status
cd ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:status

# Start worker
npm run worker:start

# Restart worker
claude-mem restart

# Stop worker
npm run worker:stop

# View logs
npm run worker:logs

# View today's log file
cat ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Last 50 lines
tail -50 ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Follow logs in real-time
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

## Health Checks

```bash
# Check worker health (default port)
curl -s http://127.0.0.1:37777/health

# Check viewer stats
curl -s http://127.0.0.1:37777/api/stats

# Open viewer in browser
open http://127.0.0.1:37777

# Test custom port
PORT=37778
curl -s http://127.0.0.1:$PORT/health
```

## Database Queries

```bash
# Observation count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"

# Session count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sessions;"

# Recent observations
sqlite3 ~/.claude-mem/claude-mem.db "SELECT created_at, type, title FROM observations ORDER BY created_at DESC LIMIT 10;"

# Recent sessions
sqlite3 ~/.claude-mem/claude-mem.db "SELECT created_at, request FROM sessions ORDER BY created_at DESC LIMIT 5;"

# Database size
du -h ~/.claude-mem/claude-mem.db

# Database integrity check
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"

# Projects in database
sqlite3 ~/.claude-mem/claude-mem.db "SELECT DISTINCT project FROM observations ORDER BY project;"
```

## Configuration

```bash
# View current settings
cat ~/.claude-mem/settings.json
cat ~/.claude/settings.json

# Change worker port
echo '{"CLAUDE_MEM_WORKER_PORT":"37778"}' > ~/.claude-mem/settings.json

# Change context observation count
# Edit ~/.claude-mem/settings.json and add:
{
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "25"
}

# Change AI model
{
  "CLAUDE_MEM_MODEL": "claude-sonnet-4-5"
}
```

## Plugin Management

```bash
# Navigate to plugin directory
cd ~/.claude/plugins/marketplaces/thedotmack/

# Check plugin version
grep '"version"' package.json

# Reinstall dependencies
npm install

# View package.json
cat package.json
```

## Port Diagnostics

```bash
# Check what's using port 37777
lsof -i :37777
netstat -tlnp | grep 37777

# Test port connectivity
nc -zv 127.0.0.1 37777
curl -v http://127.0.0.1:37777/health
```

## Log Analysis

```bash
# Search logs for errors
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Search for specific keyword
grep "keyword" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Search across all log files
grep -i "error" ~/.claude-mem/logs/worker-*.log

# Last 100 error lines
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -100

# Follow logs in real-time
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

## File Locations

```bash
# Plugin directory
~/.claude/plugins/marketplaces/thedotmack/

# Database
~/.claude-mem/claude-mem.db

# Settings
~/.claude-mem/settings.json
~/.claude/settings.json

# Chroma vector database
~/.claude-mem/chroma/

# Worker logs (daily rotation)
~/.claude-mem/logs/worker-*.log

# Worker PID file
~/.claude-mem/worker.pid
```

## System Information

```bash
# OS version
uname -a

# Node version
node --version

# NPM version
npm --version

# Bun version
bun --version

# SQLite version
sqlite3 --version

# Check disk space
df -h ~/.claude-mem/
```

## One-Line Diagnostics

```bash
# Full worker status check
npm run worker:status && curl -s http://127.0.0.1:37777/health

# Quick health check
curl -s http://127.0.0.1:37777/health && echo " - Worker is healthy"

# Database stats
echo "Observations: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM observations;')" && echo "Sessions: $(sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM sessions;')"

# Recent errors
grep -i "error" ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log | tail -10

# Port check
lsof -i :37777 || echo "Port 37777 is free"
```
