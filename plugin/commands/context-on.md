---
allowed-tools: Bash
description: Enable context injection for claude-mem
---

Enable context injection by running the settings CLI:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js --set enableContextInjection=true`

Context injection has been enabled. Claude-mem will now load context from previous sessions at session start.
