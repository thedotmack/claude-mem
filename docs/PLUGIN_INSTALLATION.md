# Plugin Installation Guide

Claude-mem can be installed as a Claude Code plugin, which provides a streamlined installation experience.

## Plugin Structure

The claude-mem plugin includes:
- **Hooks**: Automatic memory capture via SessionStart, UserPromptSubmit, PostToolUse, and Stop hooks
- **Commands**: `/claude-mem`, `/save`, and `/remember` slash commands
- **MCP Integration**: Chroma vector database for semantic memory search

## Installation Methods

### Option 1: From Git Repository (Recommended)

If the plugin is published to GitHub:

1. **Add the marketplace from GitHub**:
   ```
   /plugin marketplace add thedotmack/claude-mem-marketplace
   ```

2. **Install the plugin**:
   ```
   /plugin install claude-mem@marketplace-name
   ```

The plugin will automatically:
- Configure all hooks in your Claude settings
- Set up slash commands
- Register plugin components

**Note**: You still need to install the CLI globally for hooks to work:
```bash
npm install -g claude-mem
```

### Option 2: Local Development Installation

If you're testing locally during development:

1. **Create a development marketplace structure**:
   ```bash
   mkdir dev-marketplace
   cd dev-marketplace
   mkdir .claude-plugin
   ```

2. **Create marketplace manifest** (`.claude-plugin/marketplace.json`):
   ```json
   {
     "name": "dev-marketplace",
     "owner": {
       "name": "Developer"
     },
     "plugins": [
       {
         "name": "claude-mem",
         "source": "./claude-mem-plugin",
         "description": "Persistent memory system for Claude Code"
       }
     ]
   }
   ```

3. **Create or symlink your plugin directory**:
   ```bash
   # Symlink to your working directory (recommended)
   ln -s /path/to/claude-mem ./claude-mem-plugin

   # Or copy the directory
   cp -r /path/to/claude-mem ./claude-mem-plugin
   ```

4. **Start Claude Code and add your development marketplace**:
   ```
   /plugin marketplace add /absolute/path/to/dev-marketplace
   ```

5. **Install your plugin**:
   ```
   /plugin install claude-mem@dev-marketplace
   ```

### Option 3: Interactive Installation

You can also use the interactive plugin interface:

1. **Open plugin management**:
   ```
   /plugin
   ```

2. **Select "Browse Plugins"** to see available plugins with descriptions and installation options

3. **Follow the prompts** to install and configure

### Option 4: Traditional CLI Installation

You can still use the traditional CLI-based installation:

```bash
npm install -g claude-mem
claude-mem install
```

This method uses an interactive wizard to guide you through setup and works independently of the plugin system.

## Verify Installation

After installing the plugin, verify it's working correctly:

1. **Check available commands**:
   ```
   /help
   ```
   You should see `/claude-mem`, `/save`, and `/remember` commands listed.

2. **Test plugin features**:
   ```
   /claude-mem help
   ```
   This should show all memory system commands and features.

3. **Review plugin details**:
   ```
   /plugin
   ```
   Select "Manage Plugins" to see what the plugin provides and its current status.

4. **Check hooks are registered**:
   View your `~/.claude/settings.json` to confirm hooks are configured.

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

## Development Iteration

When making changes to your plugin during development:

1. **Uninstall current version**:
   ```
   /plugin uninstall claude-mem@dev-marketplace
   ```

2. **Make your changes** to the plugin code

3. **Reinstall to test changes**:
   ```
   /plugin install claude-mem@dev-marketplace
   ```

4. **Restart Claude Code** if hooks or commands don't update immediately

**Tip**: When using a symlink in your dev marketplace, changes to commands may be reflected without reinstalling, but hook changes typically require a reinstall.

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
   ├── .claude-plugin/
   │   └── marketplace.json
   └── plugins/
       └── claude-mem/  (symlink or submodule to claude-mem)
   ```

2. **Define `.claude-plugin/marketplace.json`**:
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

4. **Users install the plugin**:
   ```
   /plugin install claude-mem@marketplace-name
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
