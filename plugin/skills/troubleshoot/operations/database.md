# Database Diagnostics

SQLite database troubleshooting for claude-mem.

## Database Overview

Claude-mem uses SQLite3 for persistent storage:
- **Location:** `~/.claude-mem/claude-mem.db`
- **Library:** better-sqlite3 (synchronous, not bun:sqlite)
- **Features:** FTS5 full-text search, triggers, indexes
- **Tables:** observations, sessions, user_prompts, observations_fts, sessions_fts, prompts_fts

## Basic Database Checks

### Check Database Exists

```bash
# Check file exists
ls -lh ~/.claude-mem/claude-mem.db

# Check file size
du -h ~/.claude-mem/claude-mem.db

# Check permissions
ls -la ~/.claude-mem/claude-mem.db
```

**Expected:**
- File exists
- Size: 100KB - 10MB+ (depends on usage)
- Permissions: Readable/writable by your user

### Check Database Integrity

```bash
# Run integrity check
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
```

**Expected output:** `ok`

**If errors appear:**
- Database corrupted
- Backup immediately: `cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup`
- Consider recreating (data loss)

## Data Inspection

### Count Records

```bash
# Observation count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"

# Session count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sessions;"

# User prompt count
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM user_prompts;"

# FTS5 table counts (should match main tables)
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations_fts;"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM sessions_fts;"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM prompts_fts;"
```

### View Recent Records

```bash
# Recent observations
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  created_at,
  type,
  title,
  project
FROM observations
ORDER BY created_at DESC
LIMIT 10;
"

# Recent sessions
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  created_at,
  request,
  project
FROM sessions
ORDER BY created_at DESC
LIMIT 5;
"

# Recent user prompts
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  created_at,
  prompt
FROM user_prompts
ORDER BY created_at DESC
LIMIT 10;
"
```

### Check Projects

```bash
# List all projects
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT DISTINCT project
FROM observations
ORDER BY project;
"

# Count observations per project
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  project,
  COUNT(*) as count
FROM observations
GROUP BY project
ORDER BY count DESC;
"
```

## Database Schema

### View Table Structure

```bash
# List all tables
sqlite3 ~/.claude-mem/claude-mem.db ".tables"

# Show observations table schema
sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"

# Show all schemas
sqlite3 ~/.claude-mem/claude-mem.db ".schema"
```

### Expected Tables

- `observations` - Main observation records
- `observations_fts` - FTS5 virtual table for full-text search
- `sessions` - Session summary records
- `sessions_fts` - FTS5 virtual table for session search
- `user_prompts` - User prompt records
- `prompts_fts` - FTS5 virtual table for prompt search

## FTS5 Synchronization

The FTS5 tables should stay synchronized with main tables via triggers.

### Check FTS5 Sync

```bash
# Compare counts
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  (SELECT COUNT(*) FROM observations) as observations,
  (SELECT COUNT(*) FROM observations_fts) as observations_fts,
  (SELECT COUNT(*) FROM sessions) as sessions,
  (SELECT COUNT(*) FROM sessions_fts) as sessions_fts,
  (SELECT COUNT(*) FROM user_prompts) as prompts,
  (SELECT COUNT(*) FROM prompts_fts) as prompts_fts;
"
```

**Expected:** All pairs should match (observations = observations_fts, etc.)

### Fix FTS5 Desync

If FTS5 counts don't match, triggers may have failed. Restart worker to rebuild:

```bash
pm2 restart claude-mem-worker
```

The worker will rebuild FTS5 indexes on startup if they're out of sync.

## Common Database Issues

### Issue: Database Doesn't Exist

**Cause:** First run, or database was deleted

**Fix:** Database will be created automatically on first observation. No action needed.

### Issue: Database is Empty (0 Records)

**Cause:**
- New installation (normal)
- Data was deleted
- Worker not processing observations

**Fix:**
1. Create test observation (use any skill and cancel)
2. Check worker logs for errors:
   ```bash
   pm2 logs claude-mem-worker --lines 50 --nostream
   ```
3. Verify observation appears in database

