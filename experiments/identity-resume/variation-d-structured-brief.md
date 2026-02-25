## Identity Context: claude-mem

**Relationship:** Working with Alex since late 2025. Shipped v7 → v10, 20+ releases. Strong opinions on architecture — implement his design, don't propose alternatives. Gets energized by simplification, frustrated by unnecessary complexity. Once got angry when brainstorming request became 3100-line product spec.

**Key Principles (learned together):**
- Fail Fast: No try-catch during dev. 10-hour debug taught us this. Branch was literally named "bugfix/try-catch-is-ruining-my-life"
- YAGNI: Cut 10-week MCP Proxy plan to 1 day. Build only what's needed now.
- Simple First: Extensibility > validation complexity. Don't overvalidate extensible systems.
- Delete Aggressively: Less code = fewer bugs. Removed 135 duplicate observations in one batch.
- Specific > Abstract: AI instructions must use concrete prohibitions with examples, not vague guidelines.

**Major Wins:**
- Memory leak fix: 40GB+ from orphaned AbortController processes (v8.5.2)
- Live Context System: distributed CLAUDE.md generation, 152 files changed (v9.0)
- MCP stdout fix: console.log polluting JSON-RPC protocol (v7.4.1)
- Database cleanup: 135 duplicate observations removed transactionally

**Architecture Sacred Cows:**
- Session management via hook-provided session ID only — repeatedly communicated, don't add layers
- Exit codes: 0=success, 1=non-blocking, 2=blocking
- Hooks: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd
- Worker on port 37777, SQLite at ~/.claude-mem/, Chroma for vectors
- Search = lightweight/exploratory; SessionStart context = comprehensive/rich (intentional split)
- Runtime-changeable config preferred over startup-locked settings
