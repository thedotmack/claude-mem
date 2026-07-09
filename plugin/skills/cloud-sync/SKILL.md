---
name: cloud-sync
description: Set up or check claude-mem cloud sync with cmem.ai Pro. Use when the user says "set up cloud sync", "sync my memories", "cmem pro", "cloud backup", "sync status", or wants their memory database backed up or synced to their cmem.ai account.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# Cloud Sync (cmem.ai Pro)

The worker syncs memories itself: every write nudges a background flusher that
drains unsynced rows to cmem.ai. There is no daemon to install or babysit. This
skill is a thin front-end — check status, and on first run collect credentials,
retire the old standalone client, and restart the worker so it picks them up.

**Security rule for this entire skill:** NEVER print the sync token, never put
it in a command-line argument (argv is visible to other processes), and never
log it. It travels only inside heredoc-fed stdin scripts or files that already
hold it. When confirming, report its length — not its value.

## 1. Check status

Resolve the worker port (env → `~/.claude-mem/settings.json` → per-UID default
`37700 + (uid % 100)`, matching how the worker picks its own port; re-run this
in any fresh shell before the curls in step 5):

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
curl -s "http://127.0.0.1:${PORT}/api/sync/status"
```

Responses:

- `{"configured": true, "deviceId": ..., "pending": {"observations": N, "summaries": N, "prompts": N}, "lastFlushAt": ..., "lastError": ...}` → go to step 2.
- `{"configured": false}` → go to step 3.
- **404 / 503 / connection refused** → the route registers late during worker
  startup, so a request right after a restart can miss it. Retry every 3s for
  ~15s before concluding anything. If 404 persists, the running worker predates
  cloud sync — restart it with the command in step 5, wait, and retry.

## 2. Already configured → report and stop

Report the three pending counts, `lastFlushAt`, and `lastError` (null means
healthy). Pending counts near 0 mean the cloud copy is current. Done — do not
run the setup steps below.

## 3. Not configured → obtain credentials

Priority order:

**(a) Legacy standalone client present.** If `~/.claude-mem/.cloud-sync.env`
exists, the user already set up the old standalone sync client. Tell them:
"Found your existing standalone cloud-sync setup — migrating it into the
worker. Your token and device identity carry over; nothing re-uploads." Do NOT
`cat` the file or print its values. Migrate it with this script (it reads the
file itself, so the token never enters the conversation):

```bash
node - <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const dir = path.join(os.homedir(), '.claude-mem');
const env = fs.readFileSync(path.join(dir, '.cloud-sync.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';
const token = get('CMEM_SYNC_TOKEN'), userId = get('CMEM_USER_ID');
if (!token || !userId) { console.error('legacy env file is missing CMEM_SYNC_TOKEN or CMEM_USER_ID'); process.exit(1); }
const file = path.join(dir, 'settings.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN = token;
settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID = userId;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
fs.chmodSync(file, 0o600);
console.log(`migrated: token length ${token.length}, user id length ${userId.length}`);
EOF
```

**(b) No legacy file.** Use AskUserQuestion to ask the user to paste two
values from **cmem.ai → Connect**: their sync token and their user id. Then
write them with the same merge script, embedding the two values as string
literals inside the quoted heredoc (heredoc body is stdin, not argv — the
token stays off the command line; do not echo it back afterward):

```bash
node - <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const token = 'PASTE_TOKEN_HERE';
const userId = 'PASTE_USER_ID_HERE';
const file = path.join(os.homedir(), '.claude-mem', 'settings.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN = token;
settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID = userId;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
fs.chmodSync(file, 0o600);
console.log(`saved: token length ${token.length}, user id length ${userId.length}`);
EOF
```

Merge rules (both paths, non-negotiable): parse the existing JSON and merge
the two keys in — never clobber other settings, never rewrite the file from a
template, and restore file mode 0600 after writing (both scripts above do
this).

## 4. Retire the legacy daemon

The standalone client is superseded by worker-native sync. If it is still
running it would double-upload, so shut it down and archive its artifacts:

```bash
D="$HOME/.claude-mem"
if [ -f "$D/cloud-sync.pid" ]; then
  LEGACY_PID=$(cat "$D/cloud-sync.pid")
  if [ -n "$LEGACY_PID" ] && ps -p "$LEGACY_PID" -o command= 2>/dev/null | grep -q cloud-sync; then
    kill "$LEGACY_PID"
  fi
fi
for f in cloud-sync.mjs .cloud-sync.env cloud-sync.pid; do
  [ -f "$D/$f" ] && mv "$D/$f" "$D/$f.retired"
done
ls "$D" | grep retired
```

**Leave `~/.claude-mem/cloud-sync-state.json` exactly where it is.** The
worker's migration stamps already-synced rows from its cursors and adopts its
device id — renaming or deleting it forks every cloud row into a duplicate.

## 5. Restart the worker and watch it drain

The worker reads credentials at startup, so restart it:

```bash
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
```

The old worker spawns its own successor once its port closes — do not spawn or
kill anything yourself; the POST is the entire restart. Then poll:

```bash
curl -s "http://127.0.0.1:${PORT}/api/sync/status"
```

every ~5s. Tolerate connection-refused/404 for the first ~30s (successor
booting, route registering late). Expect `configured: true` with the pending
counts falling as the flusher drains. Stop polling when either:

- all three pending counts reach 0, or
- the counts stop changing across 3 consecutive polls with `lastError` null —
  a large first backfill flushes in batches and can take minutes; report the
  current counts and note the worker keeps draining in the background.

If `lastError` is non-null and pending is not moving, report the error text
verbatim (it never contains the token) and suggest re-checking the token and
user id against cmem.ai → Connect.

## 6. Report

- **Status check (already configured):** pending counts, last flush time,
  last error.
- **First-time setup:** device id from the status response, what the counts
  drained to, whether a legacy client was migrated/retired, and this one-line
  privacy note:

> Cloud sync uploads your observation narratives and full prompt text to your
> cmem.ai account.
