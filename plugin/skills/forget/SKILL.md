---
name: forget
description: Archive a standing directive by id so it stops appearing in future sessions. Use when the user says "/forget <id>", "remove directive", "archive directive", or "delete that rule".
---

# Forget

Archive a standing directive via the claude-mem worker. The directive id is the skill ARGUMENTS.

## Step 1: Resolve the worker port

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

This honors `CLAUDE_MEM_WORKER_PORT` env, then `~/.claude-mem/settings.json`, then falls back to the per-UID default `37700 + (uid % 100)`.

## Step 2: POST the archive request

Set `ID` to the numeric directive id from the arguments:

```bash
node -e 'process.stdout.write(JSON.stringify({id: Number(process.argv[1])}))' "$ID" \
  | curl -fsS -XPOST "http://127.0.0.1:$WORKER_PORT/api/directive/archive" -H 'content-type: application/json' --data @-
```

Building the JSON with `node -e` keeps the body well-formed and sends `id` as a real number.

## Step 3: Report

On success the response is `{ "success": true, "id": <n> }`. Confirm the directive was removed and won't appear in future sessions.

If the worker returns a 400 with `{ "error": "Directive <id> not found" }`, relay that error and suggest running `/directives` to see the valid ids.

If `curl -fsS` exits non-zero for any other reason, print the actual response and tell the user the worker may be down. Never claim a directive was removed when the request failed.
