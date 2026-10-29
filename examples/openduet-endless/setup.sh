#!/usr/bin/env bash
# One-time setup: OpenDuet (CopilotKit) talking to DeepSeek on OpenRouter through claude-mem's wire gateway, with
# Endless Mode and claude-mem memory on. Safe to run again. Writes only under $OPENDUET_ENDLESS_HOME
# (~/openduet-endless by default). Puts no key anywhere: you add your OpenRouter key yourself (see the end).
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
patch=$OD_KIT_DIR/openduet-claude-mem.patch
if git -C "$OD_REPO" apply --reverse --check "$patch" >/dev/null 2>&1; then
  say "    patch already applied"
else
  git -C "$OD_REPO" apply "$patch" || die "the patch does not apply to this OpenDuet checkout; set OPENDUET_COMMIT or start from a fresh $OD_REPO"
  say "    patch applied (full history to OpenRouter on every request, and the memory folder line)"
fi

say "3/5 OpenDuet settings"
[ -f "$OD_REPO/.env" ] || cp "$OD_REPO/.env.example" "$OD_REPO/.env"
upsert_env "$OD_REPO/.env" OPENAI_BASE_URL "http://127.0.0.1:$GATEWAY_PORT/r/$ROUTE"
upsert_env "$OD_REPO/.env" BOT_MODEL "$MODEL"
upsert_env "$OD_REPO/.env" CLAUDE_MEM_WORK_FOLDER "$MEMORY_FOLDER"
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
if ! grep -qE '^INTELLIGENCE_API_KEY=.+' "$OD_REPO/.env"; then
  say "  - Sign in to CopilotKit (free) once, from $OD_REPO:"
  say "      npx --yes copilotkit@latest login"
  say "      npx --yes copilotkit@latest project select"
  say "      bun openbot/scripts/setup-learning.ts"
fi
say "  - Start everything: $OD_KIT_DIR/start.sh"
