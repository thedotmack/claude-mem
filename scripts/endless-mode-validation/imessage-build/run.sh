#!/usr/bin/env bash
# One command: DeepSeek builds the Photon iMessage agent spec three ways (plain Claude Code, regular claude-mem,
# Endless Mode), six fresh sessions each, side by side; then every build is scored against the spec's checks.
#
# Usage: run.sh [out dir] [run.py options...]
#   out dir defaults to ~/cmem-imessage-build/<date-time>. Score again later with score.py --out <out dir>.
# Needs: macOS, Claude Code, bun, jq, python3, node/npx, and an OpenRouter key: OPENROUTER_API_KEY, or else
# CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json (read here, never printed or written anywhere).
# Optional, for the release steps on GitHub: TEST_GH_REPO_PREFIX=<owner>/<name> (repos <prefix>-plain, -claudemem,
# -endless, which you create, private and throwaway) and TEST_GH_TOKEN (a fine-grained token for those repos only).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../../.." && pwd)
out=${1:-$HOME/cmem-imessage-build/$(date +%Y%m%d-%H%M)}; shift || true

if [[ -z ${OPENROUTER_API_KEY:-} && -f $HOME/.claude-mem/settings.json ]]; then
  OPENROUTER_API_KEY=$(jq -r '.CLAUDE_MEM_OPENROUTER_API_KEY // empty' "$HOME/.claude-mem/settings.json")
fi
[[ ${OPENROUTER_API_KEY:-} == sk-or-* ]] || { echo "no OpenRouter key (sk-or-...): set OPENROUTER_API_KEY" >&2; exit 2; }
export OPENROUTER_API_KEY

git -C "$repo" fetch -q origin feat/wire-gateway
(cd "$repo" && bun install --silent)
python3 "$here/run.py" --out "$out" --base-ref origin/feat/wire-gateway "$@"
python3 "$here/score.py" --out "$out"
echo "scorecard: $out/scorecard.md"
