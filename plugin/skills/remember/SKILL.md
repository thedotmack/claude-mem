---
name: remember
description: Save a standing directive — a durable rule that appears at the top of every future session. Use when the user says "remember this", "/remember", "always …", "from now on …", "save this as a rule", or "make this a standing directive".
---

# Remember

Persist a standing directive via the claude-mem worker. The rule text is the skill ARGUMENTS.

When the user states a durable rule mid-task, you may invoke this skill to persist it.

## Step 1: Resolve the worker port

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

This honors `CLAUDE_MEM_WORKER_PORT` env, then `~/.claude-mem/settings.json`, then falls back to the per-UID default `37700 + (uid % 100)`.

## Step 2: Choose the scope

Default `scope=global` — most behavioral rules apply everywhere. Only when the user clearly says "for this project" / "just here", set `scope=project` and derive the parent project name:

```bash
git_dir=$(git rev-parse --git-dir 2>/dev/null)
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$git_dir" != "$git_common_dir" ]; then
  parent_project=$(basename "$(dirname "$git_common_dir")")
else
  parent_project=$(basename "$PWD")
fi
echo "$parent_project"
```

Directives apply across a project's worktrees, so use `$parent_project` (the parent repo basename) for project scope.

## Step 3: POST the directive

Set `TEXT` to the rule. For a global directive:

```bash
node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], scope: "global"}))' "$TEXT" \
  | curl -fsS -XPOST "http://127.0.0.1:$WORKER_PORT/api/directive/add" -H 'content-type: application/json' --data @-
```

For a project-scoped directive:

```bash
node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], scope: "project", project: process.argv[2]}))' "$TEXT" "$parent_project" \
  | curl -fsS -XPOST "http://127.0.0.1:$WORKER_PORT/api/directive/add" -H 'content-type: application/json' --data @-
```

Building the JSON with `node -e` and `JSON.stringify` keeps arbitrary rule text (quotes, newlines) from breaking the request.

## Step 4: Report

On success the response is `{ "success": true, "id": <n>, "content": ..., "scope": ..., "project": ... }`. Tell the user it was saved as standing directive #`<id>` (with its scope) and that it now appears at the TOP of every future session.

If `curl -fsS` exits non-zero, or the response lacks `success: true`, print the actual response and tell the user the worker may be down. Never claim success when the request failed.
