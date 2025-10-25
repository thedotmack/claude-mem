---
allowed-tools: Bash
description: Disable context injection for claude-mem
---

Disable context injection by running the settings CLI:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js --set enableContextInjection=false`

Context injection has been disabled. Claude-mem will no longer load context from previous sessions, but will continue saving observations if memory storage is enabled.
