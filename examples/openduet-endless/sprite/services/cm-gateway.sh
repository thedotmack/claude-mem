#!/usr/bin/env bash
# Sprite service: claude-mem's wire gateway, which OpenDuet's model calls go through (Endless Mode).
source "$(dirname "$0")/common.sh"
export CLAUDE_MEM_DATA_DIR="$CM_DATA" HOME="$CM_HOME" DO_NOT_TRACK=1 PATH="$OD_HOME/bin:$PATH"
exec bun "$CM_REPO/src/services/wire-gateway/WireGatewayService.ts" start --foreground
