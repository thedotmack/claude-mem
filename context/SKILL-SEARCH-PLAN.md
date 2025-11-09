 Plan: Migrate to Skill-Based Search (Deprecate MCP)

 Goal

 Replace MCP search tools with a skill-based approach, reducing session
 start context from ~2,500 tokens to ~250 tokens. Clean migration, no
 toggles.

 Implementation Steps

 1. Add HTTP API Endpoints to Worker Service

 File: src/services/worker-service.ts

 Add 10 new routes that wrap existing SessionSearch methods:
 - GET /api/search/observations?query=...&format=index&limit=20&project=...
 - GET /api/search/sessions?query=...&format=index&limit=20
 - GET /api/search/prompts?query=...&format=index&limit=20
 - GET /api/search/by-concept?concept=discovery&format=index&limit=5
 - GET /api/search/by-file?filePath=...&format=index&limit=10
 - GET /api/search/by-type?type=bugfix&format=index&limit=10
 - GET /api/context/recent?project=...&limit=3
 - GET /api/context/timeline?anchor=123&depth_before=10&depth_after=10
 - GET 
 /api/timeline/by-query?query=...&mode=auto&depth_before=10&depth_after=10
 - GET /api/search/help - Returns available endpoints and usage docs

 All endpoints return JSON. Skill parses and formats for readability.

 2. Create Search Skill

 File: plugin/skills/search/SKILL.md

 Frontmatter:
 ---
 name: search
 description: Search claude-mem persistent memory for past sessions,
 observations, bugs fixed, features implemented, decisions made, code
 changes, and previous work. Use when answering questions about history,
 finding past decisions, or researching previous implementations.
 ---

 Content: Instructions for all 9 search types using curl to call HTTP
 endpoints, formatting guidelines, common workflows.

 3. Remove MCP Search Server

 Files to modify:
 - Remove plugin/.mcp.json entry for claude-mem-search
 - Keep src/servers/search-server.ts for reference but don't build it
 - Update scripts/build-plugin.js to skip building search-server.mjs
 - Archive search-server implementation (don't delete, for reference)

 4. Update Documentation

 File: CLAUDE.md

 Remove MCP search references, add skill search explanation:
 - Token savings: ~2,250 tokens per session
 - How skill auto-invokes (model-driven, not user-driven)
 - Available search operations
 - Examples of triggering searches

 5. Add Migration Notice

 File: CHANGELOG.md or release notes

 Document the breaking change:
 ## v5.4.0 - Skill-Based Search Migration

 **BREAKING CHANGE**: MCP search tools have been replaced with a
 skill-based approach.

 **What changed**:
 - Removed 9 MCP search tools (search_observations, search_sessions, etc.)
 - Added `search` skill that provides the same functionality
 - Reduced session start context by ~2,250 tokens

 **Migration**: None required. Claude automatically uses the search skill
 when needed.
 The skill provides the same search capabilities with better token
 efficiency.

 **Why**: Skill-based search uses progressive disclosure (~250 tokens for
 frontmatter)
 instead of loading all 9 tool definitions (~2,500 tokens) on every session
  start.

 6. Testing Checklist

 - All 10 HTTP endpoints return correct data
 - Skill auto-invokes when asking about past work
 - Skill successfully calls endpoints via curl
 - Skill formats results as readable markdown
 - Worker restart updates endpoints
 - Skill distributed correctly with plugin
 - No MCP search server registered
 - Session start context reduced by ~2,250 tokens

 Token Impact

 - Before: ~2,500 tokens (9 MCP tool definitions)
 - After: ~250 tokens (skill frontmatter only)
 - Savings: ~2,250 tokens per session start

 User Experience

 New behavior:
 - User: "What bug did we fix last session?"
 - Claude sees skill description matches → invokes search skill
 - Skill loads full instructions → uses curl to call HTTP API → formats
 results
 - User sees formatted answer

 No user action required: Migration is transparent, searches work
 automatically.

 Build & Deploy

 npm run build                # Builds skill, skips MCP server
 npm run sync-marketplace     # Syncs plugin with skill
 npm run worker:restart       # Restart worker with new HTTP endpoints

 Rollout

 1. Ship as breaking change in v5.4.0
 2. Update plugin marketplace listing
 3. All users get automatic token savings on update
 4. Archive MCP search implementation for reference