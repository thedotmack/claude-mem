---
description: "List available claude-mem modes or switch to a different mode"
argument-hint: "[mode-name]"
---

# /mode

You are handling the `/mode` command for claude-mem.

## If no arguments provided: List available modes

1. Fetch current settings:
   ```bash
   curl -s http://localhost:37777/api/settings
   ```
   Extract the `CLAUDE_MEM_MODE` value — this is the currently active mode.

2. Discover all available modes by reading JSON files from the plugin modes directory. Use the Glob tool to find all `*.json` files in the plugin modes directory, then read each file to get `name` and `description`:
   Check these locations and use whichever exists:
   - Cache install: glob `~/.claude/plugins/cache/thedotmack/claude-mem/*/modes/*.json`
   - Marketplace install: glob `~/.claude/plugins/marketplaces/*/plugin/modes/*.json`
   - Development repo: glob `plugin/modes/*.json`

3. Display a table showing all modes:

   | Mode ID | Name | Description | Active |
   |---------|------|-------------|--------|
   | code | Code Development | Software development and engineering work | ← current |
   | cowork | Cowork | Knowledge work, document creation, research | |

   - The Mode ID is the filename without `.json`
   - Modes with `--` in the name (like `code--chill`) are behavioral variants of their parent mode — note this to the user
   - Highlight the currently active mode

## If argument provided ($ARGUMENTS): Switch to that mode

1. Validate the mode exists by checking if `plugin/modes/$ARGUMENTS.json` exists. If not, show an error with available modes.

2. Read the target mode JSON to extract observation types and concepts:
   - Get `observation_types[].id` — join as comma-separated string
   - Get `observation_concepts[].id` — join as comma-separated string
   - For behavioral variants (containing `--`) that lack their own `observation_types` or `observation_concepts`, read the parent mode (the part before `--`) to get them

3. Update all three settings via the API:
   ```bash
   curl -s -X POST http://localhost:37777/api/settings \
     -H "Content-Type: application/json" \
     -d '{"CLAUDE_MEM_MODE": "$ARGUMENTS", "CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES": "<types>", "CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS": "<concepts>"}'
   ```

4. Confirm the switch to the user. Note that the mode change takes full effect on the **next session** (after `/clear` or starting a new conversation), because the worker loads mode configuration at startup.
