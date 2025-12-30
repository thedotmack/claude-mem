# Claude-Mem for Cursor (No Claude Code Required)

> **Persistent AI Memory for Cursor - Zero Cost to Start**

## Overview

Use claude-mem's persistent memory in Cursor without a Claude Code subscription. Choose between free-tier providers (Gemini, OpenRouter) or paid options.

**What You Get**:
- **Persistent memory** that survives across sessions - your AI remembers what it worked on
- **Automatic capture** of MCP tools, shell commands, and file edits
- **Context injection** via `.cursor/rules/` - relevant history included in every chat
- **Web viewer** at http://localhost:37777 - browse and search your project history

**Why This Matters**: Every Cursor session starts fresh. Claude-mem bridges that gap - your AI agent builds cumulative knowledge about your codebase, decisions, and patterns over time.

## Prerequisites

### macOS / Linux
- Cursor IDE
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Git
- `jq` and `curl`:
  - **macOS**: `brew install jq curl`
  - **Linux**: `apt install jq curl`

### Windows
- Cursor IDE
- [Bun](https://bun.sh) (PowerShell: `powershell -c "irm bun.sh/install.ps1 | iex"`)
- Git
- PowerShell 5.1+ (included with Windows 10/11)

## Step 1: Clone Claude-Mem

```bash
# Clone the repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
bun install

# Build the project
bun run build
```

## Step 2: Configure Provider (Choose One)

Since you don't have Claude Code, you need to configure an AI provider for claude-mem's summarization engine.

### Option A: Gemini (Recommended - Free Tier)

Gemini offers 1500 free requests per day, plenty for typical usage.

```bash
# Create settings directory
mkdir -p ~/.claude-mem

# Create settings file
cat > ~/.claude-mem/settings.json << 'EOF'
{
  "CLAUDE_MEM_PROVIDER": "gemini",
  "CLAUDE_MEM_GEMINI_API_KEY": "YOUR_GEMINI_API_KEY",
  "CLAUDE_MEM_GEMINI_MODEL": "gemini-2.5-flash-lite",
  "CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED": true
}
EOF
```

**Get your free API key**: https://aistudio.google.com/apikey

### Option B: OpenRouter (100+ Models)

OpenRouter provides access to many models, including free options.

```bash
mkdir -p ~/.claude-mem
cat > ~/.claude-mem/settings.json << 'EOF'
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "YOUR_OPENROUTER_API_KEY"
}
EOF
```

**Get your API key**: https://openrouter.ai/keys

**Free models available**:
- `google/gemini-2.0-flash-exp:free`
- `xiaomi/mimo-v2-flash:free`

### Option C: Claude API (If You Have API Access)

If you have Anthropic API credits but not a Claude Code subscription:

```bash
mkdir -p ~/.claude-mem
cat > ~/.claude-mem/settings.json << 'EOF'
{
  "CLAUDE_MEM_PROVIDER": "claude",
  "ANTHROPIC_API_KEY": "YOUR_ANTHROPIC_API_KEY"
}
EOF
```

## Step 3: Install Cursor Hooks

```bash
# From the claude-mem repo directory (recommended - all projects)
bun run cursor:install -- user

# Or for project-level only:
bun run cursor:install
```

This installs:
- Hook scripts to `.cursor/hooks/`
- Hook configuration to `.cursor/hooks.json`
- Context template to `.cursor/rules/`

## Step 4: Start the Worker

```bash
bun run worker:start
```

The worker runs in the background and handles:
- Session management
- Observation processing
- AI-powered summarization
- Context file updates

## Step 5: Restart Cursor & Verify

1. **Restart Cursor IDE** to load the new hooks

2. **Check installation status**:
   ```bash
   bun run cursor:status
   ```

3. **Verify the worker is running**:
   ```bash
   curl http://127.0.0.1:37777/api/readiness
   ```
   Should return: `{"status":"ready"}`

4. **Open the web viewer**: http://localhost:37777

## How It Works

1. **Before each prompt**: Hooks initialize a session and ensure the worker is running
2. **During agent work**: MCP tools, shell commands, and file edits are captured
3. **When agent stops**: Summary is generated and context file is updated
4. **Next session**: Fresh context is automatically injected via `.cursor/rules/`

## Troubleshooting

### "No provider configured" error

Verify your settings file exists and has valid credentials:
```bash
cat ~/.claude-mem/settings.json
```

### Worker not starting

Check logs:
```bash
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

### Hooks not executing

1. Check Cursor Settings → Hooks tab for errors
2. Verify scripts are executable:
   ```bash
   chmod +x ~/.cursor/hooks/*.sh
   ```
3. Check the Hooks output channel in Cursor

### Rate limiting (Gemini free tier)

If you hit the 1500 requests/day limit:
- Wait until the next day
- Upgrade to a paid plan
- Switch to OpenRouter with a paid model

## Next Steps

- Read [README.md](README.md) for detailed hook documentation
- Check [CONTEXT-INJECTION.md](CONTEXT-INJECTION.md) for context behavior details
- Visit https://docs.claude-mem.ai for full documentation

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun run cursor:install -- user` | Install hooks for all projects (recommended) |
| `bun run cursor:install` | Install hooks for current project only |
| `bun run cursor:status` | Check installation status |
| `bun run worker:start` | Start the background worker |
| `bun run worker:stop` | Stop the background worker |
| `bun run worker:restart` | Restart the worker |

---

## Windows Installation

Windows users get full support via PowerShell scripts. The installer automatically detects Windows and installs the appropriate scripts.

### Enable Script Execution (if needed)

PowerShell may require you to enable script execution:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Step-by-Step for Windows

```powershell
# Clone and build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
bun install
bun run build

# Configure provider (Gemini example)
$settingsDir = "$env:USERPROFILE\.claude-mem"
New-Item -ItemType Directory -Force -Path $settingsDir

@"
{
  "CLAUDE_MEM_PROVIDER": "gemini",
  "CLAUDE_MEM_GEMINI_API_KEY": "YOUR_GEMINI_API_KEY"
}
"@ | Out-File -FilePath "$settingsDir\settings.json" -Encoding UTF8

# Interactive setup (recommended - walks you through everything)
bun run cursor:setup

# Or manual installation
bun run cursor:install
bun run worker:start
```

### What Gets Installed on Windows

The installer copies these PowerShell scripts to `.cursor\hooks\`:

| Script | Purpose |
|--------|---------|
| `common.ps1` | Shared utilities |
| `session-init.ps1` | Initialize session on prompt |
| `context-inject.ps1` | Inject memory context |
| `save-observation.ps1` | Capture MCP/shell usage |
| `save-file-edit.ps1` | Capture file edits |
| `session-summary.ps1` | Generate summary on stop |

The `hooks.json` file is configured to invoke PowerShell with `-ExecutionPolicy Bypass` to ensure scripts run without additional configuration.

### Windows Troubleshooting

**"Execution of scripts is disabled on this system"**

Run as Administrator:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
```

**PowerShell scripts not running**

Verify the hooks.json contains PowerShell invocations:
```powershell
Get-Content .cursor\hooks.json
```

Should show commands like:
```
powershell.exe -ExecutionPolicy Bypass -File "./.cursor/hooks/session-init.ps1"
```

**Worker not responding**

Check if port 37777 is in use:
```powershell
Get-NetTCPConnection -LocalPort 37777
```

**Antivirus blocking scripts**

Some antivirus software may block PowerShell scripts. Add an exception for the `.cursor\hooks\` directory if needed.
