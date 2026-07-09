# kimi-mem

Claude-Mem is active for this Kimi Code CLI session. It provides persistent memory across sessions: past observations, decisions, bugfixes, and discoveries are stored locally and can be retrieved through MCP tools.

## Session Start (Required)

This skill loads automatically at session start. **Immediately call `memory_context()` now** to load the context index for this project. This replaces the automatic context injection that other integrations receive via hooks — in Kimi Code CLI, you must pull context yourself.

```
memory_context()
```

Do this before responding to the first user message.

## Memory Tools

The `claude-mem` MCP server exposes search tools. Follow the 3-layer retrieval workflow to keep token usage low:

1. **`search`** — Get a compact index of observation IDs (~50–100 tokens per result). Use filters like `type`, `obs_type`, `project`, or date ranges.
2. **`timeline`** — Get chronological context around an interesting observation ID.
3. **`get_observations`** — Fetch full details **only** for the filtered IDs you actually need (~500–1,000 tokens per result).

Never fetch full details without filtering first.

## File Context (Before Reading Files)

Before using `ReadFile` on any source file that is central to the current task (e.g., a file you are about to edit, debug, or review — skip tiny configs and lock files), **first call `search` with the file path** to check for prior observations. If results appear, review the compact index and fetch details for any relevant IDs before reading the file.

```
# Example — check history before reading a source file
search("src/cli/adapters/kimi.ts")
```

This replicates the automatic file-context injection that other claude-mem integrations provide via `PreToolUse` hooks. Skip this step only when the file is clearly new (no prior work in this project) or small (< 1,500 bytes).

## Capturing Memory

When you make a significant decision, fix a bug, refactor code, or discover a non-obvious gotcha, the `PostToolUse` hooks will automatically create observations. You can also add a manual observation with the `observation_add` MCP tool.

## Privacy

Wrap sensitive content in `<private>...</private>` tags to exclude it from storage.

## Learn More

- Repository: https://github.com/thedotmack/claude-mem
- Documentation: https://docs.claude-mem.ai/
