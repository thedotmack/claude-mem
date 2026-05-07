# Codex Plugin Version Mismatch Investigation Plan

Date: 2026-05-06

## Summary

Codex is still exposing `claude-mem` from:

```text
/Users/alexnewman/.codex/plugins/cache/thedotmack/claude-mem/12.3.1
```

That cache entry is the source of the `claude-mem:...` skills loaded in this Codex session. The working tree and the Codex marketplace clone both advertise `12.7.2`, but the enabled Codex plugin points at the old installed cache. This is not a model-memory issue.

The likely root cause is an incomplete migration from marketplace registration to a first-class Codex plugin install. The current installer registers the marketplace, but it does not verify that the actual enabled plugin cache was installed or upgraded to the current `.codex-plugin` bundle.

## Evidence

- Current repository metadata is `12.7.2`:
  - `package.json`
  - `.codex-plugin/plugin.json`
  - `plugin/.codex-plugin/plugin.json`
  - `plugin/package.json`

- Codex marketplace source is current:
  - `/Users/alexnewman/.codex/config.toml` contains `[marketplaces.claude-mem-local]`
  - `last_updated = "2026-05-06T23:13:59Z"`
  - `last_revision = "bb3dbfdb5ae92b55b7e4686e4904995184261232"`
  - `/Users/alexnewman/.codex/.tmp/marketplaces/claude-mem-local/package.json` is `12.7.2`
  - `/Users/alexnewman/.codex/.tmp/marketplaces/claude-mem-local/.codex-plugin/plugin.json` is `12.7.2`

- Active enabled plugin state is still old:
  - `/Users/alexnewman/.codex/config.toml` contains `[plugins."claude-mem@thedotmack"] enabled = true`
  - The only `claude-mem` plugin cache under `~/.codex/plugins/cache/thedotmack/claude-mem` is `12.3.1`
  - `/Users/alexnewman/.codex/plugins/cache/thedotmack/claude-mem/12.3.1/package.json` is `12.3.1`
  - `/Users/alexnewman/.codex/plugins/cache/thedotmack/claude-mem/12.3.1/.install-version` records `{"version":"12.3.1", ...}`

- The active cache is not shaped like the new first-class Codex bundle:
  - It has `.claude-plugin/plugin.json`
  - It does not have `.codex-plugin/plugin.json`
  - It does not have `hooks/codex-hooks.json`
  - Its `.mcp.json` still uses the old `bun` command with `"${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"`

- Current Codex CLI capability is limited:
  - `codex-cli 0.128.0`
  - `codex plugin marketplace` exposes `add`, `upgrade`, and `remove`
  - There is no CLI `plugin list` or `plugin install` subcommand in this build

- Current installer code only registers a marketplace:
  - `src/services/integrations/CodexCliInstaller.ts:188` prints the marketplace root
  - `src/services/integrations/CodexCliInstaller.ts:189` runs `codex plugin marketplace add <root>`
  - `src/services/integrations/CodexCliInstaller.ts:200` through `src/services/integrations/CodexCliInstaller.ts:203` tells the user to open `/plugins` and install manually
  - `src/npx-cli/commands/install.ts:271` through `src/npx-cli/commands/install.ts:281` reports success as "hooks marketplace registered", not "plugin installed"

## Working Theory

There are two independent states:

1. Marketplace source state: current and registered as `claude-mem-local`.
2. Installed plugin cache state: stale and enabled as `claude-mem@thedotmack`.

Codex loads skills, hooks, and MCP metadata from the installed plugin cache, not directly from the marketplace source. Since the installed cache is still `12.3.1`, every new Codex session sees `claude-mem` as `12.3.1`, even though the marketplace clone is already at `12.7.2`.

The `claude-mem@thedotmack` plugin ID also suggests this cache came from an older GitHub marketplace install path, while the current installer registers `claude-mem-local`. That mismatch needs to be handled explicitly during repair and install.

## Phase 0: Reproduce And Baseline

What to do:

