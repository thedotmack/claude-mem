#!/usr/bin/env bash
# Run any `claude-mem wire` command against this kit's gateway, e.g. ./gateway.sh routes list
set -euo pipefail
source "$(dirname "$0")/lib.sh"
gateway "$@"
