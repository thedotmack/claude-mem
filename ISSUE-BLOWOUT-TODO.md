# Issue Blowout 2026 - Running TODO

Branch: `issue-blowout-2026` (merged as PR #2079)
Strategy: Cynical dev. Every bug report is suspect — look for overengineered band-aids as root cause.
Test gate: After every build-and-sync, verify observations are flowing.
Released: **v12.3.2** on 2026-04-19

## Instructions for Continuation

### Workflow per issue
1. Use `/make-plan` and `/do` to attack each issue's root cause
2. Be cynical — most bug reports are surface-level; the real issue is usually overengineered band-aids
3. After every `npm run build-and-sync`, verify observations flow:
   ```bash
   sleep 5 && sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE created_at_epoch > (strftime('%s','now') - 120) * 1000"
   ```
4. If observations stop flowing, that's a regression — fix it before continuing

### Docker isolation
- **Port 37777**: Host's live bun worker (YOUR claude-mem instance — don't touch)
- **Port 37778**: Another agent's docker container (`claude-mem-dev`) — hands off
- **Your docker**: Use tag `claude-mem:blowout`, data dir `.docker-blowout-data/`
  ```bash
  TAG=claude-mem:blowout docker/claude-mem/build.sh
  HOST_MEM_DIR=$(pwd)/.docker-blowout-data TAG=claude-mem:blowout docker/claude-mem/run.sh
  ```
- Check observations in docker DB:
  ```bash
  sqlite3 .docker-blowout-data/claude-mem.db 'select count(*) from observations'
  ```

### PR → Review → Merge → Release cycle
1. Create PR from feature branch to main
2. Start review loop: `/loop 2m` to check and resolve review comments
   - CodeRabbit and Greptile post inline comments — read, fix, commit, push, reply
   - `claude-review` is a CI check — just needs to pass
   - CodeRabbit can take 5-10 min to process after each push
3. When all reviews pass: `gh pr merge <PR#> --repo thedotmack/claude-mem --squash --delete-branch --admin`
4. Close resolved issues: `for issue in <numbers>; do gh issue close $issue --repo thedotmack/claude-mem --comment "Fixed in PR #XXXX"; done`
5. Version bump:
   ```bash
   cd ~/Scripts/claude-mem
   git pull origin main
   # Run /version-bump patch (or use the skill: claude-mem:version-bump)
   # It handles: version files → build → commit → tag → push → gh release → changelog
   ```

### Key files in the codebase
- **Parser**: `src/sdk/parser.ts` — observation and summary XML parsing
- **Prompts**: `src/sdk/prompts.ts` — LLM prompt templates (observation, summary, continuation)
- **ResponseProcessor**: `src/services/worker/agents/ResponseProcessor.ts` — unified response handler
- **SessionManager**: `src/services/worker/SessionManager.ts` — queue, sessions, circuit breaker
- **SessionSearch**: `src/services/sqlite/SessionSearch.ts` — FTS5 and filter queries
- **SearchManager**: `src/services/worker/SearchManager.ts` — hybrid Chroma+SQLite orchestration
- **Worker service**: `src/services/worker-service.ts` — periodic reapers, startup
- **Summarize hook**: `src/cli/handlers/summarize.ts` — Stop hook entry point
- **SessionRoutes**: `src/services/worker/http/routes/SessionRoutes.ts` — HTTP API
- **ViewerRoutes**: `src/services/worker/http/routes/ViewerRoutes.ts` — /health endpoint
- **Agents**: `src/services/worker/SDKAgent.ts`, `GeminiAgent.ts`, `OpenRouterAgent.ts`
- **Modes**: `plugin/modes/code.json` — prompt field values for the default mode
- **Migrations**: `src/services/sqlite/migrations/runner.ts`
- **PendingMessageStore**: `src/services/sqlite/PendingMessageStore.ts` — queue persistence

## Completed Phase 2-5 (16 more issues — this session)

| # | Component | Issue | Resolution |
|---|-----------|-------|------------|
| 2053 | worker | Generator restart guard strands pending messages | FIXED — Time-windowed RestartGuard replaces flat counter (10 restarts/60s window, 5min decay) |
| 1868 | worker | SDK pool deadlock: idle sessions monopolize slots | FIXED — evictIdlestSession() callback in waitForSlot() preempts idle sessions |
| 1876 | worker | MCP loopback self-check fails; crash misclassification | FIXED — process.execPath replaces bare 'node'; removed false "exited unexpectedly" log |
| 1901 | hooks | Summarize stop hook exits code 2 on errors | FIXED — workerHttpRequest wrapped in try/catch, exits gracefully |
| 1907 | hooks | Linux/WSL session-init before worker healthy | FIXED — health-check curl loop added to UserPromptSubmit hook; HTTP call wrapped |
| 1896 | hooks | PreToolUse file-context caps Read to limit:1 | CLOSED — already fixed (mtime comparison at file-context.ts:255-267) |
| 1903 | hooks | PostToolUse/Stop/SessionEnd never fire | CLOSED — no-repro (hooks.json correct; Claude Code 12.0.1 platform bug) |
| 1932 | security | Admin endpoints spoofable requireLocalhost | FIXED — bearer token auth on all API endpoints |
| 1933 | security | Unauthenticated HTTP API exposes 30+ endpoints | FIXED — auto-generated token at ~/.claude-mem/worker-auth-token (mode 0600) |
| 1934 | security | watch.context.path written without validation | FIXED — path traversal protection validates against project root / data dir |
| 1935 | security | Unbounded input, no rate limits | FIXED — 5MB body limit (was 50MB), 300 req/min/IP rate limiter |
| 1936 | security | Multi-user macOS shared port cross-user MCP | FIXED — per-user port derivation from UID (37700 + uid%100) |
| 1911 | search | search()/timeline() cross-project results | FIXED — project filter passed to Chroma queries and timeline anchor searches |
| 1912 | search | /api/search per-type endpoints ignore project | FIXED — project $or clause added to searchObservations/Sessions/UserPrompts |
| 1914 | search | Imported observations invisible to MCP search | FIXED — ChromaSync.syncObservation() called after import |
| 1918 | search | SessionStart "no previous sessions" on fresh sessions | FIXED — session-init cwd fallback matches context.ts (process.cwd()) |

