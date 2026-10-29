#!/usr/bin/env bash
# Is OpenDuet's traffic going through the gateway, and what has Endless Mode saved so far.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
gateway routes list
gateway status --endless
