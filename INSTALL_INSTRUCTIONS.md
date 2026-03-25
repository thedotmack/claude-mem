# Claude-mem Installation Instructions (Windows)

## Quick Start - Choose One Method:

### Method 1: Double-Click (Easiest) 🖱️

1. Find `INSTALL_WINDOWS.bat` in the project root
2. Double-click it
3. Follow the interactive prompts
4. Done!

### Method 2: PowerShell

1. Open PowerShell
2. Navigate to the project directory:
   ```powershell
   cd C:\Path\To\claude-mem
   ```
3. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File INSTALL_WINDOWS.ps1
   ```

### Method 3: Command Line

1. Open Command Prompt or PowerShell
2. Navigate to the project directory
3. Run:
   ```bash
   node install/public/install.js
   ```

---

## What the Installer Does

1. ✅ Verifies Node.js version (>= 18)
2. ✅ Selects IDE (Claude Code, Cursor, or both)
3. ✅ Configures AI provider (OpenAI, Anthropic, Gemini, etc.)
4. ✅ Sets up plugin directories
5. ✅ Installs dependencies
6. ✅ Starts worker service
7. ✅ Validates installation

---

## After Installation

Claude-mem will:
- 🧠 Automatically hook into Claude Code
- 💾 Persist your memory across sessions
- 🔍 Inject relevant context automatically

---

## Troubleshooting

**"Node.js not found"**
- Install from https://nodejs.org (v18 or later)

**"Installer requires interactive terminal"**
- Use the `.bat` file or PowerShell method above
- Do NOT use Git Bash for installation

**"Permission denied"**
- Run Command Prompt/PowerShell as Administrator

---

For more details, see:
- `docs/WINDOWS_INSTALLATION.md` — Full guide
- `docs/WINDOWS_BINARIES.md` — Binary compilation

**Questions?** Check GitHub: https://github.com/thedotmack/claude-mem