- Capture a clean before-state snapshot:
  - `codex --version`
  - `sed -n '1,220p' ~/.codex/config.toml`
  - `find ~/.codex/plugins/cache -maxdepth 5 -type f \( -name 'plugin.json' -o -name 'package.json' -o -name '.mcp.json' -o -name 'codex-hooks.json' \) -print`
  - `find ~/.codex/plugins/cache/thedotmack/claude-mem -maxdepth 2 -type d -print`

- Confirm which paths Codex injects into the session skill list:
  - Start a fresh Codex session.
  - Inspect the available skills list for `claude-mem:` paths.
  - Expected current bad path: `~/.codex/plugins/cache/thedotmack/claude-mem/12.3.1/skills`.

Verification:

- The before-state snapshot shows the stale cache and current marketplace clone side by side.
- The fresh session still reports `12.3.1` before remediation.

Anti-pattern guards:

- Do not delete `~/.codex/plugins/cache` blindly.
- Do not edit unrelated `~/.codex/config.toml` project trust settings.
- Do not assume `codex plugin marketplace upgrade` upgrades the installed plugin cache until verified.

## Phase 1: Local Recovery Procedure

What to do:

- Back up the current Codex plugin state:
  - `cp ~/.codex/config.toml ~/.codex/config.toml.bak-$(date +%Y%m%d-%H%M%S)`
  - Archive or copy `~/.codex/plugins/cache/thedotmack/claude-mem/12.3.1`

- Remove the stale enabled plugin state through supported UI where possible:
  - Open Codex.
  - Run `/plugins`.
  - Disable or uninstall `claude-mem@thedotmack` if it appears.

- Register or refresh the current marketplace:
  - `codex plugin marketplace upgrade claude-mem-local`
  - If needed, re-add from the durable local marketplace root produced by the installer.

- Install `claude-mem` from the `claude-mem (local)` marketplace in `/plugins`.

- Restart Codex.

Verification:

- `~/.codex/plugins/cache` contains a `claude-mem` cache with `.codex-plugin/plugin.json`.
- The active plugin cache has `version: 12.7.2`.
- The active plugin cache has `hooks/codex-hooks.json`.
- The active plugin cache `.mcp.json` uses the portable `sh -c` wrapper from the current repo.
- A fresh Codex session lists `claude-mem:` skills from the new cache, not `12.3.1`.

Anti-pattern guards:

- Do not manually copy the repository into `~/.codex/plugins/cache` as the primary fix. Use it only as a diagnostic fallback.
- Do not leave both `claude-mem@thedotmack` and a new local `claude-mem` enabled if Codex treats them as distinct plugins.
- Do not accept "marketplace upgraded" as proof. The cache path and loaded skill path are the source of truth.

## Phase 2: Installer Fix

What to implement:

- Change the Codex installer outcome from "registered marketplace" to "registered marketplace and verified installability".
- Add a post-registration diagnostic that checks whether an enabled stale `claude-mem` plugin is already present.
- If a stale cache is detected, print a direct remediation message that names the exact stale cache path and exact `/plugins` action required.
- If Codex exposes an install/enable CLI in a future version, use it. In `0.128.0`, keep the `/plugins` step but verify and report the gap.

Code references:

- `src/services/integrations/CodexCliInstaller.ts:10` for `MARKETPLACE_NAME`.
- `src/services/integrations/CodexCliInstaller.ts:12` through `src/services/integrations/CodexCliInstaller.ts:16` for required marketplace files.
- `src/services/integrations/CodexCliInstaller.ts:175` through `src/services/integrations/CodexCliInstaller.ts:214` for install flow.
- `src/npx-cli/commands/install.ts:269` through `src/npx-cli/commands/install.ts:282` for task status text.
- `tests/install-non-tty.test.ts` for existing installer behavior assertions.

Suggested implementation details:

- Add a `diagnoseCodexPluginState()` helper that reads:
  - `~/.codex/config.toml`
  - `~/.codex/plugins/cache/**/claude-mem/**/.codex-plugin/plugin.json`
  - `~/.codex/plugins/cache/**/claude-mem/**/.claude-plugin/plugin.json`
  - `~/.codex/plugins/cache/**/claude-mem/**/.install-version`

