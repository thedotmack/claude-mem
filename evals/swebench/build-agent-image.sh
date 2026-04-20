#!/usr/bin/env bash
# Build the claude-mem SWE-bench agent image.
# Plan: .claude/plans/swebench-claude-mem-docker.md (Phase 1, step 2)
set -euo pipefail

# Resolve repo root (two levels up from this script: evals/swebench -> repo).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# 1. Build the plugin so plugin/ is populated for the COPY step in the Dockerfile.
npm run build

# 2. Build the agent image. Context is the repo root so both plugin/ and
#    evals/swebench/run-instance.sh are reachable.
docker build \
  -f evals/swebench/Dockerfile.agent \
  -t claude-mem/swebench-agent:latest \
  .
