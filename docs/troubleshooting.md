# Troubleshooting Guide

## Worker Service Issues

### Worker Service Not Starting

**Symptoms**: Worker doesn't start, or `pm2 status` shows no processes.

**Solutions**:

1. Check if PM2 is running:
   ```bash
   pm2 status
   ```

2. Try starting manually:
   ```bash
   npm run worker:start
   ```

3. Check worker logs for errors:
   ```bash
   npm run worker:logs
   ```

4. Full reset:
   ```bash
   pm2 delete claude-mem-worker
   npm run worker:start
   ```

5. Verify PM2 is installed:
   ```bash
   which pm2
   npm list pm2
   ```

### Port Allocation Failed

**Symptoms**: Worker fails to start with "port already in use" error.

**Solutions**:

1. Check if port 37777 is in use:
   ```bash
   lsof -i :37777
   ```

2. Kill process using the port:
   ```bash
   kill -9 $(lsof -t -i:37777)
   ```

3. Or use a different port:
   ```bash
   export CLAUDE_MEM_WORKER_PORT=38000
   npm run worker:restart
   ```

4. Verify new port:
   ```bash
   cat ~/.claude-mem/worker.port
   ```

### Worker Keeps Crashing

**Symptoms**: Worker restarts repeatedly, PM2 shows high restart count.

**Solutions**:

1. Check error logs:
   ```bash
   npm run worker:logs
   ```

2. Check memory usage:
   ```bash
   pm2 status
   ```

3. Increase memory limit in `ecosystem.config.cjs`:
   ```javascript
   {
     max_memory_restart: '2G'  // Increase if needed
   }
   ```

