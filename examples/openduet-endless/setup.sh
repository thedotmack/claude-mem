#!/usr/bin/env bash
# One-time setup: OpenDuet (CopilotKit) talking to DeepSeek on OpenRouter through claude-mem's wire gateway, with
# Endless Mode and claude-mem memory on, and its chats kept on this computer. Safe to run again. Writes only under
# $OPENDUET_ENDLESS_HOME (~/openduet-endless by default). Puts no key of yours anywhere: you add your OpenRouter key
# yourself (see the end). OPENDUET_ENDLESS_CHATS=cloud keeps chats in CopilotKit's cloud instead.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

for tool in git bun node npx docker jq curl lsof python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (OpenDuet needs Docker, Bun 1.3+ and Node; the scripts need jq, curl, lsof and python3)"
done

mkdir -p "$OD_HOME" "$CM_DATA" "$CM_HOME/.claude-mem" "$OD_LOGS" "$OD_HOME/bin" "$MEMORY_FOLDER"

say "1/5 claude-mem from this checkout ($(git -C "$CM_REPO" rev-parse --abbrev-ref HEAD))"
[ -d "$CM_REPO/node_modules" ] || (cd "$CM_REPO" && bun install)

say "2/5 OpenDuet in $OD_REPO"
if [ ! -d "$OD_REPO/.git" ]; then
  git clone https://github.com/CopilotKit/OpenDuet.git "$OD_REPO"
  git -C "$OD_REPO" checkout -q -b claude-mem-endless "$OD_COMMIT"
fi
apply_patch() { # file, what it does
  if git -C "$OD_REPO" apply --reverse --check "$OD_KIT_DIR/$1" >/dev/null 2>&1; then
    say "    $1 already applied"
  else
    git -C "$OD_REPO" apply "$OD_KIT_DIR/$1" || die "$1 does not apply to this OpenDuet checkout; set OPENDUET_COMMIT or start from a fresh $OD_REPO"
    say "    $1 applied ($2)"
  fi
}
apply_patch openduet-claude-mem.patch "full history to OpenRouter on every request, and the memory folder line"
apply_patch openduet-local-chats.patch "start.sh accepts the local chat store"
apply_patch openduet-client-ws.patch "the browser can join chat sockets at another address (sprite/)"
# Only with local chats, where there is no CopilotKit licence by design; a licensed cloud setup keeps its warnings.
banner=openduet-no-license-banner.patch
if [ "$CHATS" = local ]; then
  apply_patch "$banner" "no CopilotKit licence bar over the app"
elif git -C "$OD_REPO" apply --reverse --check "$OD_KIT_DIR/$banner" >/dev/null 2>&1; then
  git -C "$OD_REPO" apply --reverse "$OD_KIT_DIR/$banner" && say "    $banner taken back out (chats in CopilotKit's cloud)"
fi

say "3/5 OpenDuet settings"
[ -f "$OD_REPO/.env" ] || cp "$OD_REPO/.env.example" "$OD_REPO/.env"
upsert_env "$OD_REPO/.env" OPENAI_BASE_URL "$GATEWAY_BASE_URL"
upsert_env "$OD_REPO/.env" BOT_MODEL "$MODEL"
upsert_env "$OD_REPO/.env" CLAUDE_MEM_WORK_FOLDER "$MEMORY_FOLDER"
local_url="http://127.0.0.1:$CHATS_PORT"
if [ "$CHATS" = local ]; then
  mkdir -p "$(dirname "$CHATS_DB")" && chmod 700 "$(dirname "$CHATS_DB")"
  current_key=$(read_od_env INTELLIGENCE_API_KEY)
  # A CopilotKit key already here is kept aside, so OPENDUET_ENDLESS_CHATS=cloud can put it back.
  if [ -n "$current_key" ] && [ "${current_key#local-}" = "$current_key" ] && [ ! -f "$OD_HOME/copilotkit-cloud.env" ]; then
    (umask 077; grep -E '^INTELLIGENCE_(API_URL|GATEWAY_WS_URL|API_KEY)=' "$OD_REPO/.env" > "$OD_HOME/copilotkit-cloud.env")
  fi
  # OpenDuet sends this to the local chat store, which checks it. It is made here and only ever used on this computer.
  [ "${current_key#local-}" != "$current_key" ] || upsert_env "$OD_REPO/.env" INTELLIGENCE_API_KEY "local-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  upsert_env "$OD_REPO/.env" INTELLIGENCE_API_URL "$local_url"
  upsert_env "$OD_REPO/.env" INTELLIGENCE_GATEWAY_WS_URL "ws://127.0.0.1:$CHATS_PORT"
  upsert_env "$OD_REPO/.env" OPENDUET_LOCAL_CHATS true
  # Both ask CopilotKit's cloud for things the local store does not have.
  upsert_env "$OD_REPO/.env" OPENBOT_LEARNING_AUTO_ASSIGN false
  upsert_env "$OD_REPO/.env" OPENBOT_SELF_HOST_BANNER false
  say "    chats: kept on this computer in $CHATS_DB"
