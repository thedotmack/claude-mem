#!/usr/bin/env bash
# Scaffold for the large-file gate-ON case: the fixture-large project, and the
# worker whose settings.json has CLAUDE_MEM_FILE_READ_GATE_ENABLED=true.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/scaffold-workspace.sh" on fixture-large
