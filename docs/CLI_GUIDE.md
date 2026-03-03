# Claude-Mem CLI Guide

The Claude-Mem CLI provides powerful commands for managing your persistent memory system, diagnosing issues, and maintaining your data.

## Installation

The CLI is automatically available after installing Claude-Mem:

```bash
# Via npm (global install)
npm install -g claude-mem
claude-mem --help

# Or via npx (no install)
npx claude-mem doctor

# Or from plugin directory
cd ~/.claude/plugins/marketplaces/thedotmack
npm run cli:doctor
```

## Commands Overview

### System Commands

#### `claude-mem doctor`
Run comprehensive health checks on your Claude-Mem installation.

```bash
claude-mem doctor                    # Run all checks
claude-mem doctor --fix              # Auto-fix issues
claude-mem doctor --json             # Output as JSON
claude-mem doctor --verbose          # Detailed output
```

**Checks performed:**
- Plugin enabled in Claude Code settings
- Worker service running
- Database accessible
- Bun runtime version
- Node.js version

#### `claude-mem repair`
Interactively repair common issues.

```bash
claude-mem repair                    # Interactive repair
claude-mem repair --force            # Skip confirmation
claude-mem repair --dry-run          # Preview changes
```

**Fixes applied:**
- Re-enable disabled plugin
- Restart stopped worker
- Upgrade outdated Bun

#### `claude-mem config`
Manage Claude-Mem settings.

```bash
claude-mem config list               # List all settings
claude-mem config get PORT           # Get setting value
claude-mem config set PORT 37778     # Set setting value
claude-mem config reset              # Reset to defaults
claude-mem config validate           # Validate settings
```

**Available settings:**
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)
- `CLAUDE_MEM_LOG_LEVEL` - Log level (DEBUG|INFO|WARN|ERROR)
- `CLAUDE_MEM_MODEL` - AI model for processing
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Context observation count

#### `claude-mem shell`
Shell completion setup.

```bash
claude-mem shell completion bash     # Generate bash completion
claude-mem shell completion zsh      # Generate zsh completion
claude-mem shell completion fish     # Generate fish completion
claude-mem shell install zsh         # Install completion
```

### Worker Commands

#### `claude-mem logs`
View and manage worker logs.

```bash
claude-mem logs                      # Show last 50 lines
claude-mem logs --tail 100           # Show last 100 lines
claude-mem logs --follow             # Follow in real-time
claude-mem logs --level ERROR        # Show only errors
claude-mem logs --session abc-123    # Filter by session
claude-mem logs --date 2026-03-01    # Show specific date
claude-mem logs --list               # List log files
claude-mem logs --clean 30           # Delete logs older than 30 days
```

### Data Commands

#### `claude-mem backup`
Create and manage backups.

```bash
claude-mem backup                    # Create full backup
claude-mem backup --database-only    # Backup only database
claude-mem backup --settings-only    # Backup only settings
claude-mem backup --output ~/backup.zip  # Custom output path
claude-mem backup --list             # List backups
```

#### `claude-mem stats`
Display database statistics.

```bash
claude-mem stats                     # Show all statistics
claude-mem stats --json              # Output as JSON
```

**Displays:**
- Total observations, sessions, summaries
- Database size
- Activity (last 30 days)
- Top projects
- Observation type distribution

#### `claude-mem search`
Search your memory observations.

```bash
claude-mem search "authentication"   # Search by text
claude-mem search "bug" --project my-app  # Filter by project
claude-mem search "api" --type refactor   # Filter by type
claude-mem search "deploy" --limit 20     # Limit results
claude-mem search --recent --limit 10     # Show recent
claude-mem search --projects              # List projects
```

#### `claude-mem clean`
Clean up old data.

```bash
claude-mem clean --sessions 90       # Delete sessions older than 90 days
claude-mem clean --observations 60   # Delete observations older than 60 days
claude-mem clean --logs 30           # Delete logs older than 30 days
claude-mem clean --failed            # Delete failed observations
claude-mem clean --dry-run           # Preview without deleting
```

#### `claude-mem export`
Export observations to file.

```bash
claude-mem export --format json      # Export as JSON (default)
claude-mem export --format markdown  # Export as Markdown
claude-mem export --output memories.md  # Custom output
claude-mem export --project my-app   # Export single project
claude-mem export --since 2026-01-01 # Export since date
```

#### `claude-mem import`
Import observations from file.

```bash
claude-mem import data.json          # Import from JSON
claude-mem import data.json --dry-run  # Validate only
```

## Common Workflows

### Post-Update Recovery

```bash
# Check if everything is working
claude-mem doctor

# If issues found, auto-fix them
claude-mem doctor --fix

# Verify worker is running
claude-mem logs --tail 10
```

### Monthly Maintenance

```bash
# Create backup
claude-mem backup

# Check statistics
claude-mem stats

# Clean old data
claude-mem clean --logs 30 --sessions 90 --dry-run
claude-mem clean --logs 30 --sessions 90

# Verify health
claude-mem doctor
```

### Finding Old Memories

```bash
# List all projects
claude-mem search --projects

# Search in specific project
claude-mem search "authentication" --project my-app --limit 5

# View related logs
claude-mem logs --session <session-id>
```

### Exporting Memories

```bash
# Export everything to Markdown
claude-mem export --format markdown --output memories.md

# Export specific project
claude-mem export --project my-app --output my-app-memories.json
```

## Troubleshooting

### CLI not found

```bash
# Make sure claude-mem is installed globally
npm install -g claude-mem

# Or use from plugin directory
cd ~/.claude/plugins/marketplaces/thedotmack
npm run cli:doctor
```

### Permission errors

```bash
# Try with sudo (Unix/Mac)
sudo claude-mem doctor

# Or fix permissions
sudo chown -R $(whoami) ~/.claude-mem
```

### Database locked

```bash
# Stop worker first
claude-mem repair --force

# Then run your command
claude-mem stats
```

## Environment Variables

- `CLAUDE_MEM_DATA_DIR` - Custom data directory
- `CLAUDE_MEM_WORKER_PORT` - Worker port (if not in settings)
- `CLAUDE_PLUGIN_ROOT` - Plugin root directory
- `CLAUDE_CONFIG_DIR` - Claude Code config directory

## Exit Codes

- `0` - Success
- `1` - Error (check stderr for details)

## Shell Completion

### Bash

```bash
# Add to ~/.bashrc
eval "$(claude-mem shell completion bash)"
```

### Zsh

```bash
# Install completion
claude-mem shell install zsh

# Add to ~/.zshrc
fpath+=~/.zsh/completions
autoload -U compinit && compinit
```

### Fish

```bash
claude-mem shell install fish
```

## Getting Help

```bash
# General help
claude-mem --help

# Command-specific help
claude-mem doctor --help
claude-mem logs --help

# Check documentation
open https://docs.claude-mem.ai/cli
```
