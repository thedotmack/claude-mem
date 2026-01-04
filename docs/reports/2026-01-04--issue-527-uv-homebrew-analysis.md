# Issue #527: uv Detection Fails on Apple Silicon Macs with Homebrew Installation

**Date**: 2026-01-04
**Issue**: GitHub Issue #527
**Status**: Confirmed - Fix Required

## Summary

The `isUvInstalled()` function fails to detect uv when installed via Homebrew on Apple Silicon Macs because it does not check the `/opt/homebrew/bin/uv` path.

## Analysis

### Files Affected

Two copies of `smart-install.js` exist in the codebase:

1. **Source file**: `/Users/alexnewman/Scripts/claude-mem/scripts/smart-install.js`
2. **Built/deployed file**: `/Users/alexnewman/Scripts/claude-mem/plugin/scripts/smart-install.js`

### Current uv Path Detection

**Source file (`scripts/smart-install.js`)** - Lines 22-24:
```javascript
const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];
```

**Plugin file (`plugin/scripts/smart-install.js`)** - Lines 103-105:
```javascript
const uvPaths = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];
```

### Paths Currently Checked (Unix/macOS)

| Path | Installer | Architecture |
|------|-----------|--------------|
| `~/.local/bin/uv` | Official installer | Any |
| `~/.cargo/bin/uv` | Cargo/Rust install | Any |
| `/usr/local/bin/uv` | Homebrew (Intel) | x86_64 |

### Missing Path

| Path | Installer | Architecture |
|------|-----------|--------------|
| `/opt/homebrew/bin/uv` | Homebrew (Apple Silicon) | arm64 |

## Root Cause

Homebrew installs to different prefixes depending on architecture:
- **Intel Macs (x86_64)**: `/usr/local/bin/`
- **Apple Silicon Macs (arm64)**: `/opt/homebrew/bin/`

The current implementation only includes the Intel Homebrew path, causing detection to fail on Apple Silicon when:
1. uv is installed via `brew install uv`
2. The user's shell PATH is not available during script execution (common in non-interactive contexts)

## Impact

Users on Apple Silicon Macs who installed uv via Homebrew will:
1. See "uv not found" errors
2. Have uv unnecessarily reinstalled via the official installer
3. End up with duplicate installations

## Recommended Fix

Add `/opt/homebrew/bin/uv` to the Unix paths array.

### Source file (`scripts/smart-install.js`) - Line 24

**Before:**
```javascript
: [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];
```

**After:**
```javascript
: [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];
```

### Plugin file (`plugin/scripts/smart-install.js`) - Lines 103-105 and 222-224

The same fix should be applied in both locations where `uvPaths` is defined:
- Line 105 in `isUvInstalled()`
- Line 224 in `installUv()`

### Note: Bun Has the Same Issue

The Bun detection has the same gap:

**Current (`scripts/smart-install.js` line 20):**
```javascript
: [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];
```

**Should also add:**
```javascript
: [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];
```

## Verification

After the fix, verify by:
1. Installing uv via Homebrew on an Apple Silicon Mac
2. Running the smart-install script
3. Confirming uv is detected without attempting reinstallation

## Conclusion

**Fix is required.** The `/opt/homebrew/bin/uv` path is missing from both files. This is a simple one-line addition to the path arrays. The same fix should also be applied to Bun detection paths for consistency.
