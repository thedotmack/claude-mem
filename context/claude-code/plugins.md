# Claude Code Plugins Quick Reference

For custom files in your claude-mem plugin, you have several designated locations based on the standard plugin structure [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#standard-plugin-layout):

## Standard Plugin Directory Structure [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#standard-plugin-layout)

```
enterprise-plugin/
├── .claude-plugin/           # Metadata directory
│   └── plugin.json          # Required: plugin manifest
├── commands/                 # Default command location
│   ├── status.md
│   └──  logs.md
├── agents/                   # Default agent location
│   ├── security-reviewer.md
│   ├── performance-tester.md
│   └── compliance-checker.md
├── hooks/                    # Hook configurations
│   ├── hooks.json           # Main hook config
│   └── security-hooks.json  # Additional hooks
├── .mcp.json                # MCP server definitions
├── scripts/                 # Hook and utility scripts
│   ├── security-scan.sh
│   ├── format-code.py
│   └── deploy.js
├── LICENSE                  # License file
└── CHANGELOG.md             # Version history
```

## Where to Put Your Custom Files

### Hook Scripts [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#standard-plugin-layout)
Put your hook execution scripts in the `scripts/` directory [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#standard-plugin-layout). For your claude-mem hooks:

```
claude-mem-plugin/
├── scripts/
│   ├── context-hook.js      # Your SessionStart hook
│   ├── new-hook.js          # Your UserPromptSubmit hook
│   ├── save-hook.js         # Your PostToolUse hook
│   └── summary-hook.js      # Your Stop hook
```

### Hook Configuration [(4)](https://docs.claude.com/en/docs/claude-code/hooks#plugin-hooks)
Your hook configuration goes in `hooks/hooks.json` and can reference plugin files using the `${CLAUDE_PLUGIN_ROOT}` environment variable [(4)](https://docs.claude.com/en/docs/claude-code/hooks#plugin-hooks):

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

### Commands [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#commands)
Your slash commands go in the `commands/` directory as markdown files [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#commands):

```
claude-mem-plugin/
├── commands/
│   ├── claude-mem.md
│   ├── save.md
│   └── remember.md
```

### Additional Custom Files
For any other custom files (configuration, templates, data files), you can create additional directories in your plugin root. The plugin system will make them available via `${CLAUDE_PLUGIN_ROOT}` [(4)](https://docs.claude.com/en/docs/claude-code/hooks#plugin-hooks).

## File Location Reference [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#file-locations-reference)

| Component | Default Location | Purpose |
|-----------|------------------|---------|
| **Manifest** | `.claude-plugin/plugin.json` | Required metadata file |
| **Commands** | `commands/` | Slash command markdown files |
| **Agents** | `agents/` | Subagent markdown files |
| **Hooks** | `hooks/hooks.json` | Hook configuration |
| **MCP servers** | `.mcp.json` | MCP server definitions |

The key point is that all component directories (commands/, agents/, hooks/, scripts/) must be at the plugin root, not inside `.claude-plugin/` [(1)](https://docs.claude.com/en/docs/claude-code/plugins-reference#standard-plugin-layout).