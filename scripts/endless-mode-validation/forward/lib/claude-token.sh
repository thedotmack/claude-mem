# Source me (zsh): `emv_read_claude_token` puts Claude Code's current claude.ai access token into
# EMV_CLAUDE_TOKEN. Never printed, never written.
#
# Order:
#   1. EMV_CLAUDE_OAUTH_TOKEN, if you set it (e.g. a long-lived token from `claude setup-token`; it does not rotate,
#      which makes long runs simpler);
#   2. macOS: the login keychain entry "Claude Code-credentials" (read only: `security find-generic-password -w`;
#      the keychain path is given explicitly because HOME is sandboxed);
#   3. otherwise: <your Claude config dir>/.credentials.json (read only).
# Claude Code rotates the claude.ai access token when it refreshes it and revokes the old one, so long runs read it
# again before every turn (agent-turn.sh), on a 401 (tee-proxy.ts --refresh-claude-token) and for the observers
# (token-watch.sh).
emv_read_claude_token() {
  # EMV_HOST_AUTH=1: the host adds the credentials itself (e.g. a cloud sandbox's egress proxy), so no token is read
  # and none is passed; the agents and observers start with none.
  if [[ $EMV_HOST_AUTH == 1 ]]; then typeset -g EMV_CLAUDE_TOKEN=''; return 0; fi
  if [[ -n $EMV_CLAUDE_OAUTH_TOKEN ]]; then typeset -g EMV_CLAUDE_TOKEN=$EMV_CLAUDE_OAUTH_TOKEN; return 0; fi
  local json=''
  if [[ $(uname) == Darwin ]]; then
    json=$(security find-generic-password -s "Claude Code-credentials" -a "$EMV_REAL_USER" -w \
      "$EMV_REAL_HOME/Library/Keychains/login.keychain-db" 2>/dev/null)
  fi
  [[ -z $json && -f $EMV_REAL_CLAUDE_DIR/.credentials.json ]] && json=$(<"$EMV_REAL_CLAUDE_DIR/.credentials.json")
  typeset -g EMV_CLAUDE_TOKEN=$(print -r -- "$json" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
  [[ -n $EMV_CLAUDE_TOKEN ]] || { echo "claude-token: no claude.ai login found (log in with \`claude\`, or set EMV_CLAUDE_OAUTH_TOKEN)" >&2; return 3; }
}
