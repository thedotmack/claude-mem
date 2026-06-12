# kimi-mem

Claude-Mem is active for this Kimi Code CLI session. It provides persistent memory across sessions: past observations, decisions, bugfixes, and discoveries are stored locally and can be retrieved through MCP tools.

## When to Activate

This skill loads automatically at session start. You do not need to invoke it manually.

## Memory Tools

The `claude-mem` MCP server exposes search tools. Follow the 3-layer retrieval workflow to keep token usage low:

1. **`search`** — Get a compact index of observation IDs (~50–100 tokens per result). Use filters like `type`, `obs_type`, `project`, or date ranges.
2. **`timeline`** — Get chronological context around an interesting observation ID.
3. **`get_observations`** — Fetch full details **only** for the filtered IDs you actually need (~500–1,000 tokens per result).

Never fetch full details without filtering first.

## Capturing Memory

When you make a significant decision, fix a bug, refactor code, or discover a non-obvious gotcha, the `PostToolUse` hooks will automatically create observations. You can also add a manual observation with the `observation_add` MCP tool.

## Privacy

Wrap sensitive content in `<private>...</private>` tags to exclude it from storage.

## Learn More

- Repository: https://github.com/thedotmack/claude-mem
- Documentation: https://docs.claude-mem.ai/
