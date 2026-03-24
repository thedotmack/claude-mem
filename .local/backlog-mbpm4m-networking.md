# Backlog: MBPM4M Bun daemon networking failure

**Date**: 2026-03-24
**Priority**: Medium
**Status**: Workaround available, root cause unknown

## Problem

On MBPM4M (mbp-m4max-regis), Bun processes launched as background daemons (via SSH `nohup &`, `spawnDaemon()` detached, or shell `&`) cannot make outbound HTTP fetch() calls. All fetch attempts fail with "Unable to connect" or "Was there a typo in the url or port?"

## What works

- `curl` from MBPM4M to MSM3U: OK
- `bun -e "fetch(...)"` in interactive SSH: OK
- `bun /tmp/test-fetch.ts` in interactive SSH: OK
- `bun /tmp/test-fetch.ts &` in interactive SSH: OK (tested with test script)
- `spawn(bun, [...], { detached: true })` from interactive bun: OK (tested)

## What fails

- `bun worker-service.cjs --daemon` launched via `nohup ... &` over SSH: FAIL
- `bun worker-service.cjs start` (which uses spawnDaemon): FAIL
- Any daemon Bun process launched from a non-interactive SSH session: FAIL

## Tested and ruled out

- [x] Bun version (upgraded 1.3.8 → 1.3.11, same failure)
- [x] macOS Firewall (added Bun to allowed apps, same failure)
- [x] DNS resolution (tried hostname, .local, Thunderbolt IP, LAN IP — all fail)
- [x] Auth token (verified present and correct)

## Working on MSM4M

The same proxy code works perfectly on MSM4M (macstudio-m4max-regis). The difference is likely a macOS Security & Privacy setting or network filter specific to MBPM4M.

## Hypothesis

MBPM4M may have:
- App Management or Background Items restriction blocking Bun network access
- A network content filter (Screen Time, MDM, or third-party)
- Different Bun binary signing status

## Workaround

Launch the proxy from an interactive terminal on MBPM4M (not via SSH):
```bash
bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs --daemon
```

Or let Claude Code hooks launch it naturally during a session on MBPM4M.

## Investigation steps

- [ ] Check System Settings > Privacy & Security > App Management on MBPM4M
- [ ] Check System Settings > General > Login Items & Extensions > Background Items
- [ ] Compare `codesign -dvvv` output for bun on both machines
- [ ] Check if Little Snitch, Lulu, or other network filter is installed
- [ ] Test launching bun daemon from a local terminal (not SSH)
- [ ] Compare `defaults read /Library/Preferences/com.apple.alf` between machines
