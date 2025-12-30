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

- Cursor IDE
- Node.js 18+
- Git
- `jq` and `curl`:
  - **macOS**: `brew install jq curl`
  - **Linux**: `apt install jq curl`

## Step 1: Clone Claude-Mem

```bash
# Clone the repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
npm install

# Build the project
npm run build
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
# From the claude-mem repo directory
npm run cursor:install

# Or for user-level (all projects):
npm run cursor:install -- user
```

This installs:
- Hook scripts to `.cursor/hooks/`
- Hook configuration to `.cursor/hooks.json`
- Context template to `.cursor/rules/`

## Step 4: Start the Worker

```bash
npm run worker:start
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
   npm run cursor:status
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
| `npm run cursor:install` | Install hooks for current project |
| `npm run cursor:install -- user` | Install hooks for all projects |
| `npm run cursor:status` | Check installation status |
| `npm run worker:start` | Start the background worker |
| `npm run worker:stop` | Stop the background worker |
| `npm run worker:restart` | Restart the worker |
