# Phase 0 End-to-End Test Plan

## Overview
This test plan validates the complete claude-mem pipeline from session start through context injection in a new session. The test verifies that logging, worker processes, database updates, and context retrieval all function correctly.

---

## Section 1: Pre-Test Checklist

### Current Database State (as of 2025-10-16)
- **Database Location:** `~/.claude-mem/claude-mem.db`
- **Total SDK Sessions:** 37 sessions recorded
- **Active Sessions:** 0 (all sessions properly closed)
- **Completed Sessions:** 22
- **Session Summaries:** 0 (ISSUE: No summaries despite completed sessions)
- **Recent Sessions:**
  ```
  ID 37: completed at 2025-10-16T21:39:18.888Z, project: claude-mem
  ID 36: completed at 2025-10-16T21:24:30.850Z, project: claude-mem
  ID 35: completed at 2025-10-16T21:11:12.929Z, project: claude-mem-test
  ID 34: completed at 2025-10-16T20:59:43.438Z, project: claude-mem-test
  ID 33: completed at 2025-10-16T20:55:15.426Z, project: claude-mem-test
  ```

### Current Worker State
- **Running Workers:** None detected
- **Socket Files:** No active sockets in /tmp/
- **Command Used:** `ps aux | grep claude-mem-worker | grep -v grep`

### Logging Verification in Compiled Files
- **summary-hook.js:** Contains 3 instances of `[claude-mem summary]` logging
- **context-hook.js:** Contains 3 instances of `[claude-mem context]` logging
- **worker.js:** Contains multiple instances of `[claude-mem worker]` logging
- **Status:** CONFIRMED - All logging survived the build process

### Pre-Test Issues Identified
1. Zero session_summaries despite 22 completed SDK sessions - suggests summary generation may not be working
2. No active workers or sockets - clean state for testing

---

## Section 2: Test Execution Steps

### Step 1: Clean Slate (Optional - if you want to start fresh)
```bash
# Backup current database
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/backups/claude-mem-backup-$(date +%Y%m%d-%H%M%S).db

# Optional: Clear old sessions if desired
# sqlite3 ~/.claude-mem/claude-mem.db "DELETE FROM sdk_sessions WHERE status = 'completed'"
# sqlite3 ~/.claude-mem/claude-mem.db "DELETE FROM session_summaries"
```

### Step 2: Start Claude Code Session 1
```bash
# Navigate to the test project
cd /Users/alexnewman/Scripts/claude-mem

# Start Claude Code
# Logs will show context-hook.js firing
# Expected: "[claude-mem context] Hook fired with input:"
claude
```

### Step 3: Do Some Work in Session 1
Within the Claude Code session, ask Claude to perform meaningful work:
```
Please help me:
1. Read the README.md file
2. Analyze the project structure
3. List the main TypeScript files in src/
4. Create a simple test file at test/example.test.ts with a placeholder test
```

Wait for Claude to complete all tasks.

### Step 4: Exit Session 1
```bash
# Type exit or Ctrl+D to end the session
# Expected: summary-hook.js will fire
# Expected: "[claude-mem summary] Hook fired" message
# Expected: Worker will process and generate summary
exit
```

### Step 5: Check Database for Summary
```bash
# Wait 5-10 seconds for worker to complete processing
sleep 10

# Check if a new SDK session was created
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, status, started_at, project FROM sdk_sessions ORDER BY started_at_epoch DESC LIMIT 3"

# Check if summary was generated
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, request, completed, created_at FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 1"

# Check observations
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE sdk_session_id = (SELECT sdk_session_id FROM sdk_sessions ORDER BY started_at_epoch DESC LIMIT 1)"
```

### Step 6: Start Claude Code Session 2
```bash
# Start a new session in the same project
cd /Users/alexnewman/Scripts/claude-mem
claude
```

### Step 7: Ask Claude About Previous Session
Within Session 2, ask:
```
What did we work on in the previous session? What files were modified?
```

Claude should reference the previous session context that was injected.

### Step 8: Collect All Logs
```bash
# Exit session 2
exit

# Collect logs (location depends on your Claude Code setup)
# Check stderr output from both sessions
# Filter for claude-mem messages
```

---

## Section 3: What to Look For

### Expected Log Sequence from Summary Hook
```
[claude-mem summary] Hook fired
[claude-mem summary] Searching for active SDK session
[claude-mem summary] Active SDK session found
[claude-mem summary] Attempting to send FINALIZE message to worker socket
[claude-mem summary] Socket connection established, sending message
[claude-mem summary] Socket connection closed successfully
```

### Expected Log Sequence from Worker
```
[claude-mem worker] Worker instance created
[claude-mem worker] Worker run() started
[claude-mem worker] Session loaded successfully
[claude-mem worker] Socket server started successfully
[claude-mem worker] Starting SDK agent
[claude-mem worker] SDK session initialized
[claude-mem worker] SDK agent response received
[claude-mem worker] Parsing agent message for observations and summary
[claude-mem worker] Summary parsed successfully
[claude-mem worker] Storing summary in database
[claude-mem worker] Summary stored successfully in database
[claude-mem worker] SDK agent completed, marking session as completed
[claude-mem worker] Cleaning up worker resources
```

