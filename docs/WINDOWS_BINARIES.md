# Windows Binary Build Guide

Claude-mem can be compiled into a standalone Windows executable using Bun's compilation feature.

## Building the Windows Binary

To create a standalone Windows executable:

```bash
npm run build:binaries
```

This creates:
- `dist/binaries/worker-service-v{VERSION}-win-x64.exe` — Standalone worker service executable

## Build Output

The compiled binary is approximately **112 MB** and includes:
- Full Node.js/Bun runtime
- SQLite database engine
- All dependencies (tree-sitter, chroma, etc.)
- Minified code

## Binary Details

**Name:** `worker-service-v10.6.2-win-x64.exe`
**Size:** ~112 MB (includes runtime)
**Platform:** Windows x64
**Runtime:** Bun (self-contained)

## Using the Binary

The executable can be used in place of running `node worker-service.cjs`:

```powershell
# Instead of:
# node scripts/worker-service.cjs start

# You can use:
dist/binaries/worker-service-v10.6.2-win-x64.exe start
```

## Distribution

For distributing claude-mem to Windows users without Node.js/Bun installed:

1. Build the binary: `npm run build:binaries`
2. Include `dist/binaries/worker-service-v10.6.2-win-x64.exe` in the release
3. Update installer to use `.exe` instead of `node worker-service.cjs`

## Technical Details

The binary is built using:
- **Bun's `build --compile` feature**
- **Target:** `bun-windows-x64`
- **Minification:** Enabled for smaller size
- **Entry point:** `src/services/worker-service.ts`

## Build Prerequisites

- **Bun** (auto-installed if missing)
- **Windows 10 or later**
- **Node.js >= 18** (for npm/build scripts)

## Troubleshooting

### "Could not resolve"

If you get import resolution errors:
1. Ensure all TypeScript source files exist
2. Check that all imports use correct paths
3. Run `npm run build` first to validate source

### Large File Size

The 112 MB size is expected because it includes:
- Complete Node.js/Bun runtime
- All native dependencies
- SQLite binaries

To reduce size:
- Remove optional dependencies
- Use tree-shaking (already enabled)
- Consider stripping debug symbols (expert option)

### Compilation Timeout

If compilation exceeds time limit:
1. Increase timeout in `scripts/build-worker-binary.js`
2. Close other applications to free system resources
3. Use a faster disk (SSD recommended)

## Future Improvements

- [ ] Create installer that bundles the .exe
- [ ] Add code signing for Windows SmartScreen
- [ ] Create portable release packages
- [ ] Build cross-architecture binaries (ARM64)
- [ ] Reduce binary size with custom tree-sitter builds

---

For more info, see `scripts/build-worker-binary.js`
