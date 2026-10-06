#!/usr/bin/env bash
# Scaffold for the gate-OFF case: the workspace uses the worker whose
# settings.json has CLAUDE_MEM_FILE_READ_GATE_ENABLED=false.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/scaffold-workspace.sh" off
