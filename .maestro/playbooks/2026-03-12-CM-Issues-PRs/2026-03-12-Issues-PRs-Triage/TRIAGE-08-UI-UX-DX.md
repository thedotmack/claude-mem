# Phase 08: Medium — UI/UX & Developer Experience

These issues affect the web UI, plugin installation experience, and developer-facing behavior. None are data-loss bugs, but they erode user trust — mismatched IDs, broken live updates, and silent installation failures make claude-mem feel unreliable.

**Issues addressed:** #1339, #1331, #1265, #1268, #1340, #1332
**Prerequisite:** Phases 01-07 should be complete.

## Tasks

- [ ] Fix Web UI observation ID mismatch (#1339). The IDs shown in the web viewer don't match the IDs returned by `get_observations` MCP tool, making the "access memories by ID" prompt misleading:
  - Read the viewer UI source in `src/ui/viewer/` — search for how observation IDs are displayed
  - Read the `get_observations` MCP tool handler to see what ID format it expects (search for `get_observations` in `src/services/worker/`)
  - The mismatch is likely between a display ID (row number or array index) and the actual database `id` column
  - The fix: ensure the web UI displays the same ID that `get_observations` accepts. This should be the database primary key (`observations.id`), not an index
  - If the UI currently shows a sequential display number, add the real ID alongside it (e.g., `#58640` format matching the session context index)
  - Check the SSE broadcast format too — the IDs in SSE events should match

- [ ] Fix SSE broadcast stopping after /reload-plugins (#1331). Live observation updates in the web UI stop working after Claude Code's `/reload-plugins` command:
  - Read the SSE implementation — search for `SSE`, `EventSource`, `text/event-stream` in the worker HTTP routes
  - The issue is likely that `/reload-plugins` causes hook reconnection which drops the SSE connection, and the UI doesn't auto-reconnect
  - The fix should be in the viewer UI (client-side):
    1. In the SSE client code, add `EventSource.onerror` handler that auto-reconnects after a 2-second delay
    2. On reconnect, fetch the latest observations via REST to fill the gap
  - If the SSE endpoint itself is being torn down on reload, the server-side fix is to keep the SSE endpoint alive independently of plugin reload
  - Search for existing reconnect logic in the viewer before adding new code

- [ ] Add model name display on observation/summary cards (#1265). Users want to see which AI model produced each observation:
  - Check if model information is already stored in the observations database table. Search for `model` in `src/services/sqlite/observations/types.ts` and the store
  - If model data exists in the DB, add it to the viewer UI card component
  - If not in DB, check if it's available in the hook input — search for `model` in `src/cli/types.ts` and `NormalizedHookInput`
  - If model data is available in hook input but not stored, add it to the observation storage pipeline (add column, thread through handlers)
  - In the viewer UI, display the model name as a subtle badge on each card (e.g., "claude-sonnet-4-6")

- [ ] Fix plugin disappearing after Claude Code update (#1268). When Claude Code updates, the plugin symlink or installation gets broken:
  - Read the plugin installation/sync logic — search for `marketplace`, `sync`, `symlink` in `scripts/`
  - Read `scripts/sync-marketplace.cjs` to understand how the plugin is installed
  - The fix: add a self-repair check in the SessionStart hook. Before normal operation:
    1. Check if the plugin files exist at the expected installed path (`~/.claude/plugins/marketplaces/thedotmack/`)
    2. If missing, re-run the marketplace sync automatically
    3. Log a warning: "Plugin installation repaired after Claude Code update"
  - This should be lightweight — just an `existsSync()` check, not a full sync on every startup

- [ ] Fix missing setup.sh referenced by setup hook (#1340). The hooks.json references `scripts/setup.sh` which doesn't exist in v10.5.5:
  - Read `plugin/hooks/hooks.json` — find the setup hook entry
  - Check if `scripts/setup.sh` was removed or renamed. Search git history if needed: `git log --oneline --all -- scripts/setup.sh`
  - If the script was removed intentionally, remove the setup hook entry from hooks.json
  - If it was accidentally removed, check if its functionality was moved to another script (likely `smart-install.js`) and update the hook to point to the correct script
  - Also check if the OpenClaw plugin config (#1332) is affected by the same missing script issue

- [ ] Run tests and build:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - Open the viewer UI at `http://localhost:37777` and verify observations display with correct IDs
