#!/usr/bin/env zsh
# Remove what a stack installed (packages, browsers, toolchains, package caches) and keep what it measured.
# Usage: prune-installs.sh <stack-dir>...
#
# Each stack has its own HOME, so every installer in it starts from nothing: the `release` installer's plugin and
# Python environment, Hermes's own Node, Python and uv, the agent project's node_modules, Playwright's browsers. That is
# 1 to 7 GB per run, and it is all reinstallable. Results are never touched: data/ (the worker's database), tee-*/
# (the captured traffic), logs/, snapshots/, session transcripts, and Library/Caches (the Claude CLI keeps its MCP logs
# there). A pruned stack cannot be continued: its agent and plugin are gone (run.sh refuses to continue one).
set -e
(( $# )) || { echo "usage: prune-installs.sh <stack-dir>..." >&2; exit 2; }
for stack in "$@"; do
  [[ -d $stack ]] || { echo "prune-installs: no such stack: $stack" >&2; exit 1; }
  # -prune: delete the outermost match only, never descend into what is about to go.
  dirs=("${(@f)$(find $stack -type d \( -name node_modules -o -name site-packages -o -name .venv -o -name venv \
    -o -name __pycache__ -o -name .cache -o -name .npm -o -name ms-playwright -o -name 'chromium-[0-9]*' \
    -o \( -path '*/hermes-home/tools/*' \( -name 'node-[0-9]*' -o -name 'python-[0-9]*' -o -name 'uv-[0-9]*' -o -name 'npm-[0-9]*' \) \) \) \
    -prune -print)}")
  dirs=(${dirs:#})
  (( ${#dirs} )) || { echo "prune-installs: $stack: nothing installed"; continue; }
  kb=$(du -sk $dirs | awk '{s += $1} END {print s}')
  rm -rf $dirs
  echo "prune-installs: $stack: removed ${#dirs} folders, $(( kb / 1024 )) MB"
done
