# Multi-Platform Build Guide

This project now supports building binaries for multiple platforms using Bun's cross-compilation capabilities.

## Supported Platforms

- **Windows x64**: `claude-mem.exe`
- **Linux x64**: `claude-mem-linux` 
- **Linux ARM64**: `claude-mem-linux-arm64`
- **macOS ARM64**: `claude-mem-macos-arm64`
- **macOS x64**: `claude-mem-macos-x64`

## Building

### Build All Platforms

To build binaries for all supported platforms:

```bash
npm run build:multiplatform
```

This will create binaries in the `releases/binaries/` directory.

### Build for NPM Package

To build a complete npm package with all platform binaries:

```bash
npm run publish
```

This creates a package in `releases/npm-package/` that includes:
- Platform detection wrapper script
- All platform-specific binaries
- Hooks and configuration files

## How Platform Detection Works

The npm package includes a Node.js wrapper script (`claude-mem`) that:

1. Detects the current platform using `process.platform` and `process.arch`
2. Maps the platform to the appropriate binary filename
3. Executes the correct binary with all command-line arguments

### Platform Mapping

| Platform | Architecture | Binary Filename |
|----------|-------------|------------------|
| Windows | x64 | `claude-mem.exe` |
| Linux | x64 | `claude-mem-linux` |
| Linux | arm64/aarch64 | `claude-mem-linux-arm64` |
| macOS | arm64 | `claude-mem-macos-arm64` |
| macOS | x64 | `claude-mem-macos-x64` |

## Usage

After installation via npm, users can run:

```bash
npx claude-mem --help
```

The wrapper will automatically select and execute the correct binary for their platform.

## Troubleshooting

### Unsupported Platform Error

If you see an "Unsupported platform" error, check that your platform/architecture combination is in the supported list above.

### Binary Not Found Error

This indicates the platform detection worked, but the expected binary file is missing from the package. This shouldn't happen with properly built packages.

## Development

### Adding New Platforms

To add support for new platforms:

1. Add the platform to the `PLATFORMS` array in `scripts/build-multiplatform.sh`
2. Update the platform detection logic in `scripts/claude-mem-wrapper.js`
3. Update this documentation

### Testing Binaries

Test that a specific binary works:

```bash
# Test Linux binary
./releases/binaries/claude-mem-linux --help

# Test Windows binary (on Windows or with Wine)
./releases/binaries/claude-mem.exe --help
```