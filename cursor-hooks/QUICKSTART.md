# Quick Start: Claude-Mem + Cursor Integration

> **Give your Cursor AI persistent memory in under 5 minutes**

## What This Does

Connects claude-mem to Cursor so that:
- **Agent actions** (MCP tools, shell commands, file edits) are automatically saved
- **Context from past sessions** is automatically injected via `.cursor/rules/`
- **Sessions are summarized** for future reference

Your AI stops forgetting. It remembers the patterns, decisions, and context from previous sessions.

## Don't Have Claude Code?

If you're using Cursor without Claude Code, see [STANDALONE-SETUP.md](STANDALONE-SETUP.md) for setup with free-tier providers like Gemini or OpenRouter.

---

## Installation (1 minute)

```bash
# Install globally for all projects (recommended)
claude-mem cursor install user

# Or install for current project only
claude-mem cursor install

# Check installation status
claude-mem cursor status
```

## Configure Provider (Required for Standalone)

If you don't have Claude Code, configure a provider for AI summarization:

```bash
# Option A: Gemini (free tier available - recommended)
claude-mem settings set CLAUDE_MEM_PROVIDER gemini
claude-mem settings set CLAUDE_MEM_GEMINI_API_KEY your-api-key

# Option B: OpenRouter (free models available)
claude-mem settings set CLAUDE_MEM_PROVIDER openrouter
claude-mem settings set CLAUDE_MEM_OPENROUTER_API_KEY your-api-key
```

**Get free API keys**:
- Gemini: https://aistudio.google.com/apikey
- OpenRouter: https://openrouter.ai/keys

## Start Worker

```bash
claude-mem start

# Verify it's running
claude-mem status
```

## Restart Cursor

Restart Cursor to load the hooks.

## Verify It's Working

1. Open Cursor Settings → Hooks tab
2. You should see the hooks listed
3. Submit a prompt in Cursor
4. Check the web viewer: http://localhost:37777
5. You should see observations appearing

## What Gets Captured

- **MCP Tool Usage**: All MCP tool executions
- **Shell Commands**: All terminal commands
- **File Edits**: All file modifications
- **Sessions**: Each conversation is tracked

## Accessing Memory

### Via Web Viewer
- Open http://localhost:37777
- Browse sessions, observations, and summaries
- Search your project history

### Via MCP Tools (if enabled)
- claude-mem provides search tools via MCP
- Use `search`, `timeline`, and `get_observations` tools

## Troubleshooting

**Hooks not running?**
- Check Cursor Settings → Hooks tab for errors
- Verify scripts are executable: `chmod +x ~/.cursor/hooks/*.sh`
- Check Hooks output channel in Cursor

**Worker not responding?**
- Check if worker is running: `curl http://127.0.0.1:37777/api/readiness`
- Check logs: `tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log`
- Restart worker: `bun run worker:restart`

**Observations not saving?**
- Check worker logs for errors
- Verify session was initialized in web viewer
- Test API directly: `curl -X POST http://127.0.0.1:37777/api/sessions/observations ...`

## Next Steps

- Read [README.md](README.md) for detailed documentation
- Read [INTEGRATION.md](INTEGRATION.md) for architecture details
- Visit [claude-mem docs](https://docs.claude-mem.ai) for full feature set

