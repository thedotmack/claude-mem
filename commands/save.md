---
allowed-tools: Bash
description: Write an overview and save with claude-mem
---
**Write an overview** of the current conversation context and:
1. **Add it to claude-mem** using the chroma MCP tools  
2. **IMPORTANT! Save the overview to index** using the claude-mem CLI tool: `claude-mem save "your overview message"`