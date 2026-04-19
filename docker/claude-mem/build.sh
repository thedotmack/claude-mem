#!/usr/bin/env bash
# Build the basic claude-mem Docker image from the current worktree.
#
# Usage:
#   docker/claude-mem/build.sh               # builds claude-mem:basic
#   TAG=my-tag docker/claude-mem/build.sh    # override the tag
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-claude-mem:basic}"

cd "$REPO_ROOT"

echo "[build] npm run build"
npm run build

echo "[build] docker build -t $TAG"
docker build \
  -f docker/claude-mem/Dockerfile \
  -t "$TAG" \
  "$REPO_ROOT"

echo "[build] done: $TAG"
