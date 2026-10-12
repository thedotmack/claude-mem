# Phase 07: Installer, MCP Schema & Remaining Fixes

This phase addresses the remaining issue groups: installer/setup problems (6 issues), MCP schema/tool bugs (4 issues), AWS Bedrock integration (2 issues), and the top feature requests. These are lower priority individually but collectively represent ~24 open issues that prevent a clean backlog. This phase also updates issue comments on GitHub to reference the commits that fix each bug, closing the loop between triage and code.

## Tasks

- [ ] Fix the missing `scripts/setup.sh` issue (canonical #1340). The install hooks reference a `setup.sh` script that doesn't exist or isn't included in the npm package. To fix:
  - Read `plugin/hooks/hooks.json` to find any references to `setup.sh` or `smart-install.js`
  - Read `plugin/scripts/smart-install.js` — this appears to be the replacement for `setup.sh`. Verify it handles all setup tasks: Bun installation, uv installation, dependency checking
  - Search for any remaining references to `setup.sh` in the codebase: `grep -r "setup.sh" src/ plugin/ install/`
  - If `setup.sh` references exist in hook definitions, update them to point to `smart-install.js`
  - If `setup.sh` is referenced in documentation, update the docs
  - Verify the npm package includes `smart-install.js` by checking the `files` field in `package.json` or the `.npmignore` file

- [ ] Fix MCP tool schema issues. The MCP server's tool registration has empty `inputSchema` objects and ID mismatches that cause some AI clients to fail. To fix:
  - Read `src/servers/mcp-server.ts` (around lines 151-343) for the tool registration
  - Review each tool's `inputSchema`:
    - `__IMPORTANT` tool: empty schema is intentional (instruction-only tool) — document this with a comment
    - `search` tool: has `additionalProperties: true` but no defined properties. Add explicit `properties` for the known parameters: `query` (string, required), `project` (string, optional), `limit` (number, optional), `type` (string, optional)
    - `timeline` tool: add explicit properties for `anchor` (string), `query` (string), `project` (string), `range` (string)
    - `get_observations` tool: schema looks correct (has `ids` array) — verify it matches the actual API endpoint parameters
    - `smart_search`, `smart_unfold`, `smart_outline`: verify their schemas match expected parameters
  - Ensure all tools have `type: 'object'` at the schema root level (required by MCP spec)
  - Test that the tools can be called through Claude Desktop's MCP integration after the schema fix

- [ ] Fix AWS Bedrock integration (2 issues). AWS Bedrock users can't use claude-mem because environment variables aren't passed through and the SDK auth isn't supported. To fix:
  - Search for Bedrock-related code: `grep -r "bedrock\|BEDROCK\|aws\|AWS" src/` (case-insensitive)
  - Read `src/services/worker/agents/SDKAgent.ts` (or similar) to understand how the Anthropic SDK client is initialized
  - The Anthropic SDK supports Bedrock via `@anthropic-ai/bedrock-sdk` or by setting `ANTHROPIC_API_BASE` — check which approach is used
  - Ensure these environment variables are passed through to the worker process and not stripped by `env-sanitizer.ts`:
    - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION`
    - `ANTHROPIC_API_BASE` (for Bedrock endpoint override)
    - `CLAUDE_MEM_BEDROCK_MODEL_ID` (if custom model IDs are needed)
  - Read `src/supervisor/env-sanitizer.ts` — if it uses an allowlist, add the AWS vars. If it uses a denylist (strips `CLAUDECODE_*`), verify AWS vars aren't accidentally matched
  - Add a `CLAUDE_MEM_PROVIDER=bedrock` option in settings if it doesn't exist, that configures the SDK client for Bedrock authentication

- [ ] Fix installer marketplace path and allowlist issues (remaining installer bugs):
  - Search for marketplace path handling: `grep -r "marketplace\|marketplaceDirectory\|installLocation" src/npx-cli/`
  - Read `src/npx-cli/commands/install.ts` for the full installation flow
  - Common issues:
    - Marketplace directory not created before file copy — add `mkdirSync(marketplacePath, { recursive: true })` before copy operations
    - Plugin.json version not matching package.json version — ensure the install command syncs versions
    - Allowlist registration loop: if the plugin is already in the allowlist but with wrong metadata, the installer may re-add it infinitely. Add an idempotency check: skip if already registered with correct version
  - Read the relevant issues (search GitHub for installer-related open issues) to understand specific failure modes
  - Test the install flow end-to-end: `node dist/npx-cli/index.js install --ide claude-code` (or equivalent local test command)

- [ ] Fix SSE broadcast reliability for the viewer UI:
  - Read `src/services/server/Server.ts` or wherever SSE endpoints are defined (search for `SSEBroadcaster`, `text/event-stream`, or `EventSource`)
  - Read `src/services/worker/SSEBroadcaster.ts` (or similar) for how events are dispatched to connected clients
  - Common issues: clients disconnect without cleanup, causing memory leaks; events sent to closed connections throw unhandled errors
  - Ensure:
    - SSE connections are cleaned up on client disconnect (listen for `close` event on the response object)
    - Failed `res.write()` calls are caught and the connection removed from the broadcast list
    - A maximum connection limit (e.g., 10 concurrent SSE clients) prevents resource exhaustion
    - A heartbeat ping is sent every 30 seconds to detect stale connections

- [ ] Update GitHub issues with fix references. For each root-cause group where code was changed in Phases 02-07, comment on the canonical issue(s) with the fix details:
  - Run `git log --oneline -20` to get recent commit hashes
  - For each canonical issue (#1410 __dirname, #1340 setup.sh, #1285 CI injection, #1204 file write, etc.):
    - Add a comment: `"Fix landed in commit <hash> on branch <branch>. The root cause was <brief description>. This will be included in the next release."`
    - Do NOT close the issues — they should remain open until the fix is released and verified by users
  - For feature requests that were partially addressed (like Bedrock support), add a comment noting what was implemented and what remains

- [ ] Final build verification and cleanup:
  - Run `npm run build-and-sync`
  - Run the full test suite
  - Run `git status` to review all changes across Phases 02-07
  - Verify no debug logging, TODO comments, or temporary code was left in
  - Search for `console.log` calls that should be `logger.*` calls
  - Generate a final summary of all changes in `/Users/alexnewman/Scripts/claude-mem/Auto Run Docs/2026-03-29-Issues-Triage-3-29-2026/Working/changes-summary.md` with:
    - List of files modified per phase
    - Issues addressed per phase
    - Any issues that remain open and why
