#!/usr/bin/env bash
# Run the three-way iMessage build test on Fly Sprites instead of this Mac: one Sprite per build (plain, claudemem,
# endless), so the three never share a machine. Each Sprite clones this kit, builds its one arm with DeepSeek through
# OpenRouter, scores it, and keeps the results until you fetch them.
#
# Usage (from your Mac, with the Sprites CLI installed and `sprite login` done):
#   sprites.sh start     make the three Sprites and start the builds (returns once all three are running)
#   sprites.sh status    one line per build: building, scoring, done or failed, and the latest log line
#   sprites.sh fetch     copy the results home and write the combined scorecard
#   sprites.sh destroy   delete the three Sprites (asks first; fetch before this, the builds go with them)
#
# The OpenRouter key comes from OPENROUTER_API_KEY, or else CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json.
# It goes to each Sprite over the CLI's stdin into a file only the Sprite's user can read; it is never printed.
# Safety on the Sprites: each is a fresh Linux box with none of your logins on it (no GitHub, npm, Claude or Apple ID).
# The builder runs under bubblewrap (filesystem read-only except its run dir), probes check that no GitHub or npm
# login is reachable before anything runs, and test packages go to a local registry on the Sprite. Linux has no
# Messages, so no text can go out from a real Apple ID. The note-taker (newest Haiku) goes through OpenRouter too,
# since the Sprites have no Claude login; it is still recorded and counted in the bill.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ARMS=(plain claudemem endless)
BRANCH=${EMV_KIT_BRANCH:-test/imessage-agent-build-kit}
base=$HOME/cmem-imessage-build/sprites
action=${1:-}

command -v sprite > /dev/null || {
  echo "The Sprites CLI isn't installed. Install it with:  curl https://sprites.dev/install.sh | bash   then: sprite login" >&2
  exit 2
}
name() { echo "cmem-imsg-$1"; }
# Run a command on one Sprite. `sprite use` picks the Sprite, so calls run one at a time.
on() { local s; s=$(name "$1"); shift; sprite use "$s" > /dev/null && sprite exec "$@"; }

case $action in
start)
  key=${OPENROUTER_API_KEY:-}
  [[ -z $key && -f $HOME/.claude-mem/settings.json ]] && key=$(jq -r '.CLAUDE_MEM_OPENROUTER_API_KEY // empty' "$HOME/.claude-mem/settings.json")
  [[ $key == sk-or-* ]] || { echo "no OpenRouter key (sk-or-...): set OPENROUTER_API_KEY" >&2; exit 2; }
  sprite exec --help 2>&1 | grep -q detachable || {
    echo "this Sprites CLI has no detachable sessions (sprite exec -detachable); update it: curl https://sprites.dev/install.sh | bash" >&2
    exit 2
  }
  mkdir -p "$base"
  for arm in "${ARMS[@]}"; do
    s=$(name "$arm")
    echo "== $arm: making Sprite $s"
    sprite create "$s"
    printf '%s' "$key" | on "$arm" -- bash -c 'umask 077; mkdir -p ~/.emv; cat > ~/.emv/openrouter-key'
    on "$arm" -- bash -s -- "$BRANCH" < "$here/sprite-setup.sh"
    # A detachable session keeps the Sprite awake and the job running after this script disconnects.
    on "$arm" -detachable "bash ~/claude-mem/scripts/endless-mode-validation/imessage-build/sprite-job.sh $arm" \
      < /dev/null > "$base/$arm-attach.log" 2>&1 &
    attach=$!
    for _ in $(seq 1 30); do
      sleep 2
      state=$(on "$arm" -- bash -c 'cat ~/.emv/state' 2> /dev/null || true)
      [[ -n $state ]] && break
    done
    kill "$attach" 2> /dev/null || true
    [[ -n $state ]] || { echo "$arm: the job did not start; see $base/$arm-attach.log" >&2; exit 1; }
    echo "$arm: $state"
  done
  echo "All three are building. Check with: $0 status"
  ;;
status)
  for arm in "${ARMS[@]}"; do
    line=$(on "$arm" -- bash -c 'printf "%s | " "$(cat ~/.emv/state 2>/dev/null || echo unknown)"; tail -n 1 ~/.emv/job.log 2>/dev/null' 2>&1 || true)
    echo "$arm: $line"
  done
  ;;
fetch)
  merged=$base/results-$(date +%Y%m%d-%H%M)
  mkdir -p "$merged"
  for arm in "${ARMS[@]}"; do
    echo "== $arm: copying results"
    on "$arm" -- bash -c 'tar czf - --exclude=node_modules --exclude=.bun --exclude=.npm --exclude=registry/storage \
      -C ~/cmem-imessage-build run' > "$merged/$arm.tgz"
    mkdir -p "$merged/raw-$arm" && tar xzf "$merged/$arm.tgz" -C "$merged/raw-$arm"
    cp -R "$merged/raw-$arm/run/$arm" "$merged/$arm"
    cp "$merged/raw-$arm/run/results.sqlite" "$merged/$arm/results.sqlite"
  done
  python3 "$here/score.py" --out "$merged" --report-only
  echo "scorecard: $merged/scorecard.md"
  ;;
destroy)
  read -r -p "Delete the Sprites ${ARMS[*]/#/cmem-imsg-} and everything on them? Type yes: " ok
  [[ $ok == yes ]] || { echo "nothing deleted"; exit 0; }
  for arm in "${ARMS[@]}"; do sprite destroy -s "$(name "$arm")" || true; done
  ;;
*)
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
