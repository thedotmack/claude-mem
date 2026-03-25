# Windows Installation Guide

Claude-mem now supports Windows! Follow this guide to install the plugin on Windows.

## Prerequisites

- **Node.js >= 18.0.0** ([Download](https://nodejs.org))
- **Windows 10 or later** (Windows 11 recommended)
- **PowerShell 5.0+** (included with Windows 10+)

## Installation Methods

### Method 1: Node.js (Recommended)

The easiest way to install on Windows is using Node.js directly:

```powershell
node install/public/install.js
```

Or from npm scripts:

```powershell
npm run install:windows
```

### Method 2: PowerShell

If you prefer using PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install/public/install.ps1
```

Or from npm scripts:

```powershell
npm run install:windows:ps1
```

### Method 3: Git Clone (Development)

Clone the repository and run the installer:

```powershell
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
node install/public/install.js
```

## What the Installer Does

1. **Verifies Node.js version** (must be >= 18)
2. **Selects IDE** (Claude Code, Cursor, or both)
3. **Configures AI provider** (OpenAI, Anthropic, Gemini, etc.)
4. **Sets up plugin directories** in `%USERPROFILE%\.claude\plugins\marketplaces\thedotmack`
5. **Installs dependencies** (Bun runtime if needed)
6. **Starts the worker service** for persistent memory
7. **Validates installation** and displays next steps

## File Locations

On Windows, claude-mem stores data in these locations:

| Component | Location |
|-----------|----------|
| Plugin | `%USERPROFILE%\.claude\plugins\marketplaces\thedotmack\plugin\` |
| Database | `%USERPROFILE%\.claude-mem\` |
| Config | `%USERPROFILE%\.claude-mem\settings.json` |
| Logs | `%USERPROFILE%\.claude-mem\logs\` |

Replace `%USERPROFILE%` with your user home directory (usually `C:\Users\YourUsername`).

## Troubleshooting

### "Node.js >= 18 required"

Make sure you have Node.js 18 or later installed:

```powershell
node -v
```

If the version is below 18, download and install from [nodejs.org](https://nodejs.org).

### "Installer script not found"

The script looks for the installer in these locations:
- `install/public/installer.js`
- `installer/dist/index.js`
- Current directory

Make sure you're running the installer from the project root or have the correct project structure.

### "This installer requires an interactive terminal"

This is expected if you're running in a non-TTY environment. Run the installer directly:

```powershell
node install/public/install.js
```

### PowerShell Execution Policy

If you get an execution policy error with the `.ps1` script, run:

```powershell
powershell -ExecutionPolicy Bypass -File install/public/install.ps1
```

Or change the execution policy temporarily:

```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope CurrentUser -Force
```

### Admin Privileges

Some features (like creating symlinks) may require admin privileges. If you encounter permission errors, try running PowerShell as Administrator:

1. Right-click **PowerShell**
2. Select **Run as administrator**
3. Run the installer command

## After Installation

Once installed, claude-mem:

1. **Automatically hooks into Claude Code** lifecycle events
2. **Compresses and stores memory** of all tool usage
3. **Injects relevant context** into future sessions

Check the main [README.md](../README.md) for usage and configuration details.

## Windows-Specific Notes

### Hook Execution

On Windows, hooks are executed via PowerShell with proper path handling using `Join-Path`. This ensures compatibility with:
- Spaces in usernames and paths
- Special characters in paths
- Network paths and UNC paths

### Performance

Windows may have slightly slower startup times due to:
- Disk I/O patterns on NTFS
- Bun runtime initialization on first run
- PowerShell cold start overhead

This is normal and improves after the first session.

### Symlinks

If symlinks fail to create, you may need:
- Administrator privileges
- Windows Developer Mode enabled (Windows 10+)
- Or manually copy files instead

The installer will guide you through this if needed.

## Support

If you encounter issues:

1. Check the [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
2. Review logs in `%USERPROFILE%\.claude-mem\logs\`
3. Report the issue with your Node.js version and installation method

---

**Happy memory compression!** 🧠✨