4. Check database for corruption:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
   ```

### Worker Not Processing Observations

**Symptoms**: Observations saved but not processed, no summaries generated.

**Solutions**:

1. Check worker is running:
   ```bash
   npm run worker:status
   ```

2. Check worker logs:
   ```bash
   npm run worker:logs
   ```

3. Verify database has observations:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

4. Restart worker:
   ```bash
   npm run worker:restart
   ```

## Hook Issues

### Hooks Not Firing

**Symptoms**: No context appears, observations not saved.

**Solutions**:

1. Verify hooks are configured:
   ```bash
   cat plugin/hooks/hooks.json
   ```

2. Test hooks manually:
   ```bash
   # Test context hook
   echo '{"session_id":"test-123","cwd":"'$(pwd)'","source":"startup"}' | node plugin/scripts/context-hook.js
   ```

3. Check hook permissions:
   ```bash
   ls -la plugin/scripts/*.js
   ```

4. Verify hooks.json is valid JSON:
   ```bash
   cat plugin/hooks/hooks.json | jq .
   ```

### Context Not Appearing

**Symptoms**: No session context when Claude starts.

**Solutions**:

1. Check if summaries exist:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM session_summaries;"
   ```

2. View recent sessions:
   ```bash
   npm run test:context:verbose
   ```

3. Check database integrity:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
   ```

4. Manually test context hook:
   ```bash
   npm run test:context
   ```

### Hooks Timeout

**Symptoms**: Hook execution times out, errors in Claude Code.

**Solutions**:

1. Increase timeout in `plugin/hooks/hooks.json`:
   ```json
   {
     "timeout": 180  // Increase from 120
   }
   ```

2. Check worker is running (prevents timeout waiting for worker):
   ```bash
   npm run worker:status
   ```

3. Check database size (large database = slow queries):
   ```bash
   ls -lh ~/.claude-mem/claude-mem.db
   ```

4. Optimize database:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "VACUUM;"
   ```

### Dependencies Not Installing

**Symptoms**: SessionStart hook fails with "module not found" errors.

**Solutions**:

1. Manually install dependencies:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack
   npm install
   ```

2. Check npm is available:
   ```bash
   which npm
   npm --version
   ```

3. Check package.json exists:
   ```bash
   ls -la ~/.claude/plugins/marketplaces/thedotmack/package.json
   ```

## Database Issues

### Database Locked

**Symptoms**: "database is locked" errors in logs.

**Solutions**:

1. Close all connections:
   ```bash
   pm2 stop claude-mem-worker
   ```

2. Check for stale locks:
   ```bash
   lsof ~/.claude-mem/claude-mem.db
   ```

3. Kill processes holding locks:
   ```bash
   kill -9 <PID>
   ```

4. Restart worker:
   ```bash
   npm run worker:start
   ```

### Database Corruption

**Symptoms**: Integrity check fails, weird errors.

**Solutions**:

1. Check database integrity:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
   ```

2. Backup database:
   ```bash
   cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup
   ```

3. Try to repair:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "VACUUM;"
   ```

4. Nuclear option - recreate database:
   ```bash
   rm ~/.claude-mem/claude-mem.db
   npm run worker:start  # Will recreate schema
   ```

### FTS5 Search Not Working

**Symptoms**: Search returns no results, FTS5 errors.

**Solutions**:

1. Check FTS5 tables exist:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts';"
   ```

2. Rebuild FTS5 tables:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
     INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
     INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild');
     INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild');
   "
   ```

3. Check triggers exist:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT name FROM sqlite_master WHERE type='trigger';"
   ```

### Database Too Large

**Symptoms**: Slow performance, large database file.

**Solutions**:

1. Check database size:
   ```bash
   ls -lh ~/.claude-mem/claude-mem.db
   ```

2. Vacuum database:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "VACUUM;"
   ```

3. Delete old sessions:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
     DELETE FROM observations WHERE created_at_epoch < $(date -v-30d +%s);
     DELETE FROM session_summaries WHERE created_at_epoch < $(date -v-30d +%s);
     DELETE FROM sdk_sessions WHERE created_at_epoch < $(date -v-30d +%s);
   "
   ```

4. Rebuild FTS5 after deletion:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
     INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
     INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild');
   "
   ```

## MCP Search Issues

### Search Tools Not Available

**Symptoms**: MCP search tools not visible in Claude Code.

**Solutions**:

1. Check MCP configuration:
   ```bash
   cat plugin/.mcp.json
   ```

2. Verify search server is built:
   ```bash
   ls -l plugin/scripts/search-server.js
   ```

3. Rebuild if needed:
   ```bash
   npm run build
   ```

4. Restart Claude Code

### Search Returns No Results

**Symptoms**: Valid queries return empty results.

**Solutions**:

1. Check database has data:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

2. Verify FTS5 tables populated:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations_fts;"
   ```

3. Test simple query:
   ```bash
   # In Claude Code
   search_observations with query="test"
   ```

4. Check query syntax:
   ```bash
   # Bad: Special characters
   search_observations with query="[test]"

   # Good: Simple words
   search_observations with query="test"
   ```

### Token Limit Errors

**Symptoms**: "exceeded token limit" errors from MCP.

**Solutions**:

1. Use index format:
   ```bash
   search_observations with query="..." and format="index"
   ```

2. Reduce limit:
   ```bash
   search_observations with query="..." and limit=3
   ```

3. Use filters to narrow results:
   ```bash
   search_observations with query="..." and type="decision" and limit=5
   ```

4. Paginate results:
   ```bash
   # First page
   search_observations with query="..." and limit=5 and offset=0

   # Second page
   search_observations with query="..." and limit=5 and offset=5
   ```

## Performance Issues

### Slow Context Injection

**Symptoms**: SessionStart hook takes too long.

**Solutions**:

1. Reduce context sessions:
   ```typescript
   // In src/hooks/context.ts
   const CONTEXT_SESSIONS = 5;  // Reduce from 10
   ```

2. Optimize database:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
     ANALYZE;
     VACUUM;
   "
   ```

3. Add indexes (if missing):
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
     CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sdk_sessions(project, created_at_epoch DESC);
   "
   ```

### Slow Search Queries

**Symptoms**: MCP search tools take too long.

**Solutions**:

1. Use more specific queries
2. Add date range filters
3. Add type/concept filters
4. Reduce result limit
5. Use index format instead of full format

### High Memory Usage

**Symptoms**: Worker uses too much memory, frequent restarts.

**Solutions**:

1. Check current usage:
   ```bash
   pm2 status
   ```

2. Increase memory limit:
   ```javascript
   // In ecosystem.config.cjs
   {
     max_memory_restart: '2G'
   }
   ```

3. Restart worker:
   ```bash
   npm run worker:restart
   ```

4. Clean up old data (see "Database Too Large" above)

## Installation Issues

### Plugin Not Found

**Symptoms**: `/plugin install claude-mem` fails.

**Solutions**:

1. Add marketplace first:
   ```bash
   /plugin marketplace add thedotmack/claude-mem
   ```

2. Then install:
   ```bash
   /plugin install claude-mem
   ```

3. Verify installation:
   ```bash
   ls -la ~/.claude/plugins/marketplaces/thedotmack/
   ```

### Build Failures

**Symptoms**: `npm run build` fails.

**Solutions**:

1. Clean and reinstall:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. Check Node.js version:
   ```bash
   node --version  # Should be >= 18.0.0
   ```

3. Check for TypeScript errors:
   ```bash
   npx tsc --noEmit
   ```

### Missing Dependencies

**Symptoms**: "Cannot find module" errors.

**Solutions**:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Check package.json:
   ```bash
   cat package.json
   ```

3. Verify node_modules exists:
   ```bash
   ls -la node_modules/
   ```

## Debugging

### Enable Verbose Logging

```bash
export DEBUG=claude-mem:*
npm run worker:restart
npm run worker:logs
```

### Check Correlation IDs

Trace observations through the pipeline:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
  SELECT correlation_id, tool_name, created_at
  FROM observations
  WHERE session_id = 'YOUR_SESSION_ID'
  ORDER BY created_at;
"
```

### Inspect Worker State

```bash
# Check if worker is running
pm2 status

# View logs
pm2 logs claude-mem-worker

# Check port file
cat ~/.claude-mem/worker.port

# Test worker health
curl http://localhost:37777/health
```

### Database Inspection

```bash
sqlite3 ~/.claude-mem/claude-mem.db

# View schema
.schema

# Check table counts
SELECT 'sessions', COUNT(*) FROM sdk_sessions
UNION ALL
SELECT 'observations', COUNT(*) FROM observations
UNION ALL
SELECT 'summaries', COUNT(*) FROM session_summaries
UNION ALL
SELECT 'prompts', COUNT(*) FROM user_prompts;

# View recent activity
SELECT created_at, tool_name FROM observations ORDER BY created_at DESC LIMIT 10;
```

## Common Error Messages

### "Worker service not responding"

**Cause**: Worker not running or port mismatch.

**Solution**: Restart worker with `npm run worker:restart`.

### "Database is locked"

**Cause**: Multiple processes accessing database.

**Solution**: Stop worker, kill stale processes, restart.

### "FTS5: syntax error"

**Cause**: Invalid search query syntax.

**Solution**: Use simpler query, avoid special characters.

### "SQLITE_CANTOPEN"

**Cause**: Database file permissions or missing directory.

**Solution**: Check `~/.claude-mem/` exists and is writable.

### "Module not found"

**Cause**: Missing dependencies.

**Solution**: Run `npm install`.

## Getting Help

If none of these solutions work:

1. **Check logs**:
   ```bash
   npm run worker:logs
   ```

2. **Create issue**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
   - Include error messages
   - Include relevant logs
   - Include steps to reproduce

3. **Check existing issues**: Someone may have already solved your problem

## Next Steps

- [Configuration](configuration.md) - Customize Claude-Mem
- [Development](development.md) - Build from source
- [Architecture](architecture/overview.md) - Understand the system