## Completed (9 issues — PR #2079, v12.3.2)

| # | Component | Issue | Resolution |
|---|-----------|-------|------------|
| 1908 | summarizer | parseSummary discards output when LLM emits observation tags | CLOSED — already fixed by Gen 3 coercion (coerceObservationToSummary in parser.ts) |
| 1953 | db | Migration 7 rebuilds table every startup | CLOSED — already fixed by commit 59ce0fc5 (origin !== 'pk' filter) |
| 1916 | search | /api/search/by-concept emits malformed SQL | FIXED — concept→concepts remap in SearchManager.normalizeParams() |
| 1913 | search | Text search returns empty when ChromaDB disabled | FIXED — FTS5 keyword fallback in SessionSearch + SearchManager |
| 2048 | search | Text queries should fall back to FTS5 when Chroma disabled | FIXED — same as #1913 |
| 1957 | db | pending_messages: failed rows never purged | FIXED — periodic clearFailed() in stale session reaper (every 2 min) |
| 1956 | db | WAL grows unbounded, no checkpoint schedule | FIXED — journal_size_limit=4MB + periodic wal_checkpoint(PASSIVE) |
| 1874 | worker | processAgentResponse deletes queued messages on non-XML output | FIXED — mark messages failed (with retry) instead of confirming |
| 1867 | worker | Queue processor dies while /health stays green | FIXED — activeSessions count added to /health endpoint |

Also fixed (not an issue): docker/claude-mem/run.sh nounset-safe TTY_ARGS expansion.
Also fixed (Greptile review): cached isFts5Available() at construction time.

## Remaining — CRITICAL (5)

| # | Component | Issue |
|---|-----------|-------|
| 1925 | mcp | chroma-mcp subprocess leak via null-before-close |
| 1926 | mcp | chroma-mcp stdio handshake broken across all versions |
| 1942 | auth | Default model not resolved on Bedrock/Vertex/Azure |
| 1943 | auth | SDK pipeline rejects Bedrock auth |
| 1880 | windows | Ghost LISTEN socket on port 37777 after crash |
| 1887 | windows | Failing worker blocks Claude Code MCP 10+ min in hook-restart loop |

## Remaining — HIGH (32)

| # | Component | Issue |
|---|-----------|-------|
| 1869 | worker | No mid-session auto-restart after inner crash |
| 1870 | worker | Stop hook blocks ~110s when SDK pool saturated |
| 1871 | worker | generateContext opens fresh SessionStore per call |
| 1875 | worker | Spawns uvx/node/claude by bare name; silent fail in non-interactive |
| 1877 | worker | Cross-session context bleed in same project dir |
| 1879 | worker | Session completion races in-flight summarize |
| 1890 | sdk-pool | SDK session resume during summarize causes context-overflow |
| 1892 | sdk-pool | Memory agent prompt defeats cache (dynamic before static) |
| 1895 | hooks | Stop hook spins 110s when worker older than v12.1.0 |
| 1897 | hooks | PreToolUse:Read lacks PATH export and cache-path lookup |
| 1899 | hooks | SessionStart additionalContext >10KB truncated to 2KB |
| 1902 | hooks | Stop and PostToolUse hooks synchronously block up to 120s |
| 1904 | hooks | UserPromptSubmit hooks skipped in git worktree sessions |
| 1905 | hooks | Saved_hook_context entries pegs CPU 100% on session load |
| 1906 | hooks | PR #1229 fallback path points to source, not cache |
| 1909 | summarizer | Summarize hook doesn't recognize Gemini transcripts |
| 1921 | mcp | Root .mcp.json is empty, mcp-search never registers |
| 1922 | mcp | MCP server uses 3s timeout for corpus prime/query |
| 1929 | installer | "Update now" fails for cache-only installs |
| 1930 | installer | Windows 11 ships smart-explore without tree-sitter |
| 1937 | observer | JSONL files accumulate indefinitely, tens of GB |
| 1938 | observer | Observer background sessions burn tokens with no budget |
| 1939 | cross-platform | Project key uses basename(cwd), fragmenting worktrees |
| 1941 | cross-platform | Linux worker with live-but-unhealthy PID blocks restart |
| 1944 | auth | ANTHROPIC_AUTH_TOKEN not forwarded to SDK subprocess |
| 1945 | auth | Vertex AI CLI auth fails silently on expired OAuth |
| 1947 | plugin-lifecycle | OpenCode tool args as plain objects not Zod schemas |
| 1948 | plugin-lifecycle | OpenClaw installer "plugin not found" |
| 1949 | plugin-lifecycle | OpenClaw per-agent memory isolation broken |
| 1950 | plugin-lifecycle | OpenClaw missing skills, session drift, workspaceDir loss |
| 1952 | db | ON UPDATE CASCADE rewrites historical session attribution |
| 1954 | db | observation_feedback schema mismatch source vs compiled |
| 1958 | viewer | Settings model dropdown destroys precise model IDs |
| 1881-1888 | windows | 8 Windows-specific bugs (paths, spawning, timeouts) |

