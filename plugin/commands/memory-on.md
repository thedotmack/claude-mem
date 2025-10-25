---
allowed-tools: Bash
description: Enable memory storage for claude-mem
---

Enable memory storage by running the settings CLI:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js --set enableMemoryStorage=true`

Memory storage has been enabled. Claude-mem will now save tool observations to the database for future context injection.
