#!/usr/bin/env bash
# Run OpenDuet with Endless Mode on a Fly Sprite, reached at the Sprite's own address behind the Sprite's sign-in.
# Run ../setup.sh and add your OpenRouter key first. Safe to run again. Needs Docker and Caddy on the Sprite.
#
# What it does, on top of ../setup.sh:
#   - OpenDuet's Docker services get the Sprite fixes (docker-compose.override.yml, openduet-sprite.patch).
#   - OpenDuet's server serves the built app itself, and the browser joins chat sockets at the Sprite's address.
#   - claude-mem's worker stays up when idle (a service, not a process started by a hook).
#   - Each part runs as its own Sprite service, so the Sprite starts them again after it sleeps.
#   - Caddy is the one door the Sprite's address opens (port 8080).
set -euo pipefail
source "$(dirname "$0")/services/common.sh"
SPRITE_KIT=$OD_KIT_DIR/sprite

for tool in sprite-env docker caddy jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed on this Sprite"
done
[ -f "$CM_DATA/settings.json" ] && [ -f "$OD_REPO/.env" ] || die "run ../setup.sh first"
[ -n "$(read_openrouter_key)" ] || die "no OpenRouter key: put it in $OD_REPO/.env as OPENAI_API_KEY=sk-or-..."

SPRITE_ORIGIN=${OPENDUET_SPRITE_URL:-$(sprite-env info | jq -r '.sprite_url // empty')}
SPRITE_ORIGIN=${SPRITE_ORIGIN%/}
[ -n "$SPRITE_ORIGIN" ] || die "could not read this Sprite's address; set OPENDUET_SPRITE_URL=https://<name>.sprites.app"
say "Sprite address: $SPRITE_ORIGIN"

say "1/4 OpenDuet's Docker services"
if git -C "$OD_REPO" apply --reverse --check "$SPRITE_KIT/openduet-sprite.patch" >/dev/null 2>&1; then
  say "    openduet-sprite.patch already applied"
else
  git -C "$OD_REPO" apply "$SPRITE_KIT/openduet-sprite.patch" || die "openduet-sprite.patch does not apply to this OpenDuet checkout"
  say "    openduet-sprite.patch applied (a Bot's computer can start with no process limit)"
fi
cp "$SPRITE_KIT/docker-compose.override.yml" "$OD_REPO/openbot/docker-compose.override.yml"
grep -qxF 'openbot/docker-compose.override.yml' "$OD_REPO/.git/info/exclude" 2>/dev/null ||
  echo 'openbot/docker-compose.override.yml' >> "$OD_REPO/.git/info/exclude"

say "2/4 OpenDuet's app, served by its own server"
(cd "$OD_REPO/openbot/app" && bun run build) > "$OD_LOGS/app-build.log" 2>&1 || die "the app did not build; log in $OD_LOGS/app-build.log"
upsert_env "$OD_REPO/.env" APP_DIST_DIR "$OD_REPO/openbot/app/dist"
upsert_env "$OD_REPO/.env" OPENDUET_CLIENT_WS_URL "wss://${SPRITE_ORIGIN#https://}/intelligence-ws/client"

say "3/4 claude-mem stays up when idle"
for file in "$CM_DATA/settings.json" "$CM_HOME/.claude-mem/settings.json"; do
  jq '.CLAUDE_MEM_IDLE_EXIT_SEC = "0"' "$file" > "$file.new" && mv "$file.new" "$file"
done

say "4/4 Sprite services"
# Any earlier copies go first, those that depend on others before what they depend on.
for name in front openduet cm-gateway cm-worker chats; do
  sprite-env services stop "$name" >/dev/null 2>&1 || true
  sprite-env services delete "$name" >/dev/null 2>&1 || true
done
service() { # name, then sprite-env create options
  local name=$1; shift
  sprite-env services create "$name" --no-stream "$@" >/dev/null || die "could not create the $name service"
  say "    $name"
}
# Docker's daemon has no service of its own on a fresh Sprite.
if ! sprite-env services get dockerd >/dev/null 2>&1; then
  service dockerd --cmd sudo --args "dockerd,--group,$(id -gn)"
fi
service chats --cmd "$SPRITE_KIT/services/chats.sh"
service cm-worker --cmd "$SPRITE_KIT/services/cm-worker.sh"
service cm-gateway --cmd "$SPRITE_KIT/services/cm-gateway.sh" --needs cm-worker
service openduet --cmd "$SPRITE_KIT/services/openduet.sh" --needs dockerd,chats,cm-gateway
service front --cmd caddy --args "run,--config,$SPRITE_KIT/Caddyfile,--adapter,caddyfile" \
  --env "SPRITE_ORIGIN=$SPRITE_ORIGIN,CHATS_PORT=$CHATS_PORT" --http-port 8080

say ""
say "OpenDuet is starting (a few minutes the first time). Then open $SPRITE_ORIGIN and sign in with your Sprites account."
say "Keep the Sprite's address private: OpenDuet's own sign-in is off, so the Sprite's sign-in is the only lock."
say "Logs: sprite-env services list, and $OD_REPO/openbot/.logs"