## Remaining — MEDIUM (21)

| # | Component | Issue |
|---|-----------|-------|
| 1872 | worker | Gemini 400/401 triggers 2-min crash-recovery loop |
| 1873 | worker | worker-service.cjs killed by SIGKILL (unbounded heap) |
| 1878 | worker | Logger caches log file path, never rotates |
| 1891 | sdk-pool | Mode prompts in user messages, not system prompt |
| 1893 | sdk-pool | SDK sub-agents hardcoded permissionMode:"default" |
| 1894 | hooks | SessionStart can't find claude at ~/.local/bin |
| 1898 | hooks | SessionStart health-check uses hardcoded port 37777 |
| 1900 | hooks | Setup hook references non-existent scripts/setup.sh |
| 1910 | summarizer | Summary prompt leaks observation tags, ignores user_prompt |
| 1915 | search | Search results not deduplicated |
| 1917 | search | $CMEM context preview shows oldest instead of newest |
| 1920 | search | Context footer "ID" ambiguous across 3 ID spaces |
| 1923 | mcp | smart_outline empty for .txt files |
| 1924 | mcp | chroma-mcp child not terminated on exit |
| 1927 | mcp | chroma-mcp fails on WSL with ALL_PROXY=socks5 |
| 1928 | installer | BranchManager.pullUpdates() fails on cache-layout |
| 1931 | installer | npm run worker:status ENOENT .claude/package.json |
| 1940 | cross-platform | cmux.app wrapper "Claude executable not found" |
| 1946 | auth | OpenRouter 401 Missing Authentication header |
| 1955 | db | Duplicate observations bypass content-hash dedup |
| 1959 | viewer | SSE new_prompt broadcast dies after /reload-plugins |
| 1961 | misc | Traditional Chinese falls back to Simplified |

## Remaining — LOW (3)

| # | Component | Issue |
|---|-----------|-------|
| 1919 | search | Shared jsts tree-sitter query applies TS-only to JS |
| 1951 | plugin-lifecycle | OpenClaw lifecycle events stored as observations |
| 1960 | misc | OpenRouter URL hardcoded |

## Remaining — NON-LABELED (1)

| # | Component | Issue |
|---|-----------|-------|
| 2054 | installer | installCLI version-pinned alias can't self-update |

## Suggested Next Attack Order

### Phase 2: Worker stability — DONE
### Phase 3: Hooks reliability — DONE
### Phase 4: Security hardening — DONE
### Phase 5: Search remaining — DONE

### Phase 6: MCP + Auth
- #1925, #1926, #1942, #1943

### Phase 7: Windows
- #1880, #1887, #1881-1888

### Phase 6: MCP / Chroma
- #1925, #1926, #2046, #1921

### Phase 7: Everything else
- Remaining hooks, installer, windows, observer, viewer, auth, plugin-lifecycle

## Progress Log

| Time | Action | Result |
|------|--------|--------|
| 9:40p | #1908 analyzed | Already fixed by Gen 3 coercion. Closed. |
| 9:51p | #1916 fixed | concept→concepts remap in normalizeParams |
| 9:53p | #1913/#2048 fixed | FTS5 fallback in SessionSearch + SearchManager |
| 9:57p | #1953 closed | Already fixed by commit 59ce0fc5 |
| 9:57p | #1957 fixed | Periodic clearFailed() in stale session reaper |
| 9:58p | #1956 fixed | journal_size_limit + periodic WAL checkpoint |
| 10:01p | #1874 fixed | Non-XML responses mark messages failed instead of confirming |
| 10:01p | #1867 fixed | Health endpoint includes activeSessions count |
| 10:02p | build-and-sync | Observations flowing. No regression. |
| 10:03p | PR #2079 created | 2 commits pushed |
| 10:06p | Greptile review | 2 comments — cached isFts5Available(). Fixed + pushed. |
| 10:20p | PR #2079 merged | All reviews passed (CodeRabbit, Greptile, claude-review) |
| 10:25p | v12.3.2 released | Tag pushed, GitHub release created, CHANGELOG updated |