else
  upsert_env "$OD_REPO/.env" OPENDUET_LOCAL_CHATS false
  if [ "$(read_od_env INTELLIGENCE_API_URL)" = "$local_url" ]; then
    upsert_env "$OD_REPO/.env" INTELLIGENCE_API_URL https://api.intelligence.copilotkit.ai
    upsert_env "$OD_REPO/.env" INTELLIGENCE_GATEWAY_WS_URL wss://realtime.intelligence.copilotkit.ai
    upsert_env "$OD_REPO/.env" INTELLIGENCE_API_KEY ""
    if [ -f "$OD_HOME/copilotkit-cloud.env" ]; then
      while IFS='=' read -r name value; do upsert_env "$OD_REPO/.env" "$name" "$value"; done < "$OD_HOME/copilotkit-cloud.env"
    fi
  fi
  say "    chats: kept in CopilotKit's cloud"
fi
(cd "$OD_REPO" && bun install)

say "4/5 claude-mem settings in $CM_DATA"
jq -n --arg wp "$WORKER_PORT" --arg gp "$GATEWAY_PORT" --arg m "$MODEL" '{
  CLAUDE_MEM_WORKER_PORT: $wp, CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
  CLAUDE_MEM_WIRE_GATEWAY_PORT: $gp, CLAUDE_MEM_WIRE_GATEWAY_HOST: "127.0.0.1",
  CLAUDE_MEM_WIRE_GATEWAY_AUTOSTART: "false",
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: "true",
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: "timeline",
  CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: "true",
  CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER: "true",
  CLAUDE_MEM_PROVIDER: "openrouter",
  CLAUDE_MEM_OPENROUTER_MODEL: $m,
  CLAUDE_MEM_OPENROUTER_BASE_URL: "",
  CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: "off",
  CLAUDE_MEM_CHROMA_ENABLED: "false",
  CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
  CLAUDE_MEM_TELEGRAM_ENABLED: "false",
  CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "false",
  CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: "false",
  CLAUDE_MEM_CLOUD_SYNC_WS: "false"
}' > "$CM_DATA/settings.json"
cp "$CM_DATA/settings.json" "$CM_HOME/.claude-mem/settings.json"
# Nothing started from here may install a login service on your Mac.
for svc in launchctl systemctl; do
  printf '#!/bin/sh\nexit 0\n' > "$OD_HOME/bin/$svc"; chmod +x "$OD_HOME/bin/$svc"
done

say "5/5 done"
key=$(read_openrouter_key)
say ""
say "Left for you:"
if [ -z "$key" ]; then
  say "  - Put your OpenRouter key in $OD_REPO/.env as OPENAI_API_KEY=sk-or-..."
  say "    (a new key just for this makes its spend easy to see on OpenRouter's Activity page)"
fi
if [ "$CHATS" != local ] && ! grep -qE '^INTELLIGENCE_API_KEY=.+' "$OD_REPO/.env"; then
  say "  - Sign in to CopilotKit (free) once, from $OD_REPO:"
  say "      npx --yes copilotkit@latest login"
  say "      npx --yes copilotkit@latest project select"
  say "      bun openbot/scripts/setup-learning.ts"
fi
say "  - Start everything: $OD_KIT_DIR/start.sh"
