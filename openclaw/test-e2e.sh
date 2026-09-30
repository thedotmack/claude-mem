#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_NAME="openclaw-claude-mem-e2e"

echo "=== Building E2E test image ==="
echo "  Base: ghcr.io/openclaw/openclaw:main"
echo "  Plugin: @claude-mem/openclaw-plugin (PR #1012)"
echo ""

docker build -f Dockerfile.e2e -t "$IMAGE_NAME" .

if [ "${1:-}" = "--build-only" ]; then
  echo ""
  echo "Image built: $IMAGE_NAME"
  echo "Run manually with: docker run --rm $IMAGE_NAME"
  exit 0
fi

echo ""
echo "=== Running E2E verification ==="
echo ""

if [ "${1:-}" = "--interactive" ]; then
  echo "Dropping into interactive shell."
  echo ""
  echo "Useful commands inside the container:"
  echo "  node openclaw.mjs plugins list          # Verify plugin is installed"
  echo "  node openclaw.mjs plugins info claude-mem  # Plugin details"
  echo "  node openclaw.mjs plugins doctor         # Check for issues"
  echo "  node /app/mock-worker.js &               # Start mock worker"
  echo "  node openclaw.mjs gateway --allow-unconfigured --verbose  # Start gateway"
  echo "  /bin/bash /app/e2e-verify.sh             # Run automated verification"
  echo ""
  docker run --rm -it "$IMAGE_NAME" /bin/bash
else
  docker run --rm "$IMAGE_NAME"
fi
