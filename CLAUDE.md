# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Important

No need to edit the changelog ever, it's generated automatically.

## Hosting

No metered Cloudflare compute. New server-side work goes on Fly or Vercel. Cloudflare Workers, Durable Objects, Queues, Workflows, crons or Workers AI need an owner-approved cost comparison first. Free Cloudflare services (DNS, R2, Email Routing) are fine.

## Model policy

Never pin a dated Claude model ID (like `claude-haiku-4-5-20251001`) as a default, in the installer, or in docs. Use Claude Code's aliases (`haiku`, `sonnet`, `opus`), which always resolve to the newest model of that tier. Anthropic's newest models cost less or do more for the same price, so a pin quietly makes every install slower and more expensive as new models ship. A user may still type a full ID to pin one version on purpose. When an older default turns out to be pinned, add a settings migration that moves the shipped ID to the alias (see `PINNED_SHIPPED_HAIKU_MODELS` in `src/shared/SettingsDefaultsManager.ts`).
