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

## 1. Check status

Resolve the worker port and query the always-registered status route:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
curl -s --max-time 20 "http://127.0.0.1:${PORT}/api/sync/status"
```

The route makes a live Hub probe, so it is not instant. It bounds that probe
itself; `--max-time` is belt-and-braces so a wedged worker cannot block you.

- `configured: true` and `hub.reachable: true` → the worker completed an
  authenticated `GET /v1/sync/status` against SyncHub. Report `deviceId`,
  pending counts, `lastFlushAt`, `lastProgressAt`, `lastError`, and the Hub
  head/checkpoint, then classify the drain per §5; stop unless the user asked
  to replace the connection.
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

Report device id, pending counts (including `pending.content`, the live
snapshots waiting on an ack — a backlog can sit entirely there while
`pending.observations` reads 0), Hub reachability and checkpoint, and any
Hub/flush error.

Classify the drain before reporting. **`lastFlushAt: null` is not a failure.**
It is set only after a flush that drains every lane with zero errors, so any
account with a real backlog will show `null` there for a long time while
syncing perfectly well. The field that separates the states is
`lastProgressAt` — the last time a batch was actually acked and stamped.

| State | Shape | What to say |
|---|---|---|
| **Done** | `lastFlushAt` non-null, every `pending.*` 0, `lastError: null`, `hub.projectedSeq === hub.headSeq` | Fully synced. |
| **Draining** | `lastProgressAt` recent (or `flushing: true`), pending counts falling between two checks | Working through a backlog. Give the counts, `nextRetryAt`, and the Hub `headSeq`/`projectedSeq` gap. Do not call this an error, even with a non-null `lastError` — a retryable `projection_busy` is back-pressure, and the next attempt is already scheduled. |
| **Wedged** | `lastProgressAt` null or unchanged across two checks minutes apart, pending counts flat, same `lastError` each time | Report `lastError`, `nextRetryAt`, and the `headSeq`/`projectedSeq` gap, and say the drain is not making progress. |

To tell draining from wedged, poll the status route twice about a minute
apart and compare `lastProgressAt` and the pending totals. One sample cannot
distinguish them. Do not advise restarting the worker to "unstick" a drain:
each restart buys one batch and discards a backoff that exists to respect the
Hub's projection lease.

End with this privacy note:

> Cloud sync uploads your observation narratives and full prompt text to your
> cmem.ai account.
