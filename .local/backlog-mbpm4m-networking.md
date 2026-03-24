# Resolved: MBPM4M Bun daemon networking failure

**Date**: 2026-03-24
**Status**: ROOT CAUSE FOUND

## Root Cause

Bun daemons launched via SSH background (`nohup ... &`) on MBPM4M lose outbound network access after a few seconds. The same code launched from a local terminal (via RustDesk or console) works perfectly.

This is a macOS SSH session isolation issue, not a Bun bug. SSH sessions on MBPM4M have restricted network extension access for background processes.

## Solution

Launch the proxy from a **local terminal** or via **launchd** (which runs in the user's login session, not SSH):
```bash
bun ~/.claude-mem/proxy.ts
```

Or configure launchd plist for auto-start at login (like MSM3U server mode).

## Note

This issue does NOT affect MSM4M (the proxy works fine via SSH there). The difference is likely a macOS Privacy & Security setting specific to MBPM4M's configuration.
