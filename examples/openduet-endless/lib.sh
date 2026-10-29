# Shared settings for the OpenDuet + Endless Mode scripts. Sourced, not run.
# Every value can be overridden from the environment before running a script.

OD_KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CM_REPO=$(cd "$OD_KIT_DIR/../.." && pwd)

OD_HOME=${OPENDUET_ENDLESS_HOME:-$HOME/openduet-endless}
OD_REPO=$OD_HOME/OpenDuet
# The OpenDuet commit the patch was written and tested against.
OD_COMMIT=${OPENDUET_COMMIT:-677e0fc}

# claude-mem runs from this checkout with its own data folder, so your main claude-mem install and its database
# are never touched.
CM_DATA=$OD_HOME/claude-mem-data
CM_HOME=$OD_HOME/claude-mem-home
OD_LOGS=$OD_HOME/logs
OD_PIDS=$OD_HOME/pids
# The folder OpenDuet's memories are filed under. New conversations get this folder's memory back.
MEMORY_FOLDER=${OPENDUET_ENDLESS_MEMORY_FOLDER:-$OD_HOME/memory}

WORKER_PORT=${OPENDUET_ENDLESS_WORKER_PORT:-37877}
GATEWAY_PORT=${OPENDUET_ENDLESS_GATEWAY_PORT:-37878}

# OpenDuet's chats. "local" keeps them in one file on this computer (local-chats/), with no CopilotKit sign-in;
# "cloud" keeps them in CopilotKit Intelligence, OpenDuet's default, which needs a CopilotKit sign-in.
CHATS=${OPENDUET_ENDLESS_CHATS:-local}
CHATS_PORT=${OPENDUET_ENDLESS_CHATS_PORT:-37879}
CHATS_DB=${OPENDUET_ENDLESS_CHATS_DB:-$OD_HOME/chats/chats.db}
ROUTE=openduet
UPSTREAM=${OPENDUET_ENDLESS_UPSTREAM:-https://openrouter.ai/api/v1}
# DeepSeek's newest model on OpenRouter when this was written (Oct 29, 2026). Used by OpenDuet and by claude-mem's
# observer alike.
MODEL=${OPENDUET_ENDLESS_MODEL:-deepseek/deepseek-v4.1-flash-1017}

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Set KEY=VALUE in an env file, replacing an existing line for KEY (commented-out lines are left alone).
upsert_env() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {if(!done){print k"="v; done=1}; next} {print} END{if(!done) print k"="v}' "$file" > "$tmp"
  cat "$tmp" > "$file" && rm -f "$tmp"
}

# One value from OpenDuet's .env, quotes removed. Never printed by these scripts.
read_od_env() {
  local line
  line=$(grep -E "^$1=" "$OD_REPO/.env" 2>/dev/null | tail -n 1)
  line=${line#"$1="}
  line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

# The OpenRouter key (OPENAI_API_KEY).
read_openrouter_key() { read_od_env OPENAI_API_KEY; }

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

gateway() {
  CLAUDE_MEM_DATA_DIR=$CM_DATA HOME=$CM_HOME DO_NOT_TRACK=1 PATH=$OD_HOME/bin:$PATH \
    bun "$CM_REPO/src/services/wire-gateway/WireGatewayService.ts" "$@"
}
