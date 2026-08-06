---
name: cloud-sync
description: Set up or check claude-mem cloud sync and bundled Managed Worker access with cmem.ai Pro. Use when the user says "set up cloud sync", "sync my memories", "cmem pro", "managed worker", "cloud backup", "sync status", or wants their memory database backed up or synced to their cmem.ai account.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# Cloud Sync (cmem.ai Pro)

The installed worker syncs through SyncHub. There is one client, one durable
operation log, and no separate sync daemon. This skill checks status or writes
the connection values issued by **cmem.ai → Connect**. A CMEM Pro bundle can
also include a CMEM-only access key for the memory worker; Cloud-only accounts
continue to receive only the three sync values. The provider credential and
selected model never leave CMEM's backend.

**Security rule:** never ask the user to paste the sync token or Managed Worker
key into an AI chat, print either secret, put either one in argv, or log either
one. The Connect page supplies a secret-free local command that collects the
secrets with masked terminal input, preserves unrelated settings, and keeps
`~/.claude-mem/settings.json` mode `0600`.

## 1. Check status

Resolve the worker port and query the always-registered status route:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
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

## 2. Connect securely

Ask the user to open **cmem.ai → Connect**, copy the displayed `npx claude-mem
cloud connect ...` command, and run it in their own terminal. The command itself
contains only the user id and HTTPS endpoint URLs. It prompts locally for the
sync token and, when included in the account, the Managed Worker key; terminal
input is masked and the values are written atomically to the private settings
file.

Do not ask the user to send the secrets to you and do not reconstruct the
command with secret values. The Hub URL must be the absolute `https://` SyncHub
URL shown by Connect. The optional Managed Worker URL and key are always
configured as one block; this is not a general provider API key.

The worker mints and persists a device id on first start and defaults the device
name to the hostname.

## 3. Restart and verify

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

When a Managed Worker block was installed, verify only that the local settings
contain a non-empty key, the CMEM worker URL, and the `cmem-managed` alias. Do
not print their values. The next captured memory performs the real inference
request; Cloud reachability alone must not be reported as inference verification.

## 4. Report

Report device id, pending counts, last successful flush, Hub reachability and
checkpoint, any Hub/flush error, and whether Managed Worker is configured (not
its key or model value). End with this privacy note:

> Cloud sync uploads your observation narratives and full prompt text to your
> cmem.ai account.
