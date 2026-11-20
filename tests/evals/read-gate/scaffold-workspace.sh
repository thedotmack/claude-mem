#!/usr/bin/env bash
# Scaffold shared by every read-gate case; the scaffold-*gate-on.sh and
# scaffold-*gate-off.sh scripts call it with their arm and, for the large-file
# cases, the fixture-large project. scripts/eval-read-gate.ts starts
# one worker per arm and runs the suite with --scaffold. The harness runs this
# with the run's empty workspace as cwd and the run's temporary home as HOME.
# 1. Copies the fixture project into the workspace and dates every file
#    2026-01-01, older than the seeded observations: the gate skips a file
#    modified after its newest observation.
# 2. Links this run's ~/.claude-mem to the arm's data directory. Hooks, the MCP
#    server and the arm's worker then share one data dir, as in a real install,
#    and nothing reaches a worker on the default port.
set -euo pipefail
arm="${1:-}"
fixture="${2:-fixture}"
case "$arm/$fixture" in
  on/fixture|off/fixture|on/fixture-large|off/fixture-large) ;;
  *) echo "usage: scaffold-workspace.sh on|off [fixture|fixture-large]" >&2; exit 1 ;;
esac
suite_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$suite_dir/../.." && pwd)"
data_dir_file="$repo_root/.scratch/read-gate-eval/active-data-dir-$arm"
if [ ! -f "$data_dir_file" ]; then
  echo "No read-gate eval is running ($data_dir_file is missing). Run: npm run eval:read-gate" >&2
  exit 1
fi
if [ -e "$HOME/.claude-mem" ] || [ -L "$HOME/.claude-mem" ]; then
  echo "$HOME/.claude-mem already exists; refusing to replace it" >&2
  exit 1
fi

cp -R "$suite_dir/$fixture/." .
find . -type f -exec touch -t 202601010000 {} +
ln -s "$(cat "$data_dir_file")" "$HOME/.claude-mem"
