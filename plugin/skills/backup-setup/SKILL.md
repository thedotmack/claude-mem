---
name: backup-setup
description: Set up, check, or restore claude-mem database backups. Use when the user says "set up backups", "back up my memories", "backup status", "restore my database", or "I'm on a new machine". Local snapshots are free; encrypted cloud copies are a cmem.ai Pro add-on.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
argument-hint: [setup|cloud|restore|status]
---

# Backups (local snapshots + cmem Pro cloud add-on)

The installed worker snapshots `~/.claude-mem/claude-mem.db` on a schedule
(`VACUUM INTO`, consistent while sessions run) and keeps the newest N under
`~/.claude-mem/backups/auto/`. With the cmem Pro **backup add-on**, each
snapshot is also encrypted on this machine and uploaded to your cmem.ai
account.

**Security rule:** never print, echo, or log `CLAUDE_MEM_BACKUP_ENCRYPTION_KEY`
or the cloud sync token — not in argv, not in output. Confirm presence only.
Preserve every unrelated setting and keep `~/.claude-mem/settings.json` mode
`0600`.

## Routing

Based on `$ARGUMENTS`:
- `setup` or empty → **1. Check status**, then **2. Enable local snapshots**
- `cloud` → **3. Enable cloud copies**
- `restore` → **4. Restore drill**
- `status` → **1. Check status** only

## 1. Check status

Resolve the worker port and query the always-registered status route:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
curl -s "http://127.0.0.1:${PORT}/api/backup/status"
```

- `configured: true` → backups run. Report `lastSnapshotAt`, `snapshotCount`,
  `cloudEnabled`, `lastUploadAt`, and `lastError`; stop unless the user asked
  for a change or a restore.
- `configured: false` → backups are off; continue to step 2 if setting up.
- `addonRequired: true` → cloud uploads are paused because the account lacks
  the backup add-on. Local snapshots keep running. Point the user at
  https://cmem.ai/dashboard?from=backup-addon to add it.
- Connection refused, 404, or 503 immediately after restart → retry every
  three seconds for about 30 seconds before diagnosing the worker.

## 2. Enable local snapshots (free)

Ask (or default): interval in hours (default 24, range 1–168) and how many
snapshots to keep (default 7, range 1–100). Then write settings without
echoing anything else in the file:

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

Restart the worker so the schedule loop starts, then verify:

```bash
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
```

Poll `GET /api/backup/status` every five seconds for up to 30 seconds until
`configured: true`. The first automatic snapshot lands about five minutes
after worker start; to take one immediately:

```bash
curl -s -X POST "http://127.0.0.1:${PORT}/api/backup/run" -H 'Content-Type: application/json' -d '{}'
```

## 3. Enable cloud copies (cmem Pro add-on)

Cloud copies require:

1. **cmem Pro cloud-sync credentials** already configured
   (`CLAUDE_MEM_CLOUD_SYNC_TOKEN`, `_USER_ID`, `_HUB_URL`) — if missing, run
   the `/cloud-sync` skill first.
2. The **backup add-on** on the cmem.ai account.
3. `CLAUDE_MEM_BACKUP_CLOUD = 'true'`:

```bash
node - <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const dir = path.join(os.homedir(), '.claude-mem');
const file = path.join(dir, 'settings.json');
fs.mkdirSync(dir, { recursive: true });
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const target = settings.env && typeof settings.env === 'object' ? settings.env : settings;
target.CLAUDE_MEM_BACKUP_ENABLED = 'true';
target.CLAUDE_MEM_BACKUP_CLOUD = 'true';
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log('cloud backup copies enabled');
EOF
```

Restart the worker (same command as step 2). On the first cloud-enabled
snapshot the worker mints `CLAUDE_MEM_BACKUP_ENCRYPTION_KEY` (32 random
bytes) and persists it to settings.json itself — do not create or paste one.

**Add-on 403 behavior:** if the account lacks the add-on, the hub answers the
upload with `403 addon_required`. The worker then pauses cloud uploads for
24 hours (no retry storm), keeps local snapshots running, and
`GET /api/backup/status` reports `addonRequired: true`. After the user adds
the add-on at https://cmem.ai/dashboard?from=backup-addon, the next daily
cycle — or a manual `POST /api/backup/run` after the 24h marker expires —
resumes uploads.

## 4. Restore drill

List what exists:

```bash
npx claude-mem backup list
```

**Local restore** (worker running or not — the CLI handles both):

```bash
npx claude-mem restore <file>
```

The worker saves the current DB as `claude-mem.db.pre-restore-<ts>` before
swapping, then restarts itself on the restored database.

**Cloud restore** (new machine: configure cloud-sync credentials first, and
copy `CLAUDE_MEM_BACKUP_ENCRYPTION_KEY` from the old machine's
`~/.claude-mem/settings.json` — without it, cloud backups cannot be
decrypted):

```bash
npx claude-mem restore --cloud
```

Optionally pass a specific `<key>` from the listed cloud backups. Afterwards,
verify observation counts look right via `GET /api/backup/status` and the
viewer.

## 5. Report

Report snapshot count, last snapshot time, whether cloud copies are on, last
upload time, and any error. End with this privacy note:

> Cloud backup copies are encrypted on your machine with a key that never
> leaves it. cmem.ai stores only ciphertext and cannot read your memories —
> which also means: lose the key, lose the cloud backups. Keep
> `~/.claude-mem/settings.json` safe.