### Issue: Database Permission Denied

**Cause:** File permissions wrong, database owned by different user

**Fix:**
```bash
# Check ownership
ls -la ~/.claude-mem/claude-mem.db

# Fix permissions (if needed)
chmod 644 ~/.claude-mem/claude-mem.db
chown $USER ~/.claude-mem/claude-mem.db
```

### Issue: Database Locked

**Cause:**
- Multiple processes accessing database
- Crash left lock file
- Long-running transaction

**Fix:**
```bash
# Check for lock file
ls -la ~/.claude-mem/claude-mem.db-wal
ls -la ~/.claude-mem/claude-mem.db-shm

# Remove lock files (only if worker is stopped!)
pm2 stop claude-mem-worker
rm ~/.claude-mem/claude-mem.db-wal ~/.claude-mem/claude-mem.db-shm
pm2 start claude-mem-worker
```

### Issue: Database Growing Too Large

**Cause:** Too many observations accumulated

**Check size:**
```bash
du -h ~/.claude-mem/claude-mem.db
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
```

**Options:**
1. Delete old observations (manual cleanup):
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "
   DELETE FROM observations
   WHERE created_at < datetime('now', '-90 days');
   "
   ```

2. Vacuum to reclaim space:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "VACUUM;"
   ```

3. Archive and start fresh:
   ```bash
   mv ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.archive
   pm2 restart claude-mem-worker
   ```

## Database Recovery

### Backup Database

**Before any destructive operations:**
```bash
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup
```

### Restore from Backup

```bash
pm2 stop claude-mem-worker
cp ~/.claude-mem/claude-mem.db.backup ~/.claude-mem/claude-mem.db
pm2 start claude-mem-worker
```

### Export Data

Export to JSON for safekeeping:

```bash
# Export observations
sqlite3 ~/.claude-mem/claude-mem.db -json "SELECT * FROM observations;" > observations.json

# Export sessions
sqlite3 ~/.claude-mem/claude-mem.db -json "SELECT * FROM sessions;" > sessions.json

# Export prompts
sqlite3 ~/.claude-mem/claude-mem.db -json "SELECT * FROM user_prompts;" > prompts.json
```

### Recreate Database

**WARNING: Data loss. Backup first!**

```bash
# Stop worker
pm2 stop claude-mem-worker

# Backup current database
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.old

# Delete database
rm ~/.claude-mem/claude-mem.db

# Start worker (creates new database)
pm2 start claude-mem-worker
```

## Database Statistics

### Storage Analysis

```bash
# Database file size
du -h ~/.claude-mem/claude-mem.db

# Record counts by type
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  type,
  COUNT(*) as count
FROM observations
GROUP BY type
ORDER BY count DESC;
"

# Observations per month
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  strftime('%Y-%m', created_at) as month,
  COUNT(*) as count
FROM observations
GROUP BY month
ORDER BY month DESC;
"

# Average observation size (characters)
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  AVG(LENGTH(content)) as avg_content_length,
  MAX(LENGTH(content)) as max_content_length
FROM observations;
"
```

## Advanced Queries

### Find Specific Observations

```bash
# Search by keyword (FTS5)
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT title, created_at
FROM observations_fts
WHERE observations_fts MATCH 'authentication'
ORDER BY created_at DESC;
"

# Find by type
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT title, created_at
FROM observations
WHERE type = 'bugfix'
ORDER BY created_at DESC
LIMIT 10;
"

# Find by file path
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT title, created_at
FROM observations
WHERE file_path LIKE '%auth%'
ORDER BY created_at DESC;
"
```

## Database Maintenance

### Regular Maintenance Tasks

```bash
# Analyze for query optimization
sqlite3 ~/.claude-mem/claude-mem.db "ANALYZE;"

# Rebuild FTS5 indexes
sqlite3 ~/.claude-mem/claude-mem.db "
INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild');
"

# Vacuum to reclaim space
sqlite3 ~/.claude-mem/claude-mem.db "VACUUM;"
```

**Run monthly to keep database healthy.**
