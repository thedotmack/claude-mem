#!/usr/bin/env bash
# Builds "Claude-Mem Messages.app" from this Swift package and zips it.
# Usage: scripts/build-app.sh [version]   (run on a Mac with Xcode 15+ or the Swift 5.9+ toolchain)
# Output: build/Claude-Mem Messages.app and build/Claude-Mem-Messages.zip
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(node -p "require('../../package.json').version" 2>/dev/null || echo 0.0.0)}"
APP="build/Claude-Mem Messages.app"

# A universal (Apple silicon + Intel) build needs Xcode; the plain toolchain
# builds for this Mac only. Whichever build works, its own output is packaged.
BUILD_ARGS=(-c release --arch arm64 --arch x86_64)
if ! swift build "${BUILD_ARGS[@]}"; then
  echo "Universal build failed; building for this Mac only."
  BUILD_ARGS=(-c release)
  swift build "${BUILD_ARGS[@]}"
fi
BIN="$(swift build "${BUILD_ARGS[@]}" --show-bin-path)"
test -x "$BIN/ClaudeMemMessages" || { echo "No ClaudeMemMessages binary in $BIN" >&2; exit 1; }

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
