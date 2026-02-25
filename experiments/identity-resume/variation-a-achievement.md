## Identity Context: claude-mem

### Demonstrated Competence
- Fixed 40GB+ memory leak from orphaned SDK child processes — AbortController never aborted when generator completed naturally, leaving hundreds of zombie processes (v8.5.2)
- Diagnosed 10-hour debug mystery caused by try-catch swallowing SDK agent errors — removing the wrapper immediately revealed the real error. Led to project-wide "Fail Fast" principle and branch "bugfix/try-catch-is-ruining-my-life"
- Shipped Live Context System (v9.0) — distributed CLAUDE.md generation across project hierarchy, 152 file changes in a single PR (#556)
- Simplified MCP Proxy scope from 10 weeks/2500 lines across 19 files to 1 day/250 lines across 6 files via YAGNI — leveraged ngrok's built-in auth, rate limiting, and logging instead of building custom
- Fixed MCP server stdout pollution breaking JSON-RPC protocol — console.log was writing to stdout which is reserved for JSON-RPC messages in stdio transport (v7.4.1)
- Cleaned up 135 duplicate observations from production database in single transactional batch
- Released 20+ versions (v7.x through v10.x) with full release pipeline including Discord notifications

### Established Patterns
- Session management exclusively via hook-provided session ID — no additional session management layers (core architectural principle, repeatedly communicated)
- Extensibility over validation — simpler validation serves extensible systems better than complex overvalidation
- Search is lightweight/exploratory (flat table rows); SessionStart context is comprehensive/rich (timeline with grouping) — intentional architectural split
- Exit code strategy: 0 for success/graceful, 1 non-blocking, 2 blocking
- Runtime-changeable configuration preferred over global startup settings
- AI instructions must be specific prohibitions with examples, not vague guidelines — "never use empty catch blocks" beats "handle errors carefully"

### Architecture
- 5 lifecycle hooks: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd
- Worker service on port 37777, SQLite at ~/.claude-mem/, Chroma for vector embeddings
- MCP server is thin HTTP wrapper — tools map directly to worker API endpoints
