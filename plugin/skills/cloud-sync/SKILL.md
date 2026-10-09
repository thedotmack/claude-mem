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
operation log, and no separate sync daemon. This skill checks status and points
the user to the installer's cmem.ai sign-in, which writes the connection.

**Security rule:** never ask the user to paste the sync token into this chat,
and never put it in a command you write, print it, put it in argv, or log it. A
secret pasted into a chat lands in the transcript, which claude-mem itself can
capture and sync. The installer writes the token to
`~/.claude-mem/settings.json` (mode `0600`) without it ever passing through
this conversation.

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

## 2. Connect through the installer

Ask the user to run this in their own terminal:

```bash
npx claude-mem install
```

and to choose **CMEM Pro** when the installer asks. The installer signs them in
through the browser (they approve a device code), then writes the sync token,
user id and SyncHub URL into `~/.claude-mem/settings.json` itself and restarts
the worker. Nothing secret is typed into this chat.

If the user cannot run the installer interactively (CI, a remote box), point
them to the headless setup guide, https://docs.claude-mem.ai/cmem-pro-headless,
and let them apply its manual recipe in their own terminal or editor. Do not
collect the values yourself.

The worker mints and persists a device id on first start and defaults the device
name to the hostname.

## 3. Verify

Once the installer finishes, poll the status route every five seconds for up to
30 seconds. If the worker was not restarted, restart it first:

```bash
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
```

Success means `configured: true`, `hub.reachable: true`, and `lastError: null`.
The local route always makes an authenticated, read-only SyncHub status probe,
even when every pending count is zero; it never uses a legacy cmem.ai Pro status
route and never appends or advances sync state. Pending counts describe only
writes made after the SyncHub launch baseline; setup does not migrate a
pre-launch local corpus.

If `hub.reachable` is false, report `hub.error`. If `lastError` is non-null,
report it too, and suggest running `npx claude-mem install` again to refresh the
connection. Never include the token.

## 4. Report

Report device id, pending counts, last successful flush, Hub reachability and
checkpoint, and any Hub/flush error. End with this privacy note:

> Cloud sync uploads your observation narratives and full prompt text to your
> cmem.ai account.
