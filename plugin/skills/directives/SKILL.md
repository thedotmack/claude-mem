---
name: directives
description: List the active standing directives for this project and globally. Use when the user says "/directives", "list my directives", "show standing directives", or "what rules do you have".
---

# Directives

List active standing directives via the claude-mem worker.

## Step 1: Resolve the worker port

```bash
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
```

This honors `CLAUDE_MEM_WORKER_PORT` env, then `~/.claude-mem/settings.json`, then falls back to the per-UID default `37700 + (uid % 100)`.

## Step 2: Derive the project name

Directives apply across a project's worktrees, so use the parent repo basename:

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

## Step 3: GET the active directives

The `projects` query value must be URL-encoded so unusual project names can't break the request:

```bash
encoded_project=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$parent_project")
curl -fsS "http://127.0.0.1:$WORKER_PORT/api/directive/list?projects=$encoded_project"
```

The response is `{ "directives": [{ id, content, scope, project, status, created_at, ... }] }` — globals plus this project's directives.

## Step 4: Report

Pretty-print a numbered list, one per directive:

```
#<id> [<scope>] <content>
```

If the list is empty, say there are no standing directives yet and hint `/remember <rule>` to add one. Otherwise, mention the user can remove any with `/forget <id>`.

If `curl -fsS` exits non-zero, print the actual error and tell the user the worker may be down. Never invent a list when the request failed.
