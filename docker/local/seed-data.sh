#!/usr/bin/env bash

# Seed the claude-mem-local Docker volume from the host's live ~/.claude-mem.
#
# Copies the SQLite database (via `sqlite3 .backup`, safe against a live WAL
# writer), the Chroma vector store, and runtime config into the
# `claude-mem-local-data` named volume. Refuses to overwrite an existing
# seeded volume unless --force is passed, and refuses to run while the
# claude-mem-local container is up (no writing under a live DB).
#
# Usage: docker/local/seed-data.sh [--force]

set -euo pipefail

VOLUME_NAME="claude-mem-local-data"
CONTAINER_NAME="claude-mem-local"
HOST_DATA_DIR="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"
FORCE="${1:-}"

if [[ ! -f "$HOST_DATA_DIR/claude-mem.db" ]]; then
  echo "ERROR: $HOST_DATA_DIR/claude-mem.db not found" >&2
  exit 1
fi

if [[ -n "$(docker ps -q -f "name=^${CONTAINER_NAME}$")" ]]; then
  echo "ERROR: container $CONTAINER_NAME is running — stop it first (scripts/claude-mem-docker.sh off)" >&2
  exit 1
fi

docker volume create "$VOLUME_NAME" >/dev/null

ALREADY_SEEDED=$(docker run --rm -v "$VOLUME_NAME":/data/claude-mem alpine \
  sh -c 'test -f /data/claude-mem/claude-mem.db && echo yes || echo no')
if [[ "$ALREADY_SEEDED" == "yes" && "$FORCE" != "--force" ]]; then
  echo "ERROR: volume $VOLUME_NAME already contains a database. Re-run with --force to overwrite it." >&2
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "==> Backing up SQLite database ($(du -sh "$HOST_DATA_DIR/claude-mem.db" | cut -f1)) — safe against live writers..."
sqlite3 "$HOST_DATA_DIR/claude-mem.db" ".backup '$STAGE/claude-mem.db'"

echo "==> Copying Chroma vector store..."
if [[ -d "$HOST_DATA_DIR/chroma" ]]; then
  cp -R "$HOST_DATA_DIR/chroma" "$STAGE/chroma"
fi

echo "==> Copying runtime config..."
for item in settings.json modes observer-config pro.json secrets export-salt chroma-sync-state.json cloud-config.json cloud-sync-state.json; do
  if [[ -e "$HOST_DATA_DIR/$item" ]]; then
    cp -R "$HOST_DATA_DIR/$item" "$STAGE/$item"
  fi
done

# Patch the copied settings for life inside the container: container-local
# data dir, bind on all interfaces, and never external mode (the container IS
# the worker). Env vars set in compose override these anyway — this keeps the
# on-disk copy from contradicting them.
node -e '
const fs = require("fs");
const p = process.argv[1] + "/settings.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.CLAUDE_MEM_DATA_DIR = "/data/claude-mem";
s.CLAUDE_MEM_WORKER_HOST = "0.0.0.0";
s.CLAUDE_MEM_WORKER_PORT = "37777";
s.CLAUDE_MEM_EXTERNAL_WORKER = "false";
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
' "$STAGE"

echo "==> Streaming $(du -sh "$STAGE" | cut -f1) into volume $VOLUME_NAME..."
COPYFILE_DISABLE=1 tar cf - -C "$STAGE" . | docker run --rm -i -v "$VOLUME_NAME":/data/claude-mem alpine \
  sh -c 'rm -rf /data/claude-mem/* && tar xf - -C /data/claude-mem && chown -R 1000:1000 /data/claude-mem'

echo "==> Done. Volume contents:"
docker run --rm -v "$VOLUME_NAME":/data/claude-mem alpine ls -la /data/claude-mem
