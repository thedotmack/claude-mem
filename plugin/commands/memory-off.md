---
allowed-tools: Bash
description: Disable memory storage for claude-mem
---

Disable memory storage by running the settings CLI:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js --set enableMemoryStorage=false`

Memory storage has been disabled. Claude-mem will no longer save tool observations to the database. Context injection can still load previously saved observations if enabled.
