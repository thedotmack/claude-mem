# Plugin Installation Guide

Claude-mem can be installed as a Claude Code plugin, which provides a streamlined installation experience.

## Plugin Structure

The claude-mem plugin includes:
- **Hooks**: Automatic memory capture via SessionStart, UserPromptSubmit, PostToolUse, and Stop hooks
- **Commands**: `/claude-mem`, `/save`, and `/remember` slash commands
- **MCP Integration**: Chroma vector database for semantic memory search

## Installation Methods

### Option 1: Plugin Installation (Recommended)

1. **Add the claude-mem marketplace** (if creating a marketplace):
   ```
   /plugin marketplace add thedotmack/claude-mem-marketplace
   ```

2. **Install the plugin**:
   ```
   /plugin install claude-mem
   ```

3. **Enable the plugin**:
   ```
   /plugin enable claude-mem
   ```

That's it! The plugin will automatically:
- Configure all hooks in your Claude settings
- Install the Chroma MCP server
- Set up slash commands
- Add instructions to ~/.claude/CLAUDE.md

### Option 2: Local Plugin Installation

If you've cloned the repository locally, you can install it as a local plugin:

1. **Navigate to your Claude plugins directory**:
   ```bash
   cd ~/.claude/plugins
   ```

2. **Clone or symlink the claude-mem repository**:
   ```bash
   # Via symlink (recommended for development)
   ln -s /path/to/claude-mem ./claude-mem

   # Or via git clone
   git clone https://github.com/thedotmack/claude-mem.git
   ```

3. **Install the plugin in Claude Code**:
   ```
   /plugin install claude-mem --local
   ```

### Option 3: Traditional CLI Installation

You can still use the traditional CLI-based installation:

```bash
npm install -g claude-mem
claude-mem install
```

This method uses an interactive wizard to guide you through setup.

## Managing the Plugin

### Check Plugin Status
```
/plugin list
```

### Disable Plugin (temporarily)
```
/plugin disable claude-mem
```

### Enable Plugin
```
/plugin enable claude-mem
```

### Uninstall Plugin
```
/plugin uninstall claude-mem
```

## Plugin Components

### Hooks Configuration

The plugin registers these hooks automatically (defined in `hooks/hooks.json`):

- **SessionStart**: Loads recent session context when Claude Code starts
- **UserPromptSubmit**: Initializes memory session and background worker
- **PostToolUse**: Captures tool observations for memory system
- **Stop**: Finalizes and saves session summary

### Commands

The plugin includes these slash commands (in `commands/` directory):

- `/claude-mem help` - Show all memory commands and features
- `/save [message]` - Quick save of current conversation overview
- `/remember [context]` - Search your saved memories

### MCP Server

The plugin automatically installs and configures the Chroma MCP server for vector-based memory storage.

## Troubleshooting

### Plugin Not Found
If the plugin isn't found, ensure:
1. The repository contains `.claude-plugin/plugin.json`
2. The plugin is in the correct directory
3. You've refreshed the plugin marketplace: `/plugin marketplace refresh`

### Hooks Not Running
Check that:
1. The plugin is enabled: `/plugin list`
2. The `claude-mem` CLI is installed: `which claude-mem`
3. Check Claude logs for hook errors

### CLI Not Found
If hooks fail with "command not found", install the CLI:
```bash
npm install -g claude-mem
```

The plugin hooks call the `claude-mem` CLI commands, which must be globally available.

## Creating Your Own Marketplace

To distribute claude-mem via a custom marketplace:

1. **Create a marketplace repository** with this structure:
   ```
   my-marketplace/
   ├── marketplace.json
   └── plugins/
       └── claude-mem/  (symlink or submodule to claude-mem)
   ```

2. **Define marketplace.json**:
   ```json
   {
     "name": "thedotmack",
     "owner": {
       "name": "Alex Newman"
     },
     "plugins": [
       {
         "name": "claude-mem",
         "source": "./plugins/claude-mem",
         "description": "Persistent memory system for Claude Code"
       }
     ]
   }
   ```

3. **Publish to GitHub** and users can add it with:
   ```
   /plugin marketplace add username/repo-name
   ```

## Benefits of Plugin Installation

✅ **One-command install**: No complex setup scripts
✅ **Easy management**: Enable/disable without modifying settings
✅ **Version control**: Update plugins with `/plugin update`
✅ **Team sharing**: Distribute via marketplace
✅ **Standard format**: Follows Claude Code best practices

## More Information

- [Claude Code Plugins Documentation](https://docs.claude.com/en/docs/claude-code/plugins)
- [Plugin Marketplaces Guide](https://docs.claude.com/en/docs/claude-code/plugin-marketplaces)
- [Claude-mem GitHub Repository](https://github.com/thedotmack/claude-mem)
