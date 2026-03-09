---
name: set-mode
description: Activate a claude-mem mode with full setup — settings, project instructions, and worker restart
argument-hint: "<mode-name>"
---

# Set Mode

You are activating a claude-mem mode for the current project. This does three things: updates memory settings, installs the mode's project instructions (if any), and restarts the worker so changes take effect immediately.

**Requires `$ARGUMENTS`** — the mode name to activate (e.g., `law-study`, `cowork`, `code--chill`).

If no arguments provided, tell the user: `Usage: /set-mode <mode-name>`. Suggest they run `/mode` to see available modes.

## Step 1: Locate and Validate the Mode

Find the mode JSON file. Check these paths in order:

1. `~/.claude/plugins/marketplaces/thedotmack/plugin/modes/$ARGUMENTS.json` (installed plugin)
2. `plugin/modes/$ARGUMENTS.json` (development — only if working in the claude-mem repo)

If the file doesn't exist at either path, show an error and list available modes by globbing `*.json` from the modes directory.

Record which modes directory you found the file in — you'll need it for steps below.

## Step 2: Read Mode Config

Read the mode JSON file. Extract:
- `observation_types[].id` — join as comma-separated string
- `observation_concepts[].id` — join as comma-separated string

For behavioral variants (mode names containing `--`, like `code--chill`):
- The variant file may not have its own `observation_types` or `observation_concepts`
- If missing, read the parent mode (the part before `--`) to get them

## Step 3: Update Settings

Update all three settings via the worker API:

```bash
curl -s -X POST http://localhost:37777/api/settings \
  -H "Content-Type: application/json" \
  -d '{"CLAUDE_MEM_MODE": "$ARGUMENTS", "CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES": "<types>", "CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS": "<concepts>"}'
```

Verify the response indicates success.

## Step 4: Install Project Instructions

Check if the mode has a CLAUDE.md file: `{mode-name}-CLAUDE.md` in the same modes directory.

For behavioral variants (e.g., `code--chill`), also check the parent mode's CLAUDE.md (e.g., `code-CLAUDE.md`).

**If a mode CLAUDE.md exists:**

Read the mode's CLAUDE.md content, then update the project's CLAUDE.md:

1. **No project CLAUDE.md exists** — Write the mode's CLAUDE.md directly as the project's `CLAUDE.md`.

2. **Project CLAUDE.md exists with `<claude-mem-mode>` section** — Replace the content between the existing `<claude-mem-mode>` tags with the new mode's content.

3. **Project CLAUDE.md exists without `<claude-mem-mode>` section** — Prepend the mode content wrapped in tags at the top of the file:

```markdown
<claude-mem-mode>
<!-- Installed by /set-mode $ARGUMENTS — replace with /set-mode <other-mode> -->
{content from mode CLAUDE.md}
</claude-mem-mode>

{existing CLAUDE.md content}
```

**If no mode CLAUDE.md exists:**

Skip this step. Not all modes require custom project instructions.

## Step 5: Restart Worker

Restart the worker so it picks up the new mode configuration:

```bash
bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-cli.js restart
```

If running in the claude-mem development repo, use instead:

```bash
bun plugin/scripts/worker-cli.js restart
```

If the restart command fails, fall back to a shutdown-only approach:

```bash
curl -s -X POST http://localhost:37777/api/admin/shutdown
```

The worker will auto-restart on the next hook trigger.

## Step 6: Confirm

Tell the user:

- Which mode was activated
- Whether project instructions were installed (and where)
- That the worker has been restarted
- The mode is now fully active — no need to `/clear` or start a new conversation

If project instructions were installed, remind the user they can view them in the project's CLAUDE.md within the `<claude-mem-mode>` tags, and that switching modes will replace them automatically.
