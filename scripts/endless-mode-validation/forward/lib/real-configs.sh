#!/usr/bin/env zsh
# Fingerprint the contributor's real agent and claude-mem configs (sha256 + mtime; never the contents), and compare
# two fingerprints. Usage: real-configs.sh snapshot <out file> | real-configs.sh compare <before> <after>
# compare exits 1 when anything changed, and names what did.
source ${0:A:h}/env.sh || exit
files=(
  $EMV_REAL_CLAUDE_DIR/settings.json
  $EMV_REAL_CLAUDE_DIR/settings.local.json
  $EMV_REAL_CLAUDE_MEM_DIR/settings.json
  $EMV_REAL_CLAUDE_MEM_DIR/transcript-watch.json
  $EMV_REAL_CLAUDE_MEM_DIR/MY-RULES.md
  $EMV_REAL_CODEX_HOME/config.toml
  $EMV_REAL_CODEX_HOME/auth.json
)
case $1 in
  snapshot)
    : > $2
    for f in $files; do
      if [[ -f $f ]]; then print -r -- "$(shasum -a 256 < $f | cut -c1-64) $(stat -f %m $f 2>/dev/null || stat -c %Y $f) $f" >> $2
      else print -r -- "absent - $f" >> $2; fi
    done
    # Nothing in a run may install a login service for claude-mem.
    for p in $EMV_REAL_HOME/Library/LaunchAgents/ai.claude-mem.*.plist(N) $EMV_REAL_HOME/.config/systemd/user/claude-mem*.service(N); do
      print -r -- "service-file $(shasum -a 256 < $p | cut -c1-64) $p" >> $2
    done
    ;;
  compare)
    if diff -u $2 $3 > /dev/null; then echo "real configs unchanged (${#files} files checked)"; exit 0; fi
    echo "REAL CONFIGS CHANGED between $2 and $3:" >&2
    diff $2 $3 | sed -n 's/^> /  now: /p; s/^< /  was: /p' >&2
    echo "(a change to $EMV_REAL_CODEX_HOME/auth.json can be your own Codex refreshing its login; the harness only reads it)" >&2
    exit 1 ;;
  *) echo "usage: real-configs.sh snapshot <file> | compare <before> <after>" >&2; exit 2 ;;
esac
