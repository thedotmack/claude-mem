#!/usr/bin/env bash
# Builds "Claude-Mem Messages.app" from this Swift package and zips it.
# Usage: scripts/build-app.sh [version]   (run on a Mac with Xcode 15+ or the Swift 5.9+ toolchain)
# Output: build/Claude-Mem Messages.app and build/Claude-Mem-Messages.zip
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(node -p "require('../../package.json').version" 2>/dev/null || echo 0.0.0)}"
APP="build/Claude-Mem Messages.app"

swift build -c release --arch arm64 --arch x86_64 2>/dev/null || swift build -c release
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path 2>/dev/null || swift build -c release --show-bin-path)"

rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/ClaudeMemMessages" "$APP/Contents/MacOS/ClaudeMemMessages"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc signature: enough to run on your own Mac. It is not notarized, so the
# first open is right-click > Open. A rebuild changes the signature, and macOS
# then asks for Full Disk Access again.
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"

(cd build && ditto -c -k --keepParent "Claude-Mem Messages.app" Claude-Mem-Messages.zip)
echo "Built $APP ($VERSION)"
