# Quick Commands Reference

Essential commands for troubleshooting claude-mem.

## Worker Management

```bash
# Check worker status
pm2 status | grep claude-mem-worker
pm2 jlist | grep claude-mem-worker  # JSON format

# Start worker
cd ~/.claude/plugins/marketplaces/thedotmack/
pm2 start ecosystem.config.cjs

# Restart worker
pm2 restart claude-mem-worker

# Stop worker
pm2 stop claude-mem-worker

# Delete worker (for clean restart)
pm2 delete claude-mem-worker

# View logs
pm2 logs claude-mem-worker

# View last N lines
pm2 logs claude-mem-worker --lines 50 --nostream

# Clear logs
pm2 flush claude-mem-worker
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
echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json

# Change context observation count
# Edit ~/.claude-mem/settings.json and add:
{
  "env": {
    "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "25"
  }
}

# Change AI model
{
  "env": {
    "CLAUDE_MEM_MODEL": "claude-haiku-4-5"
  }
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
pm2 logs claude-mem-worker --lines 100 --nostream | grep -i "error"

# Search for specific keyword
pm2 logs claude-mem-worker --lines 100 --nostream | grep "keyword"

# Follow logs in real-time
pm2 logs claude-mem-worker

# Show only error logs
pm2 logs claude-mem-worker --err
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

# Usage logs
~/.claude-mem/usage-logs/

# PM2 logs
~/.pm2/logs/
```

## System Information

```bash
# OS version
uname -a

# Node version
node --version

# NPM version
npm --version

# PM2 version
pm2 --version

# SQLite version
sqlite3 --version

# Check disk space
df -h ~/.claude-mem/
```
