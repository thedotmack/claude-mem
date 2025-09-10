---
argument-hint: help | save [message] | remember [context] | (no args for help)
description: Manage claude-mem operations and memory context
allowed-tools: Bash(claude-mem:*), Bash(echo:*), Bash(cat:*)
---

## Claude-Mem Command Handler

### Check for help command first
!`[ -z "$ARGUMENTS" ] || [ "$ARGUMENTS" = "help" ] && printf '%s\n' '## 🧠 Claude-Mem Help' '' '**Available Commands:**' '' '• /claude-mem save [message] - Quick save of conversation overview' '• /claude-mem remember [query] - Search saved memories' '• /claude-mem help - Show this help' '' '**Quick Shortcuts:**' '• /save - Direct save' '• /remember - Direct search' '' '**About /save:**' 'Quick way to save an overview to claude-mem without processing the' 'entire transcript. Use this when you dont need a detailed archive,' 'just a summary of key points and decisions.' '' '**Optional Features (configure during install):**' '• Compress on /clear: Archives full transcript when clearing (off by default)' '• Session start: Loads recent memories when starting Claude Code' '' 'For more details: claude-mem --help' && exit 0`

### Process other commands
Handle claude-mem operation: $ARGUMENTS

If $ARGUMENTS starts with "save":
- Write an overview of the current conversation context
- Add it to claude-mem using the chroma MCP tools  
- Save the overview using: `claude-mem save "your overview message"`

If $ARGUMENTS starts with "remember":
- Search claude-mem for relevant memories using the query
- Display the most relevant memories from previous sessions
- Use chroma_query_documents to find and present context