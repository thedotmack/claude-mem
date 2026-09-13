# Phase 06: Medium — Cross-Platform Fixes (Windows & macOS)

These bugs affect specific platforms — primarily Windows — and prevent claude-mem from working at all on those systems. While medium severity for the project overall, they're blocking for affected users. Each fix is targeted and low-risk.

**Issues addressed:** #1342, #1247, #1225, #1297
**Prerequisite:** Phases 01-05 should be complete.

## Tasks

- [ ] Fix CRLF line endings in mcp-server.cjs causing shebang failure (#1342). The `#!/usr/bin/env node` shebang fails on macOS/Linux when the file has Windows line endings (`\r\n`):
  - Check `plugin/scripts/mcp-server.cjs` for CRLF line endings: search for `\r` characters
  - If CRLF, convert to LF. The fix should be in the build process, not just the file:
    - Read `scripts/build-hooks.js` and any build scripts that generate `plugin/scripts/*.cjs` files
    - Add `.replace(/\r\n/g, '\n')` to the output write step, OR
    - Add a `.gitattributes` entry: `plugin/scripts/*.cjs text eol=lf` to enforce LF on checkout
  - Also check all other `.cjs` files in `plugin/scripts/` for the same issue — fix them all at once
  - Verify by reading the first line of each generated script file after build

- [ ] Fix tree-sitter CLI failure on Windows (#1247). smart-explore (smart_search/smart_outline/smart_unfold) fails silently because tree-sitter CLI requires a C compiler which most Windows users don't have:
  - Search for `tree-sitter`, `smart_search`, `smart_outline`, `smart_unfold` in the codebase to find the tree-sitter invocation
  - The fix: add a pre-flight check that verifies tree-sitter is available before attempting to use it. If unavailable, fall back gracefully:
    1. Before calling tree-sitter, try running `tree-sitter --version` (or equivalent quick check)
    2. If it fails, return a helpful error message: `tree-sitter CLI not available. On Windows, install via 'npm install -g tree-sitter-cli' or use WSL.`
    3. The MCP tools (smart_search etc.) should return this message as content, not throw
  - Do NOT attempt to auto-install tree-sitter — just provide clear guidance

- [ ] Fix Windows Chroma initialization failure (#1225). chroma-mcp reports "Received request before initialization was complete" causing all semantic searches to fail on Windows:
  - Read the Chroma initialization in `src/services/sync/ChromaMcpManager.ts` — find where the client connects and runs initial commands
  - Search for the "initialization" state tracking — the MCP client may send requests before chroma-mcp's Python process is ready
  - The fix: add a readiness poll after starting chroma-mcp. After `this.client.connect()`, call a lightweight Chroma operation (like `chroma_list_collections`) in a retry loop (max 5 attempts, 2s interval) before marking as connected
  - If readiness polling already exists, increase the timeout or retry count for Windows where Python startup is slower
  - Check if `CLAUDE_MEM_CHROMA_STARTUP_DELAY_MS` setting from Phase 02 helps here — if so, just increase the default for Windows

- [ ] Fix .env.local crash on macOS (#1297). chroma-mcp (pydantic Settings) reads `.env.local` files from the CWD, causing crashes when the project has environment variables that conflict with Chroma's settings:
  - Read `src/services/sync/ChromaMcpManager.ts` `buildCommandArgs()` to see how the subprocess is spawned
  - The fix: set `env` on the spawn options to exclude `.env` loading. Add `PYDANTIC_SETTINGS_DOTENV_PATH=''` or `DOTENV_PATH=''` to the subprocess environment to prevent pydantic from reading project `.env.local` files
  - Alternative: set the CWD of the chroma-mcp subprocess to a safe directory (like `~/.claude-mem/`) instead of inheriting the project CWD
  - Search for how the subprocess CWD is set — if it inherits from the parent, override it explicitly

- [ ] Run tests and build:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - On macOS, verify chroma-mcp starts cleanly in a project that has a `.env.local` file
