# Installation Guide

## Quick Install (Recommended)

### Via NPM
```bash
npm install -g claude-mem
```

### Via curl
```bash
curl -fsSL https://raw.githubusercontent.com/thedotmack/claude-mem/main/install.sh | bash
```

## Manual Installation

1. Download the appropriate binary for your platform from [Releases](https://github.com/thedotmack/claude-mem/releases/latest):
   - **Windows**: `claude-mem.exe`
   - **Linux x64**: `claude-mem-linux`
   - **Linux ARM64**: `claude-mem-linux-arm64`
   - **macOS Intel**: `claude-mem-macos-x64`
   - **macOS Apple Silicon**: `claude-mem-macos-arm64`

2. Make it executable (Unix-based systems):
   ```bash
   chmod +x claude-mem-*
   ```

3. Move to your PATH:
   ```bash
   sudo mv claude-mem-* /usr/local/bin/claude-mem
   ```

## After Installation

Once the binary is installed, set up Claude Code integration:

```bash
claude-mem install
```

This will:
- Install the Chroma MCP server
- Configure Claude Code hooks
- Set up the memory system

## Platform Detection

The `claude-mem` command automatically detects your platform and runs the correct binary. No manual selection needed!

## Troubleshooting

If you get a "command not found" error:
1. Ensure the binary is in your PATH
2. Try running with full path: `./claude-mem`
3. Check binary permissions: `ls -la claude-mem*`

For other issues, please check our [Issues](https://github.com/thedotmack/claude-mem/issues) page.