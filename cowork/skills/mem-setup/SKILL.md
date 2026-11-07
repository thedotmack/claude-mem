---
name: mem-setup
description: >
  This skill should be used when the user asks to "set up claude-mem", "pair
  claude-mem", "connect cmem", "add my cmem key", "set up cloud sync in
  Cowork", or provides cmem.ai Connect values (sync token, user id, SyncHub
  URL) for this plugin. Configures the claude-mem-cowork plugin credentials.
metadata:
  version: "0.1.0"
---

# Claude-Mem Setup (Cowork pairing)

Configure this plugin with the user's own cmem.ai credentials so hooks can
capture and inject memory. Anyone can pair — credentials are per-user
configuration, never hardcoded in plugin logic.

## What to collect

From **cmem.ai → Connect**, the user has three values:

1. **sync token** (starts with `cm_`) — used as the bearer API key
2. **user id** (UUID)
3. **SyncHub URL** (`https://sync.cmem.ai`)

If the user pastes the whole Connect blurb, extract the three values from it.
If any are missing, ask for the sync token at minimum — the other two are
optional.

## Secret handling — non-negotiable

- Never echo the token back in conversation, put it in a shell argv, or log it.
- Move it only via file writes (Write/Edit tool) and file reads.

## Steps

1. Locate the installed plugin root (this skill's own plugin). Update its
   `config.json`: set `apiKey` to the sync token, `userId`, and `syncHubUrl`.
   Leave other settings unless the user asks (`inject` toggles). Project naming
   is automatic (`cmem_work_*`) and is not configurable.
2. Cowork containers are ephemeral: edits to the installed copy last only for
   this session. To make pairing permanent, repackage — zip the plugin
   directory as `<plugin-name>.plugin` and send it to the user to re-install
   (the cowork-plugin skill's packaging flow). Tell the user this is why.
3. If this machine also has a local claude-mem install (a `~/.claude-mem/`
   directory exists), write the same values to
   `~/.claude-mem/settings.json` with mode 0600 (`CLAUDE_MEM_CLOUD_SYNC_TOKEN`,
   `CLAUDE_MEM_CLOUD_SYNC_USER_ID`, `CLAUDE_MEM_CLOUD_SYNC_HUB_URL` keys — the
   same keys the local claude-mem cloud-sync pairing writes). This plugin's
   hooks stay off wherever claude-mem is installed locally, so that pairing is
   what carries this machine's work to cmem.ai. The worker reads those keys
   only at startup: restart it and run the claude-mem cloud-sync skill's
   Verify step, which must report `configured: true` and `hub.reachable: true`.
   Don't report success before it does; if it never does, pair through that
   skill's installer flow instead.
4. Verify without exposing the secret:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cmem-hook.mjs" status
   ```

   Report the masked output. A `MISSING` key means the write didn't land;
   a 404 on `/api/hooks/context` is expected until the Pro endpoints deploy
   (search/injection still work via `/api/mcp`).

## Alternate source

Env vars override everything and need no file edits: `CMEM_API_KEY`,
`CMEM_USER_ID`, `CMEM_SYNC_HUB_URL`, `CMEM_API_BASE`.