- Classify state as:
  - `not_installed`
  - `installed_current_codex`
  - `installed_stale_codex`
  - `installed_legacy_claude_shape`
  - `duplicate_installs`

- Include current repo/package version in the expected state.
- Treat `installed_legacy_claude_shape` as a warning or failure for Codex integration, because it is the exact observed bad state.

Verification:

- Unit tests cover stale `12.3.1` legacy cache with `.claude-plugin` only.
- Unit tests cover current `12.7.2` first-class cache with `.codex-plugin`.
- Unit tests cover duplicate stale plus current installs.
- Installer output no longer says only "hooks marketplace registered" when the installed plugin cache is stale.

Anti-pattern guards:

- Do not parse TOML with regex if a TOML parser is already available in the dependency set.
- Do not bake in `12.7.2`; read expected version from package metadata.
- Do not rely on `~/.codex/.tmp/marketplaces/...` as proof of plugin installation.

## Phase 3: Repair Command Fix

What to implement:

- Extend `npx claude-mem repair --ide codex-cli` or equivalent repair flow to handle Codex first-class plugin state.
- The repair should:
  - Register or upgrade the local marketplace.
  - Detect stale enabled `claude-mem@thedotmack`.
  - Tell the user whether manual `/plugins` installation is still required.
  - Verify the active cache after restart or after the user completes `/plugins`.

Code references:

- `src/npx-cli/commands/install.ts` for marketplace copy and IDE task orchestration.
- `src/services/integrations/CodexCliInstaller.ts` for Codex-specific registration.
- `src/npx-cli/commands/uninstall.ts` for uninstall symmetry.

Verification:

- Repair from a synthetic `12.3.1` legacy cache reports the correct stale-cache diagnosis.
- Repair from a current cache is idempotent.
- Repair does not remove unrelated Codex settings or non-claude-mem plugins.

Anti-pattern guards:

- Do not silently delete old caches without a backup or explicit command mode.
- Do not make repair depend on an interactive TUI if the install command supports non-TTY mode.

## Phase 4: Documentation Fix

What to update:

- Document that Codex currently has two steps:
  - Marketplace registration via `npx claude-mem install`.
  - Plugin install/enable via `/plugins`.

- Add troubleshooting for this exact mismatch:
  - Symptom: Codex skill list shows `~/.codex/plugins/cache/thedotmack/claude-mem/12.3.1`.
  - Cause: stale installed plugin cache, despite current marketplace source.
  - Fix: uninstall old `claude-mem@thedotmack`, install from `claude-mem (local)`, restart Codex.

Code/doc references:

- `docs/public/installation.mdx`
- `docs/public/troubleshooting.mdx`
- `README.md`

Verification:

- Docs mention the cache path as a diagnostic check.
- Docs do not imply that `codex plugin marketplace add` alone installs the plugin.

## Phase 5: End-To-End Verification

Manual verification checklist:

- Fresh install on a clean Codex profile.
- Upgrade from old `12.3.1` cache.
- Upgrade from current marketplace but stale installed cache.
- Duplicate install case with both `claude-mem@thedotmack` and local `claude-mem`.

Acceptance criteria:

- Fresh Codex session loads `claude-mem:` skills from a current cache path.
- Loaded plugin cache contains `.codex-plugin/plugin.json`.
- Loaded plugin cache contains Codex hooks at the path declared by `.codex-plugin/plugin.json`.
- MCP server starts through the current `.mcp.json` wrapper.
- Installer and repair output make stale-cache state explicit.

## Open Questions

- Does the Codex `/plugins` UI use marketplace name, repository owner, or plugin author to derive the installed plugin cache namespace?
- Does `codex plugin marketplace upgrade claude-mem-local` intentionally avoid updating already-installed plugin caches?
- Is there a hidden or upcoming non-interactive plugin install command that can replace the manual `/plugins` step?
- Should the installer remove or disable `claude-mem@thedotmack` when installing `claude-mem-local`, or should it only warn?
