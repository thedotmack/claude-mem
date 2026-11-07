---
name: backup-setup
description: Set up, check, or restore local claude-mem database snapshots. Use when the user says "set up backups", "back up my memories", "backup status", or "restore my database".
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
argument-hint: [setup|restore|status]
---

# Backups (local snapshots)

The installed worker snapshots `~/.claude-mem/claude-mem.db` on a schedule
(`VACUUM INTO`, consistent while sessions run) and keeps the newest N under
`~/.claude-mem/backups/auto/`. Each snapshot is one standalone SQLite file.
Snapshots stay on this machine.

Preserve every unrelated setting and keep `~/.claude-mem/settings.json` mode
`0600`. Never print the file's contents: it holds credentials.

## Routing

Based on `$ARGUMENTS`:
- `setup` or empty: **1. Check status**, then **2. Enable snapshots**
- `restore`: **3. Restore**
- `status`: **1. Check status** only

## 1. Check status

```bash
npx claude-mem backup status
```

- Snapshot details printed: backups run. Report the last snapshot time, the
  snapshot count and any last error; stop unless the user asked for a change
  or a restore.
- "Automatic backups are not enabled": continue to step 2 if setting up.
- A "Last restore" line reports the outcome of the most recent restore.
- "Worker is not running": start it with `npx claude-mem start` and retry.
- "Unknown command: backup" or "Backup status failed: HTTP 404": this
  claude-mem (CLI or running worker) has no backup support yet, so the
  worker would ignore the backup settings.
  Stop. Tell the user that backups are not available in their installed
  version and that `npx claude-mem update` brings them once a release
  includes them. Do not write the settings in step 2, and never say backups
  are on.
- Any other failure ("Backup status failed: HTTP" with another status,
  "Backup request failed: ...", "Backup status failed: invalid JSON
  response", "Backup status failed: unexpected response") or any output not
  listed here: stop. Show the user the exact error line, do not write the
  settings in step 2, and never say backups are on. Do not suggest an
  update: this is an error in a version that has backups, not a missing
  feature.

## 2. Enable snapshots

Ask (or default): interval in hours (default 24, range 1 to 168) and how
many snapshots to keep (default 7, range 1 to 100). Then write the settings
without echoing anything else in the file:

```bash
node - <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const intervalHours = 'PASTE_INTERVAL_HOURS_HERE'; // e.g. '24'
const retainCount = 'PASTE_RETAIN_COUNT_HERE';     // e.g. '7'
const dir = path.join(os.homedir(), '.claude-mem');
const file = path.join(dir, 'settings.json');
fs.mkdirSync(dir, { recursive: true });
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const target = settings.env && typeof settings.env === 'object' ? settings.env : settings;
target.CLAUDE_MEM_BACKUP_ENABLED = 'true';
target.CLAUDE_MEM_BACKUP_INTERVAL_HOURS = intervalHours;
target.CLAUDE_MEM_BACKUP_RETAIN_COUNT = retainCount;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log('backups enabled: every ' + intervalHours + 'h, keeping ' + retainCount);
EOF
```

Restart the worker so the schedule starts, then confirm with step 1. Tell
the user backups are on only when that status reports them enabled:

```bash
npx claude-mem restart
npx claude-mem backup status
```

The first automatic snapshot lands about five minutes after the worker
starts. To take one now:

```bash
npx claude-mem backup run
```

## 3. Restore

```bash
npx claude-mem backup list
npx claude-mem restore <file>
npx claude-mem backup status
```

`restore` stages the snapshot and restarts the worker (it also starts a
worker that is not running). The new worker swaps the database in before it
opens it, saves the database it replaced in the same folder as
`claude-mem-<timestamp>-pre-restore.db` (restore that file to undo; it counts
toward the retain count), and records the outcome. With cloud sync on, the
restored database resumes syncing from the snapshot's position and can pull
back changes that reached the cloud after it. `backup status` then prints a "Last restore" line: on success it
names the saved copy; on failure it gives the reason, and the worker kept
the database it had.

## 4. Report

Report the snapshot count, the last snapshot time, any error, and the last
restore outcome if there was one.