### Expected Log Sequence from Context Hook
```
[claude-mem context] Hook fired with input:
[claude-mem context] Source check passed - proceeding with context load
[claude-mem context] Extracted project name: claude-mem from cwd: /Users/alexnewman/Scripts/claude-mem
[claude-mem context] Querying database for recent summaries...
[claude-mem context] Database query complete - found X summaries
[claude-mem context] Building markdown context from summaries...
[claude-mem context] Markdown built successfully
[claude-mem context] Outputting context to stdout for Claude Code injection
[claude-mem context] Context hook completed successfully
```

### How to Verify Summary in Database
After Session 1 exits, the summary should contain:
- **request:** Description of what was asked
- **investigated:** Files/areas examined
- **learned:** Key findings
- **completed:** What was accomplished
- **next_steps:** Recommendations
- **files_read:** JSON array of files read
- **files_edited:** JSON array of files modified (should include test/example.test.ts)

### How to Verify Context Was Loaded
In Session 2:
1. Claude should reference the previous session without being told
2. The context-hook.js logs should show summaries were found and loaded
3. Claude's response should mention specific files or tasks from Session 1

---

## Section 4: Log Collection Commands

### Filter Logs for Summary Hook
```bash
# From Claude Code stderr output
grep "\[claude-mem summary\]" ~/.claude-code/logs/*.log 2>/dev/null || echo "Check your Claude Code log location"

# Alternative: redirect stderr during session
claude 2>&1 | tee /tmp/claude-session.log
# Then: grep "\[claude-mem summary\]" /tmp/claude-session.log
```

### Filter Logs for Context Hook
```bash
grep "\[claude-mem context\]" /tmp/claude-session.log
```

### Filter Logs for Worker
```bash
grep "\[claude-mem worker\]" /tmp/claude-session.log
```

### Search for Errors
```bash
# Search for any errors in the logs
grep -i "error\|fail\|exception" /tmp/claude-session.log | grep claude-mem

# Check for database errors
grep "sqlite\|database" /tmp/claude-session.log | grep -i error
```

### Verify Each Step of the Pipeline
```bash
# 1. Verify session was created
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM sdk_sessions WHERE id = (SELECT MAX(id) FROM sdk_sessions)"

# 2. Verify worker socket was created (during session)
ls -la /tmp/claude-mem-worker-*.sock

# 3. Verify observations were recorded
sqlite3 ~/.claude-mem/claude-mem.db "SELECT type, text FROM observations WHERE sdk_session_id = (SELECT sdk_session_id FROM sdk_sessions ORDER BY started_at_epoch DESC LIMIT 1)"

# 4. Verify summary was created
sqlite3 ~/.claude-mem/claude-mem.db "SELECT request, completed, files_edited FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 1"
```

### Monitor Worker Process
```bash
# During session, check if worker is running
watch -n 1 "ps aux | grep claude-mem-worker | grep -v grep"

# Check worker socket
watch -n 1 "ls -la /tmp/claude-mem-worker-*.sock 2>/dev/null"
```

---

## Section 5: Success Criteria

### Must Pass (Critical)
- [ ] Session 1 creates an entry in sdk_sessions with status='active'
- [ ] Context hook fires at Session 1 start and logs show it ran
- [ ] Summary hook fires at Session 1 exit and logs show it ran
- [ ] Worker process starts and creates a socket file
- [ ] Worker receives FINALIZE message from summary hook
- [ ] Summary is successfully parsed and stored in session_summaries table
- [ ] Session status changes from 'active' to 'completed'
- [ ] Socket file is cleaned up after worker exits
- [ ] Session 2 starts and context hook fires
- [ ] Context hook finds summaries and injects them as markdown
- [ ] Claude references previous session in Session 2

### Should Pass (Important)
- [ ] Observations are recorded in the observations table
- [ ] files_read and files_edited are populated in summary
- [ ] No error messages in logs
- [ ] Worker process exits cleanly
- [ ] No zombie workers or stale sockets remain

### Nice to Have
- [ ] All log messages are clear and informative
- [ ] Timing is reasonable (summary generation < 30 seconds)
- [ ] Multiple sessions can be loaded in context
- [ ] Context markdown is well-formatted

### Known Issues to Monitor
- [ ] Zero summaries in current database despite 22 completed sessions - needs investigation
- [ ] Verify worker is actually spawned (new-hook.js responsible for this)
- [ ] Confirm SDK session ID is properly set

---

## Troubleshooting Guide

### If Summary Hook Doesn't Fire
1. Check that hooks are properly configured in ~/.claude/hooks.json
2. Verify summary-hook.js has execute permissions
3. Check Claude Code version supports hooks

### If Worker Doesn't Start
1. Check new-hook.js logs - it should spawn the worker
2. Verify worker.js has execute permissions
3. Check for port/socket conflicts

### If Summary Is Not Generated
1. Check worker logs for parsing errors
2. Verify SDK agent is responding with expected XML format
3. Check database write permissions

### If Context Doesn't Load
1. Verify summaries exist in database
2. Check context-hook.js logs for query results
3. Verify project name extraction is correct

---

## Next Steps After Test

1. If test passes: Proceed to Phase 1 (advanced features)
2. If test fails: Collect all logs and diagnostic info
3. Document any issues found
4. Update code as needed
5. Re-run test until success criteria met
