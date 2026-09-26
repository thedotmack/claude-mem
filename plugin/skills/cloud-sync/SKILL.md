---
name: cloud-sync
description: Set up or check claude-mem cloud sync with cmem.ai Pro. Use when the user says "set up cloud sync", "sync my memories", "cmem pro", "cloud backup", "sync status", or wants their memory database backed up or synced to their cmem.ai account.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# Cloud Sync (cmem.ai Pro)

The installed worker syncs through SyncHub. There is one client, one durable
operation log, and no separate sync daemon. This skill checks status or writes
the three connection values issued by **cmem.ai → Connect**.

**Security rule:** never print the sync token, put it in argv, or log it.
Confirm only its length. Preserve every unrelated setting and keep
`~/.claude-mem/settings.json` mode `0600`.

## 0. Ensure a SyncHub-capable build

SyncHub requires claude-mem **>= 13.12.0**. Self-update before anything else,
since older builds have no `/api/sync/*` routes and every later step will fail.

Do not judge this from a manifest on disk. The launcher prefers a *cached*
plugin over the marketplace checkout, so an up-to-date marketplace clone can sit
next to an older cached build that is the one actually serving. Ask the running
worker instead — `/api/health` reports both its version and the path it was
loaded from:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
curl -s "http://127.0.0.1:${PORT}/api/health"
# {"status":"ok","version":"13.12.4","workerPath":"…/plugin/scripts/worker-service.cjs"}
```

Version **>= 13.12.0** → go to step 1. Otherwise update the marketplace
checkout, restart, and re-read `/api/health`:

```bash
DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/thedotmack"
git -C "$DIR" pull --ff-only
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
START=$(date +%s)
# Poll for the successor; do not read health once. The restart endpoint acks
# before the outgoing worker releases the listener, so an immediate read is
# answered by the process being replaced and still reports the pre-update
# build. Accept a reading only once its uptime is shorter than the time since
# the restart was requested — that is what proves it is the new process.
for _ in $(seq 1 15); do
  sleep 2
  curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" \
    | CMEM_SINCE=$(( $(date +%s) - START )) node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!(j.uptime<+process.env.CMEM_SINCE))process.exit(1);j.version+" "+j.workerPath' 2>/dev/null && break
done
```

Connection failures and 503s during that window are expected, not a diagnosis —
there is a real gap between the old worker exiting and the new one listening.

If `/api/health` still reports an older version after that restart, the launcher
is starting a stale cached copy — `workerPath` names the offending file, and
cached builds live under
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/thedotmack/claude-mem/<version>`.
Report the running version and `workerPath`, and stop. Never continue to step 1
against a build below 13.12.0: its `/api/sync/*` routes do not exist, so every
later check would misreport.

## 1. Check status

Reusing `$PORT` from step 0, query the always-registered status route:

```bash
curl -s "http://127.0.0.1:${PORT}/api/sync/status"
```

- `configured: true` and `hub.reachable: true` → the worker completed an
  authenticated `GET /v1/sync/status` against SyncHub. Report `deviceId`,
  pending counts, `lastFlushAt`, `lastError`, and the Hub head/checkpoint;
  stop unless the user asked to replace the connection.
- `configured: true` and `hub.reachable: false` → report `hub.error` and say
  the SyncHub connection is not verified. A zero pending count or
  `lastError: null` is not success because an empty queue performs no push.
- `configured: false` → continue.
- Connection refused, 404, or 503 immediately after restart → retry every
  three seconds for about 30 seconds before diagnosing the worker.

## 2. Obtain the connection

Ask for all three values shown by **cmem.ai → Connect**:

1. sync token;
2. user id;
3. SyncHub URL.

The Hub URL must be an absolute `https://` URL. Do not substitute the cmem.ai
application API URL; the installed client talks only to SyncHub.

## 3. Write installed-client settings

Substitute the collected values inside this quoted stdin script. Do not echo
them before or after running it:

```bash
node - <<'EOF'
const fs = require('fs'), os = require('os'), path = require('path');
const token = 'PASTE_TOKEN_HERE';
const userId = 'PASTE_USER_ID_HERE';
const hubUrl = 'PASTE_HUB_URL_HERE';
if (!token || !userId || !/^https:\/\/[^\s]+$/.test(hubUrl)) {
  console.error('token, user id, and an https SyncHub URL are required');
  process.exit(1);
}
const dir = path.join(os.homedir(), '.claude-mem');
const file = path.join(dir, 'settings.json');
fs.mkdirSync(dir, { recursive: true });
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const target = settings.env && typeof settings.env === 'object' ? settings.env : settings;
target.CLAUDE_MEM_CLOUD_SYNC_TOKEN = token;
target.CLAUDE_MEM_CLOUD_SYNC_USER_ID = userId;
target.CLAUDE_MEM_CLOUD_SYNC_HUB_URL = hubUrl.replace(/\/+$/, '');
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`saved cloud connection: token length ${token.length}, user id length ${userId.length}`);
EOF
```

These are the only required connection keys. The worker mints and persists a
device id on first start and defaults the device name to the hostname.

## 4. Restart and verify

```bash
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
```

Poll the status route every five seconds for up to 30 seconds while the
successor starts. Success means `configured: true`, `hub.reachable: true`, and
`lastError: null`. The local route always makes an authenticated, read-only
SyncHub status probe, even when every pending count is zero; it never uses a
legacy cmem.ai Pro status route and never appends or advances sync state.
Pending counts describe only writes made after the SyncHub launch baseline;
setup does not migrate a pre-launch local corpus.

If `hub.reachable` is false, report `hub.error`. If `lastError` is non-null,
report it too. Ask the user to verify the three values in **cmem.ai →
Connect**. Never include the token.

## 5. Report

Report device id, pending counts, last successful flush, Hub reachability and
checkpoint, and any Hub/flush error. End with this privacy note:

> Cloud sync uploads your observation narratives and full prompt text to your
> cmem.ai account.
