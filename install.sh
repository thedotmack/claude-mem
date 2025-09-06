#!/bin/bash
# Claude Mem Installation Script

set -e

VERSION="${1:-latest}"
PLATFORM=""
ARCH=$(uname -m)
OS=$(uname -s)

# Detect platform
case "$OS" in
  Darwin)
    if [ "$ARCH" = "arm64" ]; then
      PLATFORM="macos-arm64"
      BINARY="claude-mem-macos-arm64"
    else
      PLATFORM="macos-x64"
      BINARY="claude-mem-macos-x64"
    fi
    ;;
  Linux)
    if [ "$ARCH" = "aarch64" ]; then
      PLATFORM="linux-arm64"
      BINARY="claude-mem-linux-arm64"
    else
      PLATFORM="linux-x64"
      BINARY="claude-mem-linux"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="windows-x64"
    BINARY="claude-mem.exe"
    ;;
  *)
    echo "Unsupported platform: $OS $ARCH"
    exit 1
    ;;
esac

echo "📥 Downloading Claude Mem for $PLATFORM..."

# Download binary from GitHub releases
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/thedotmack/claude-mem/releases/latest/download/${BINARY}"
else
  DOWNLOAD_URL="https://github.com/thedotmack/claude-mem/releases/download/${VERSION}/${BINARY}"
fi

curl -L -o claude-mem "$DOWNLOAD_URL"

# Make executable (non-Windows)
if [ "$OS" != "MINGW" ] && [ "$OS" != "MSYS" ] && [ "$OS" != "CYGWIN" ]; then
  chmod +x claude-mem
fi

echo "✅ Claude Mem installed successfully!"
echo "Run ./claude-mem --help to get started"
