# Common Issue Resolutions

Quick fixes for frequently encountered claude-mem problems.

## Issue: Nothing is Remembered After `/clear` {#nothing-remembered}

**Symptoms:**
- Data doesn't persist across sessions
- Context is empty after `/clear`
- Search returns no results for past work

**Root cause:** Sessions are marked complete but data should persist. This suggests:
- Worker not processing observations
- Database not being written to
- Context hook not reading from database

**Fix:**
1. Verify worker is running:
   ```bash
   pm2 jlist | grep claude-mem-worker
   ```

2. Check database has recent observations:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE created_at > datetime('now', '-1 day');"
   ```

3. Restart worker and start new session:
   ```bash
   pm2 restart claude-mem-worker
   ```

4. Create a test observation: `/skill version-bump` then cancel

5. Check if observation appears in viewer:
   ```bash
   open http://127.0.0.1:37777
   # Or manually check database:
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM observations ORDER BY created_at DESC LIMIT 1;"
   ```

## Issue: Viewer Empty After Every Claude Restart {#viewer-empty}

**Symptoms:**
- Viewer shows no data at http://127.0.0.1:37777
- Stats endpoint returns all zeros
- Database appears empty in UI

**Root cause:**
- Database being recreated on startup (shouldn't happen)
- Worker reading from wrong database location
- Database permissions issue

**Fix:**
1. Check database file exists and has data:
   ```bash
   ls -lh ~/.claude-mem/claude-mem.db
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

2. Check file permissions:
   ```bash
   ls -la ~/.claude-mem/claude-mem.db
   # Should be readable/writable by your user
   ```

3. Verify worker is using correct database path in logs:
   ```bash
   pm2 logs claude-mem-worker --lines 50 --nostream | grep "Database"
   ```

4. Test viewer connection manually:
   ```bash
   curl -s http://127.0.0.1:37777/api/stats
   # Should show non-zero counts if data exists
   ```

## Issue: Old Memory in Claude {#old-memory}

**Symptoms:**
- Context contains outdated observations
- Irrelevant past work appearing in sessions
- Context feels stale

**Root cause:** Context hook injecting stale observations

**Fix:**
1. Check the observation count setting:
   ```bash
   grep CLAUDE_MEM_CONTEXT_OBSERVATIONS ~/.claude-mem/settings.json
   ```

2. Default is 50 observations - you can adjust this:
   ```json
   {
     "env": {
       "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "25"
     }
   }
   ```

3. Check database for actual observation dates:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT created_at, project, title FROM observations ORDER BY created_at DESC LIMIT 10;"
   ```

4. Consider filtering by project if working on multiple codebases

## Issue: Worker Not Starting {#worker-not-starting}

**Symptoms:**
- PM2 shows worker as "stopped" or "errored"
- Health check fails
- Viewer not accessible

**Root cause:**
- Port already in use
- PM2 not installed or not in PATH
- Missing dependencies

**Fix:**
1. Try manual worker start to see error:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   node plugin/scripts/worker-service.cjs
   # Should start server on port 37777 or show error
   ```

2. If port in use, change it:
   ```bash
   mkdir -p ~/.claude-mem
   echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json
   ```

3. If dependencies missing:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   npm install
   pm2 start ecosystem.config.cjs
   ```

## Issue: Search Results Empty

**Symptoms:**
- Search skill returns no results
- API endpoints return empty arrays
- Know there's data but can't find it

**Root cause:**
- FTS5 tables not synchronized
- Wrong project filter
- Database not being queried correctly

**Fix:**
1. Check if observations exist in database:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

2. Check FTS5 table sync:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations_fts;"
   # Should match observation count
   ```

3. Try search via API directly:
   ```bash
   curl "http://127.0.0.1:37777/api/search/observations?q=test&format=index"
   ```

4. If FTS5 out of sync, restart worker (triggers reindex):
   ```bash
   pm2 restart claude-mem-worker
   ```

## Issue: Port Conflicts

**Symptoms:**
- Worker won't start
- Error: "EADDRINUSE: address already in use"
- Health check fails

**Fix:**
1. Check what's using port 37777:
   ```bash
   lsof -i :37777
   ```

2. Either kill the conflicting process or change claude-mem port:
   ```bash
   mkdir -p ~/.claude-mem
   echo '{"env":{"CLAUDE_MEM_WORKER_PORT":"37778"}}' > ~/.claude-mem/settings.json
   pm2 restart claude-mem-worker
   ```

## Issue: Database Corrupted

**Symptoms:**
- SQLite errors in logs
- Worker crashes on startup
- Queries fail

**Fix:**
1. Backup the database:
   ```bash
   cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup
   ```

2. Try to repair:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
   ```

3. If repair fails, recreate (loses data):
   ```bash
   rm ~/.claude-mem/claude-mem.db
   pm2 restart claude-mem-worker
   # Worker will create new database
   ```

## Prevention Tips

**Keep claude-mem healthy:**
- Regularly check viewer UI to see if observations are being captured
- Monitor database size (shouldn't grow unbounded)
- Update plugin when new versions are released
- Keep Claude Code updated

**Performance tuning:**
- Adjust `CLAUDE_MEM_CONTEXT_OBSERVATIONS` if context is too large/small
- Use `/clear` to mark sessions complete and start fresh
- Use search skill to query specific memories instead of loading everything
