#!/usr/bin/env bash
# Builds "Claude-Mem Messages.app" from this Swift package and zips it.
# Usage: scripts/build-app.sh [version]   (run on a Mac with Xcode 15+, Bun and the locked observer dependencies)
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

rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Helpers"
cp "$BIN/ClaudeMemMessages" "$APP/Contents/MacOS/ClaudeMemMessages"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# These self-contained readers have no runtime npm dependency or shell lookup.
# Keep architecture-specific executables intact; Bun embeds JS data in each image.
../../node_modules/.bin/esbuild observer/photon-sdk.cts --bundle --platform=node --target=node22 \
  --format=cjs --log-override:empty-import-meta=silent --outfile=observer/photon-sdk.cjs
for arch in arm64 x64; do
  helper="$APP/Contents/Helpers/imessage-observer-$arch"
  bun build observer/index.ts --compile --target="bun-darwin-$arch" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile "$helper"
  codesign --force --sign - --options runtime "$helper"
done

# Ad-hoc releases use macOS System Settings > Privacy & Security > Open Anyway
# on first open when prompted. Rebuilds may need a fresh Full Disk Access grant.
codesign --force --sign - --options runtime "$APP"
codesign --verify --deep --strict --verbose "$APP"
"$APP/Contents/MacOS/ClaudeMemMessages" --verify-bundle
if [[ "$(uname -m)" == arm64 ]]; then native=arm64; else native=x64; fi
bun scripts/smoke-observer.ts "$APP/Contents/Helpers/imessage-observer-$native"

(cd build && ditto -c -k --keepParent "Claude-Mem Messages.app" Claude-Mem-Messages.zip)
echo "Built $APP ($VERSION)"
