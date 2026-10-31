#!/usr/bin/env bash
# Sprite service: OpenDuet's local chat store.
source "$(dirname "$0")/common.sh"
# Exported rather than passed on the command line, so it never shows in the process list.
export LOCAL_CHATS_API_KEY="$(read_od_env INTELLIGENCE_API_KEY)" LOCAL_CHATS_DB="$CHATS_DB" LOCAL_CHATS_PORT="$CHATS_PORT"
exec bun "$OD_KIT_DIR/local-chats/server.ts"
