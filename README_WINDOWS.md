# Windows Installation Guide

## Overview

Claude-mem now includes **experimental Windows support** as of v3.10.0 (October 2025). The cross-platform architecture uses the [Platform utility](/src/utils/platform.ts) for handling Windows-specific differences.

## System Requirements

- **Windows 10/11** (64-bit recommended)
- **Node.js** >= 18.0.0
- **PowerShell** 5.1 or later (for hook execution)
- **Claude Code** with MCP support
- **npm** package manager

**Note**: Bun (>=1.0.0) is only required for development work on claude-mem itself, not for running it.

## Known Windows-Specific Differences

### 1. Hook Execution
- **Unix/macOS**: Hooks execute via `/bin/sh`
- **Windows**: Hooks execute via `powershell`

All hooks are `.js` files that work on both platforms through Node.js.

### 2. Path Handling
Windows paths use backslashes (`\`) but Node.js normalizes these automatically. The data directory is located at:
```
C:\Users\YourUsername\.claude-mem\
```

### 3. File Permissions
- **Unix/macOS**: Hook files get `chmod 755` permissions
- **Windows**: Permission setting is a no-op (not needed)

### 4. Smart Trash™ Alias
The Smart Trash feature creates shell aliases differently:

**Windows (PowerShell)**:
```powershell
# claude-mem smart trash alias
function rm { claude-mem trash $args }
```

PowerShell profiles are located at:
- `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`
- `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`

**Unix/macOS (Bash/Zsh)**:
```bash
# claude-mem smart trash alias
alias rm='claude-mem trash'
```

### 5. UV Package Manager Installation
The installer automatically installs `uv` using platform-specific methods:

**Windows**:
```powershell
powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"
```

**Unix/macOS**:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Installation Steps

### 1. Install claude-mem globally

```powershell
npm install -g claude-mem
```

### 2. Run the installer

```powershell
claude-mem install
```

The installer will:
1. ✅ Create directory structure at `C:\Users\YourUsername\.claude-mem\`
2. ✅ Install UV package manager via PowerShell
3. ✅ Install Chroma MCP server for vector database
4. ✅ Add CLAUDE.md instructions to `C:\Users\YourUsername\.claude\`
5. ✅ Install slash commands (save.md, remember.md, claude-mem.md)
6. ✅ Install memory hooks with PowerShell execution support
7. ✅ Configure Claude Code settings

### 3. Restart Claude Code

After installation, restart Claude Code to activate the memory system.

## Windows-Specific Caveats

### PowerShell Execution Policy
If hooks fail to execute, you may need to adjust your PowerShell execution policy:

```powershell
# Check current policy
Get-ExecutionPolicy

# Allow local scripts (choose one):
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# OR for more security:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
```

### Path Environment Variable
After installing UV, you may need to restart PowerShell or update your PATH:

```powershell
# Add to PATH if needed
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
```

The installer attempts to set this automatically, but it only affects the current process.

### Better-SQLite3 Native Module
The hooks use `better-sqlite3` for database access, which requires native compilation:
- The installer runs `npm install` in the hooks directory
- If this fails, hooks may still work if `better-sqlite3` is globally available
- Build errors are silently ignored to prevent installation failure

If you see database errors in logs:
```powershell
cd $env:USERPROFILE\.claude-mem\hooks
npm install better-sqlite3 --build-from-source
```

## File Locations on Windows

| Component | Windows Path |
|-----------|-------------|
| Data directory | `C:\Users\YourUsername\.claude-mem\` |
| ChromaDB | `C:\Users\YourUsername\.claude-mem\chroma\` |
| SQLite database | `C:\Users\YourUsername\.claude-mem\claude-mem.db` |
| Hooks | `C:\Users\YourUsername\.claude-mem\hooks\` |
| Archives | `C:\Users\YourUsername\.claude-mem\archives\` |
| Trash | `C:\Users\YourUsername\.claude-mem\trash\` |
| CLAUDE.md | `C:\Users\YourUsername\.claude\CLAUDE.md` |
| Settings | `C:\Users\YourUsername\AppData\Roaming\Claude\settings.json` |
| Commands | `C:\Users\YourUsername\.claude\commands\` |

## Testing Your Installation

### 1. Check installation status
```powershell
claude-mem status
```

### 2. Run diagnostics
```powershell
claude-mem doctor
```

This will verify:
- ✅ Directory structure
- ✅ Hook configuration
- ✅ Database accessibility
- ✅ MCP server integration

### 3. Test memory storage
Start Claude Code and have a brief conversation. Then check:
```powershell
claude-mem status
```

You should see memory counts increase.

### 4. Search memories
In Claude Code, ask:
```
Search my memories for [your topic]
```

Claude should use the `mcp__claude-mem__chroma_query_documents` tool automatically.

## Known Issues & Limitations

### ⚠️ PowerShell Profile Creation
- **Issue**: PowerShell profiles may not exist by default
- **Impact**: Smart Trash alias installation creates profile directories
- **Status**: Installer handles this automatically

### ⚠️ Native Module Compilation
- **Issue**: `better-sqlite3` requires build tools
- **Impact**: May need Visual Studio Build Tools installed
- **Workaround**: Installer attempts silent installation; manually rebuild if needed

### ⚠️ Path Case Sensitivity
- **Issue**: Windows paths are case-insensitive but ChromaDB metadata stores exact case
- **Impact**: Path comparisons may fail in edge cases
- **Status**: Generally works fine; use consistent casing

## Getting Help

If you encounter Windows-specific issues:

1. **Run diagnostics**:
   ```powershell
   claude-mem doctor
   ```

2. **Check logs**:
   ```powershell
   claude-mem logs
   ```
   Or view directly:
   ```powershell
   type $env:USERPROFILE\.claude-mem\logs\*.log
   ```

3. **Verify hook execution**:
   Check Claude Code's hook output for errors during session start/stop

4. **Report issues**:
   - Include `claude-mem doctor` output
   - Include relevant logs
   - Specify Windows version and PowerShell version
   - File at: https://github.com/thedotmack/claude-mem/issues

## Development on Windows

If you're developing claude-mem on Windows:

### Prerequisites
- Install Bun (Windows support is experimental): https://bun.sh/
- Install Git for Windows
- Install Visual Studio Build Tools for native modules

### Build Commands
```powershell
# Install dependencies
npm install

# Build minified bundle
npm run build

# Link for local testing
bun link

# Reinstall with latest build
claude-mem install --force
```

**Note**: Some npm scripts use Unix-style paths and may not work on Windows. Core development is recommended on Unix/macOS systems.

## Summary

✅ **Works on Windows**:
- Memory capture via streaming hooks
- ChromaDB semantic search
- SQLite metadata storage
- MCP server integration
- All CLI commands
- Smart Trash™ system
- Automatic context loading

⚠️ **May Require Extra Setup**:
- PowerShell execution policy
- Visual Studio Build Tools for native modules
- Manual PATH configuration

The core claude-mem functionality is fully operational on Windows, with the memory capture, storage, and retrieval systems working identically to Unix/macOS.
