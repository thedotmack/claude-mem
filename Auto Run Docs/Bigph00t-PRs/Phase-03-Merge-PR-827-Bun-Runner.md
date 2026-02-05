# Phase 03: Merge PR #827 - Bun Runner for Fresh Install

**PR:** https://github.com/thedotmack/claude-mem/pull/827
**Branch:** `fix/fresh-install-bun-path-818`
**Status:** Has conflicts, needs rebase
**Review:** Approved by bayanoj330-dev
**Priority:** MEDIUM - Fixes fresh installation issues

## Summary

Fixes the fresh install issue where worker fails to start because Bun isn't in PATH yet after `smart-install.js` installs it.

**Root Cause:** On fresh installations:
1. `smart-install.js` installs Bun to `~/.bun/bin/bun`
2. Bun isn't in current shell's PATH until terminal restart
3. Hooks try to run `bun ...` directly and fail
4. Worker never starts, database never created

**Solution:** Introduce `bun-runner.js` - a Node.js script that finds Bun in common install locations (not just PATH) and runs commands with it.

## Files Changed

| File | Change |
|------|--------|
| `plugin/scripts/bun-runner.js` | NEW: Script to find and run Bun |
| `plugin/hooks/hooks.json` | Use `node bun-runner.js` instead of direct `bun` calls |

## Dependencies

- **None** - Independent fix

## Fixes Issues

- #818

## Bun Search Locations

The bun-runner checks these locations in order:
- PATH (via `which`/`where`)
- `~/.bun/bin/bun` (default install location)
- `/usr/local/bin/bun`
- `/opt/homebrew/bin/bun` (macOS Homebrew)
- `/home/linuxbrew/.linuxbrew/bin/bun` (Linuxbrew)
- Windows: `%LOCALAPPDATA%\bun\bin\bun.exe` with fallback

## Tasks

- [ ] Checkout PR branch `fix/fresh-install-bun-path-818` and rebase onto main to resolve conflicts
- [ ] Review `bun-runner.js` for correctness across platforms
- [ ] Verify hooks.json uses correct `node bun-runner.js` pattern
- [ ] Verify build succeeds after rebase
- [ ] Merge PR #827 to main
- [ ] Test on fresh install (uninstall claude-mem, reinstall) to verify Bun is found

## Verification

```bash
# After merge, verify bun-runner finds Bun
node plugin/scripts/bun-runner.js --version

# Check hooks.json uses bun-runner
grep -i "bun-runner" plugin/hooks/hooks.json
```

## Notes

- This is a surgical fix that doesn't change core functionality
- All hooks now go through the Node.js bun-runner script
- Cross-platform: Linux, macOS, Windows
- The bun-runner approach is more robust than relying on PATH
