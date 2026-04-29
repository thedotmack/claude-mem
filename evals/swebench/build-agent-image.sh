#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

npm run build

docker build \
  -f evals/swebench/Dockerfile.agent \
  -t claude-mem/swebench-agent:latest \
  .
