#!/usr/bin/env bash
# Runs on a fresh Sprite (sprites.sh start sends it over stdin): installs what the build test needs and clones the kit.
# Usage: bash -s -- <kit branch>
set -euo pipefail
branch=$1
mkdir -p ~/.emv
# bubblewrap is the builder's sandbox; jq is used by the stack. Without sudo the run falls back to "throwaway box"
# mode (sprite-job.sh), which still runs every login probe.
if ! command -v bwrap > /dev/null || ! command -v jq > /dev/null; then
  if sudo -n true 2> /dev/null; then
    sudo -n apt-get update -qq > /dev/null && sudo -n apt-get install -y -qq bubblewrap jq > /dev/null
  fi
fi
for tool in git bun node npx python3 claude jq curl; do
  command -v "$tool" > /dev/null || { echo "missing on this Sprite: $tool" >&2; exit 1; }
done
if [[ ! -d ~/claude-mem ]]; then
  git clone -q --branch "$branch" https://github.com/thedotmack/claude-mem ~/claude-mem
fi
git -C ~/claude-mem fetch -q origin "$branch" feat/wire-gateway
git -C ~/claude-mem checkout -q "origin/$branch"
(cd ~/claude-mem && bun install --silent)
echo "setup done: $(git -C ~/claude-mem rev-parse --short HEAD), bwrap $(command -v bwrap > /dev/null && echo yes || echo no)"
