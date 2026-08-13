---
name: remote-mode
description: Set up or verify claude-mem remote mode in a Claude Code cloud container (claude.ai). Use when the user says "remote mode", "connect claude-mem in the cloud", "cmem in claude code web", "why is my memory empty in the cloud", or asks how to use their CMEM Pro account from a cloud/web session.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# Remote Mode (CMEM Pro in Claude Code cloud containers)

Cloud containers are ephemeral: every session boots with an empty
`~/.claude-mem`. Remote mode connects the session to the user's CMEM Pro
account instead — memories pull down from SyncHub at session start and new
observations push back up, so memory follows the account, not the machine.

Activation is entirely env-var driven. The user pre-fills three variables in
their **claude.ai → Claude Code → environment settings** (shown ready to copy
at **cmem.ai → /pro/remote**):

```text
CLAUDE_MEM_REMOTE_MODE=true
CLAUDE_MEM_PRO_TOKEN=cm_pro_…       (setup token)
CLAUDE_MEM_PRO_USER_ID=…            (account user id)
```

The plugin expands these into cloud sync, the Pro inference gateway, a
container-appropriate device name, and Chroma-off. Any individual key can
still be overridden (e.g. `CLAUDE_MEM_CLOUD_SYNC_HUB_URL`,
`CLAUDE_MEM_CHROMA_ENABLED=true`).

**Security rule:** never print, echo, or log the token or user id. Confirm
presence and length only.

## 1. Check whether remote mode is configured

```bash
node -e "const t=(process.env.CLAUDE_MEM_PRO_TOKEN||'').trim(),u=(process.env.CLAUDE_MEM_PRO_USER_ID||'').trim(),m=(process.env.CLAUDE_MEM_REMOTE_MODE||'auto').trim().toLowerCase();console.log(JSON.stringify({remoteFlag:m,tokenPresent:t!=='',tokenLength:t.length,userIdPresent:u!=='',container:process.env.CLAUDE_CODE_REMOTE==='true'}))"
```

- Both present and flag not `false` → remote mode should be active; verify in
  step 2.
- Missing values → go to step 3 (they cannot be added from inside the
  container).

## 2. Verify the worker picked it up

Resolve the worker port and query sync status:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const uid=(typeof process.getuid==='function'?process.getuid():77);process.stdout.write(String(37700+(uid%100)))")}"
curl -s "http://127.0.0.1:${PORT}/api/sync/status"
```

- `remoteMode: true`, `configured: true`, `hub.reachable: true` → working.
  Report the device id and pending counts. The first context injection of a
  session performs a bounded catch-up pull (default 20 s, tunable via
  `CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS`), so memory from the account
  appears from the very first prompt.
- `remoteMode: true` but `configured: false` → the credentials were seen but
  sync did not activate; restart the worker
  (`curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"`), wait,
  re-check. If it persists, report `hub.error`/`lastError` without the token.
- `remoteMode: false` with creds present in step 1 → the worker env differs
  from the hook env; restart the worker and re-check.
- Connection refused right after session start → the worker is still booting;
  retry every three seconds for about 30 seconds.

## 3. Guide setup (values missing)

Environment variables cannot be changed from inside a running container.
Tell the user to:

1. Open **cmem.ai → /pro/remote** (requires an active Pro account) and copy
   the three environment variables shown there.
2. On claude.ai, open their Claude Code **environment settings** (the
   environment picker → gear/settings → environment variables), paste the
   three variables, and save.
3. Start a **new** cloud session — env vars apply at container start.

If they have no Pro account yet, point them at **cmem.ai/pro**.

## 4. Report

Report: remote flag state, credential presence (lengths only), worker sync
status (`remoteMode`, `configured`, `hub.reachable`, device id, pending
counts, last error). End with this privacy note when remote mode is active:

> Remote mode syncs observation narratives and full prompt text from this
> session to your cmem.ai account, and pulls your account's memories into
> this container for context.
