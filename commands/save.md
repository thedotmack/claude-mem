---
allowed-tools: Bash
description: Write an overview and save with claude-mem
---
**Write an overview** of the current conversation context and:
1. **Add it to claude-mem** using the chroma MCP tools. Always use primitive types (strings, numbers, booleans) when calling MCP Chroma tools directly. Arrays should be comma-separated strings, and nested objects should be flattened.
2. **Save the overview to index** using the claude-mem CLI tool: `claude-mem save "your overview message"`