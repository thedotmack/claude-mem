# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).


## [Unreleased]


## [5.4.0] - 2025-11-09

### ⚠️ BREAKING CHANGE: MCP Search Tools Removed

**Migration**: None required. Claude automatically uses the search skill when needed.

### Changed
- **Skill-Based Search Architecture**: Replaced MCP search tools with skill-based HTTP API
  - **Token Savings**: ~2,250 tokens per session start
  - **Progressive Disclosure**: Skill frontmatter (~250 tokens) vs MCP tool definitions (~2,500 tokens)
  - Search functionality works identically but with better efficiency
  - No user action required - migration is transparent

### Added
- **10 New HTTP Search API Endpoints** in worker service:
  - `GET /api/search/observations` - Full-text search observations
  - `GET /api/search/sessions` - Full-text search session summaries
  - `GET /api/search/prompts` - Full-text search user prompts
  - `GET /api/search/by-concept` - Find observations by concept tag
  - `GET /api/search/by-file` - Find work related to specific files
  - `GET /api/search/by-type` - Find observations by type (bugfix, feature, etc.)
  - `GET /api/context/recent` - Get recent session context
  - `GET /api/context/timeline` - Get timeline around specific point in time
  - `GET /api/timeline/by-query` - Search + timeline in one call
  - `GET /api/search/help` - API documentation
- **Search Skill** (`plugin/skills/search/SKILL.md`):
  - Auto-invoked when users ask about past work, decisions, or history
  - Comprehensive documentation with usage examples and workflows
  - Format guidelines for presenting search results

### Removed
- **MCP Search Server** (deprecated):
  - Removed `claude-mem-search` from plugin/.mcp.json
  - Build script no longer compiles search-server.mjs
  - Source file kept for reference: src/servers/search-server.ts
  - All 9 MCP tools replaced by equivalent HTTP API endpoints

### Technical Details
- **How It Works**: User asks → Claude recognizes intent → Invokes search skill → Skill uses curl to call HTTP API → Formats results
- **User Experience**: Identical search capabilities with significantly lower context overhead
- **Performance**: Same search speed, better session start performance

### Documentation
- Updated CLAUDE.md with skill-based search explanation
- Removed MCP references throughout documentation
- Added comprehensive search skill documentation
- Updated build scripts to skip search-server compilation


## [5.1.2] - 2025-11-06

### Added
- **Theme Toggle**: Light/dark mode support in viewer UI
  - User-selectable theme with persistent settings
  - Automatic system preference detection
  - Smooth transitions between themes
- Updated viewer UI with theme toggle controls in header

### Changed
- Version bumped from 5.1.1 to 5.1.2 across all metadata files
- Rebuilt all plugin scripts with theme functionality


## [5.1.1] - 2025-11-06

### Fixed
- **PM2 ENOENT error on Windows**: Fixed PM2 process spawning by using full path to PM2 binary
- Improved cross-platform compatibility for PM2 process management
- Updated scripts/smart-install.js to use full PM2 binary path


## [5.1.0] - 2025-11-05

### Added
- **Web-Based Viewer UI**: Production-ready viewer accessible at http://localhost:37777
  - Real-time visualization via Server-Sent Events (SSE)
  - Infinite scroll pagination with automatic deduplication
  - Project filtering to focus on specific codebases
  - Settings persistence (sidebar state, selected project)
  - Auto-reconnection with exponential backoff
  - GPU-accelerated animations for smooth interactions
- **New Worker Endpoints** (8 HTTP/SSE routes, +500 lines):
  - `/api/prompts` - Paginated user prompts with project filtering
  - `/api/observations` - Paginated observations with project filtering
  - `/api/summaries` - Paginated session summaries with project filtering
  - `/api/stats` - Database statistics (total counts by project)
  - `/api/projects` - List of unique project names
  - `/stream` - Server-Sent Events for real-time updates
  - `/` - Serves viewer HTML
- **Database Enhancements** (+98 lines in SessionStore):
  - `getRecentPrompts()` - Paginated prompts with OFFSET/LIMIT
  - `getRecentObservations()` - Paginated observations with OFFSET/LIMIT
  - `getRecentSummaries()` - Paginated summaries with OFFSET/LIMIT
  - `getStats()` - Aggregated statistics by project
  - `getUniqueProjects()` - Distinct project names
- **Complete React UI** (17 new files, 1,500+ lines):
  - Components: Header, Sidebar, Feed, Cards (Observation, Prompt, Summary, Skeleton)
  - Hooks: useSSE, usePagination, useSettings, useStats
  - Utils: Data merging, formatters, constants
  - Assets: Monaspace Radon font, logos (dark mode + logomark)
  - Build: esbuild pipeline for self-contained HTML bundle


## [5.0.3] - 2025-11-05

### Added
- **Smart Install Caching**: Eliminated redundant npm install on every SessionStart (2-5s → 10ms)
  - Caches version state in `.install-version` file
  - Only runs npm install when actually needed (first time, version change, missing deps)
  - 200x faster SessionStart for cached installations
- Dynamic Python version detection in Windows error messages
- Comprehensive Windows troubleshooting guidance

### Fixed
- Fixed Windows installation issues with smart caching installer

### Changed
- Enhanced rsync to respect gitignore rules
- Better PM2 worker startup verification
- Cross-platform compatible (pure Node.js)

### Technical Details
- New: scripts/smart-install.js (smart caching installer)
- Modified: plugin/hooks/hooks.json (use smart-install.js instead of inline npm install)
- Modified: package.json (enhanced sync-marketplace script)


## [5.0.2] - 2025-11-05

### Fixed
- **Worker startup reliability**: Fixed async health checks with proper error handling
- Added isWorkerHealthy() and waitForWorkerHealth() functions to src/shared/worker-utils.ts
- Worker now verifies health before proceeding with hook operations
- Improved handling of PM2 failures when not yet installed

### Changed
- Changed ensureWorkerRunning() from synchronous to async with proper await
- All hooks now await ensureWorkerRunning for reliable worker communication
- Rebuilt all plugin executables with version 5.0.2


## [5.0.1] - 2025-11-05

### Fixed
- Fixed worker service stability issues
- Enhanced worker process management and restart reliability
- Improved session management and logging across all hooks
- Better error handling throughout hook lifecycle

### Added
- GitHub Actions workflows for automated code review

### Technical Details
- Modified: src/services/worker-service.ts (stability improvements)
- Modified: src/shared/worker-utils.ts (consistent formatting)
- Modified: ecosystem.config.cjs (removed error/output redirection)
- Modified: src/hooks/*-hook.ts (ensure worker running)
- New: .github/workflows/claude-code-review.yml
- New: .github/workflows/claude.yml


## [5.0.0] - 2025-10-27

### BREAKING CHANGES
- **Python dependency for optimal performance**: Semantic search requires Python for ChromaDB
- **Search behavior prioritizes semantic relevance**: Chroma semantic search combined with SQLite temporal filtering
- **Worker service now initializes ChromaSync on startup**: Automatic vector database synchronization

### Added
- **Hybrid Search Architecture**: Combining ChromaDB semantic search with SQLite FTS5 keyword search
  - ChromaSync Service for automatic vector database synchronization (738 lines)
  - Vector embeddings for semantic similarity search
  - 90-day recency filtering for relevant results
  - Performance: Semantic search <200ms
- **get_context_timeline** MCP tool: Get unified timeline of context around a specific point in time
  - Anchor by observation ID, session ID, or ISO timestamp
  - Configurable depth before/after anchor
- **get_timeline_by_query** MCP tool: Search for observations and get timeline context around best match
  - Auto mode: Automatically use top search result as timeline anchor
  - Interactive mode: Show top N search results for manual anchor selection
- **Enhanced MCP tools**: All 9 search tools now support hybrid semantic + keyword search

### Technical Details
- New: src/services/sync/ChromaSync.ts (vector database sync)
- Modified: src/servers/search-server.ts (+995 lines for hybrid search)
- Modified: src/services/worker-service.ts (+136 lines for ChromaSync integration)
- Modified: src/services/sqlite/SessionStore.ts (+276 lines for timeline queries)
- Validation: 1,390 observations → 8,279 vector documents
- Total MCP tools: 7 → 9 (added timeline tools)


## [4.3.4] - 2025-10-26

### Fixed
- **SessionStart hooks running on session resume**: Added matcher configuration to only run hooks on startup, clear, or compact events
- Prevents unnecessary hook execution and improves performance

### Technical Details
- Modified: plugin/hooks/hooks.json (added matcher configuration)


## [4.3.3] - 2025-10-26

### Added
- Made session display count configurable (DISPLAY_SESSION_COUNT = 8)
- First-time setup detection with helpful user messaging
- Improved UX: First install message clarifies Plugin Hook Error display

### Technical Details
- Updated: src/hooks/context-hook.ts (configurable session count)
- Updated: src/hooks/user-message-hook.ts (first-time setup detection)


## [4.3.2] - 2025-10-26

### Added
- **User-facing context display**: Added user-message-hook for displaying context to users via stderr
  - Hook fires simultaneously with context injection
  - Error messages don't get added to context, enabling user visibility
  - Temporary workaround until Claude Code adds ability to share messages with both user and context
- **Comprehensive documentation** (4 new files, 2500+ lines total):
  - docs/architecture-evolution.mdx (801 lines)
  - docs/context-engineering.mdx (222 lines)
  - docs/hooks-architecture.mdx (784 lines)
  - docs/progressive-disclosure.mdx (655 lines)

### Fixed
- Improved cross-platform path handling in context-hook

### Technical Details
- New: src/hooks/user-message-hook.ts (stderr-based display mechanism)
- New: plugin/scripts/user-message-hook.js (built executable)
- Modified: plugin/hooks/hooks.json (hook configuration)
- Modified: src/hooks/context-hook.ts (path handling)
- Modified: scripts/build-hooks.js (build support)


## [4.3.1] - 2025-10-26

### Fixed
- **SessionStart hook context injection**: Fixed context not being injected into new sessions due to npm output pollution
  - Changed npm loglevel from `--loglevel=error` to `--loglevel=silent` in `plugin/hooks/hooks.json`
  - npm install stdout/stderr was polluting hook JSON output, preventing proper context injection
  - Hook now produces clean JSON output for reliable context injection
- **Hooks architecture consolidation**: Removed wrapper layer to simplify codebase
  - Removed `src/bin/hooks/*` wrapper files
  - Consolidated hook logic directly into `src/hooks/*-hook.ts` files
  - Fixed double shebang issues (esbuild now adds shebang during build)

### Technical Details
- Modified: `plugin/hooks/hooks.json` (line 25: npm install verbosity)
- Removed: All files in `src/bin/hooks/` directory
- Root cause: npm stderr/stdout interfering with hook's JSON hookSpecificOutput format


## [4.3.0] - 2025-10-25

### Added
- **Progressive Disclosure Context**: Enhanced context hook with layered memory retrieval system
  - Layer 1 (Index): Observation titles, token costs, and type indicators at session start
  - Layer 2 (Details): Full narratives retrieved on-demand via MCP search
  - Layer 3 (Perfect Recall): Source code and original transcripts
  - Context hook now displays observations in table format with ID, timestamp, type indicator, title, and token count
  - Type indicators: 🔴 (critical/gotcha), 🟤 (decision), 🔵 (informational/how-it-works)
  - Progressive disclosure instructions guide Claude on when to fetch full observation details vs. reading code
  - Token counts (~200-500 per observation) help Claude make informed retrieval decisions
- **Agent Skills documentation**: Added comprehensive documentation on creating and using Claude Code agent skills
- **Version bump skill**: Added automated version bump management skill for streamlined releases
- **Memory toggle feature planning**: Added design document for future pause/resume recording capability

### Changed
- **Enhanced session summary handling**: Improved timeline rendering and summary organization
- **Improved context hook output**: Added structured timeline with session grouping and observation details
- **Context token cost**: Increased from ~800 tokens to ~2,500 tokens for richer observation index

### Fixed
- **Cross-platform path detection**: Removed hardcoded macOS-specific paths for project and Claude Code executable (fixes #23)
  - Removed hardcoded paths in context hook, worker service, and SDK integration
  - Now uses dynamic path resolution for cross-platform compatibility
  - Affects: `src/hooks/context.ts`, `src/services/worker-service.ts`, `src/sdk/worker.ts`


## [4.2.11] - 2025-10-25

### Fixed
- **Cross-platform Claude path detection**: Fixed SDK auto-detection failure by implementing explicit `which`/`where` command execution
  - SDK's automatic Claude path detection was returning undefined
  - Unix/macOS: Uses `which claude` command to find executable
  - Windows: Uses `where claude` command (works in both CMD and PowerShell)
  - Fallback to `CLAUDE_CODE_PATH` environment variable if set
  - Handles Windows multiple results by taking first match
  - Worker now logs discovered path for debugging: "Found Claude executable: /path/to/claude"

### Technical Details
- Added `findClaudePath()` helper function using `child_process.execSync`
- Platform detection via `process.platform === 'win32'` to choose appropriate command
- Updated `src/sdk/worker.ts` and `src/services/worker-service.ts` with explicit path detection
- Both files now pass `pathToClaudeCodeExecutable: claudePath` to SDK query


## [4.2.10] - 2025-10-25

### Fixed
- **Windows compatibility**: Removed hardcoded macOS-specific Claude executable path that prevented worker service from running on Windows
  - Removed hardcoded path: `/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude`
  - Removed `pathToClaudeCodeExecutable` parameter from SDK query() calls
  - SDK now automatically detects Claude Code executable path on all platforms
  - Affects: `src/sdk/worker.ts`, `src/services/worker-service.ts`, `plugin/scripts/worker-service.cjs`


## [4.2.3] - 2025-10-23

### Security
- **FTS5 injection vulnerability fix**: Added proper escaping to prevent SQL injection attacks in search functions
  - Implemented double-quote escaping for FTS5 full-text search queries
  - Added comprehensive test suite with 332 new tests covering injection scenarios
  - Affects: `search_observations`, `search_sessions`, `search_user_prompts` MCP tools

### Fixed
- **ESM/CJS compatibility**: Fixed getDirname function to work in both ESM (hooks) and CJS (worker) contexts
  - Detects context using `typeof __dirname !== 'undefined'`
  - Falls back to `fileURLToPath(import.meta.url)` for ESM modules
  - Resolves path resolution issues across different module systems
- **Windows PowerShell compatibility**: Fixed SessionStart hook error on Windows systems
  - Replaced bash-specific test command `[` with standard cross-platform npm install
  - Simplified hook command to use idempotent npm install (fast when dependencies exist)
  - Dependencies install from root package.json in marketplace folder

### Changed
- **SessionStart hook command**: Now uses `cd ... && npm install --prefer-offline --no-audit --no-fund --loglevel=error && node context-hook.js`
  - Removed bash-specific conditional check
  - npm install is fast (~500ms) and idempotent when dependencies already exist
  - Works cross-platform on Windows, macOS, and Linux


## [4.2.1] - 2025-10-22

### Added
- **Summary skip logic**: Summaries now skip when work is already covered, banter/trivial requests, or no meaningful observations
  - New "WHEN NOT TO SUMMARIZE" section in buildSummaryPrompt guides SDK to avoid duplicate/trivial summaries
  - Parser detects `<skip_summary reason="..."/>` format and logs reason
  - Prevents duplicate summaries like the three "restore 6 types" summaries observed in session d9137878

### Fixed
- **Observation type validation**: Parser now validates all 6 observation types (bugfix, feature, refactor, change, discovery, decision) instead of only 3

### Changed
- **Chronological summary guidance**: Summaries now explicitly instructed to capture "what happened in THIS prompt" rather than re-summarizing previous work


## [4.1.1] - 2025-10-21

### Removed
- **advanced_search tool**: Removed redundant MCP tool that provided no functionality beyond calling search_observations + search_sessions

### Fixed
- **MCP search limit bug**: Fixed findByConcept, findByType, and findByFile methods to properly respect limit/offset parameters
- **Type contamination in concepts**: Added parser validation to prevent observation types from being added to concepts array
- **Token limit warnings**: Added guidance in tool descriptions to start with 3-5 results to avoid MCP token limits

### Changed
- **Simplified MCP API**: Reduced from 7 to 6 search tools by removing the redundant advanced_search
- **Improved search prompts**: Enhanced type and concept constraint language in SDK prompts to prevent AI contamination


## [4.1.0] - 2025-10-21

### Changed
- **Graceful session cleanup**: Cleanup hook now marks sessions as completed instead of sending DELETE requests to worker
- **Natural worker shutdown**: Workers now finish pending operations (like summary generation) before terminating
- **Restored MCP search server**: Re-enabled full-text search capabilities from backup

### Fixed
- Session summaries no longer interrupted by aggressive cleanup during session end
- Workers can now complete final operations before shutdown


## [4.0.2] - 2025-10-19

### Changed
- **PM2 bundled as dependency**: Moved pm2 from devDependencies to dependencies for out-of-the-box functionality
- **Worker scripts use local PM2**: All npm worker scripts now use `npx pm2` to ensure local binary is used
- **Worker startup uses local PM2**: Worker auto-start now uses `node_modules/.bin/pm2` instead of global pm2

### Fixed
- **Fail loudly on missing dependencies**: Worker startup now throws explicit errors when bundled pm2 is missing instead of silently falling back
- **Better error messages**: Clear actionable error messages guide users to run `npm install` when dependencies are missing
- **Removed silent fallback**: Eliminated silent degradation that masked "works on my machine" installation failures

### Documentation
- Updated README system requirements to reflect pm2 is bundled with plugin (no global install required)


## [4.0.0] - 2025-10-18

### BREAKING CHANGES
- **Data directory moved to plugin location**: Database and worker files now stored in `${CLAUDE_PLUGIN_ROOT}/data/` instead of `~/.claude-mem/`
- **Fresh start required**: No automatic migration from v3.x databases. Users must start fresh with v4.0.0
- **Worker auto-starts**: Worker service now starts automatically on SessionStart hook, no manual PM2 commands needed

### Added
- **MCP Search Server**: 6 specialized search tools with FTS5 full-text search capabilities
  - `search_observations` - Full-text search across observation titles, narratives, facts, and concepts
  - `search_sessions` - Full-text search across session summaries, requests, and learnings
  - `find_by_concept` - Find observations tagged with specific concepts
  - `find_by_file` - Find observations and sessions that reference specific file paths
  - `find_by_type` - Find observations by type (decision, bugfix, feature, refactor, discovery, change)
  - `advanced_search` - Combined search with filters across observations and sessions
- **Citation support**: All search results include `claude-mem://` URI citations for referencing specific observations and sessions
- **Automatic worker startup**: Worker service now starts automatically in SessionStart hook
- **Plugin data directory**: Full integration with Claude Code plugin system using `CLAUDE_PLUGIN_ROOT`

### Changed
- **Worker service architecture**: HTTP REST API with PM2 management for long-running background service
- **Data directory priority**: `CLAUDE_PLUGIN_ROOT/data` > `CLAUDE_MEM_DATA_DIR` > `~/.claude-mem` (fallback for dev)
- **Port file location**: Worker port file now stored in plugin data directory
- **Session continuity**: Automatic context injection from last 3 sessions on startup
- **Package structure**: Reorganized to properly distribute plugin/, dist/, and src/ directories

### Fixed
- Context hook now uses proper `hookSpecificOutput` JSON format for SessionStart
- Added missing process.exit(0) calls in all hook entry points
- Worker service now ensures data directory exists before writing port file
- Improved error handling and graceful degradation across all components


## [3.7.1] - 2025-09-17

### Added
- SQLite storage backend with session, memory, overview, and diagnostics management
- Mintlify documentation site with searchable interface and comprehensive guides
- Context7 MCP integration for documentation retrieval

### Changed
- Session-start overviews to display chronologically from oldest to newest

### Fixed
- Migration index parsing bug that prevented JSONL records from importing to SQLite


## [3.6.10] - 2025-09-16

### Added
- Claude Code statusline integration for real-time memory status
- MCP memory tools server providing compress, stats, search, and overview commands
- Concept documentation explaining memory compression and context loading

### Fixed
- Corrected integration architecture to use hooks instead of MCP SDK


## [3.6.9] - 2025-09-14

### Added
- Display current date and time at the top of session-start hook output for better temporal context

### Changed
- Enhanced session-start hook formatting with emoji icons and separator lines for improved readability


## [3.6.8] - 2025-09-14

### Fixed
- Fixed publish command failing when no version-related memories exist for changelog generation


## [3.6.6] - 2025-09-14

### Fixed
- Resolved compaction errors when processing large conversation histories by reducing chunk size limits to stay within Claude's context window


## [3.6.5] - 2025-09-14

### Changed
- Session groups now display in chronological order (most recent first)

### Fixed
- Improved CLI path detection for cross-platform compatibility


## [3.6.4] - 2025-09-13

### Changed
- Update save documentation to include allowed-tools and description metadata fields

### Removed
- Remove deprecated markdown to JSONL migration script


## [3.6.3] - 2025-09-11

### Changed
- Updated changelog generation prompts to use date strings in query text for temporal filtering

### Fixed
- Resolved changelog timestamp filtering by using semantic search instead of metadata queries, enabling proper date-based searches
- Corrected install.ts search instructions to remove misleading metadata filtering guidance that caused 'Error finding id' errors


## [3.6.2] - 2025-09-10

### Added
- Visual feedback to changelog command showing current version, next version, and number of overviews being processed
- Generate changelog for specific versions using `--generate` flag with npm publish time boundaries
- Introduce 'Who Wants To Be a Memoryonaire?' trivia game that generates personalized questions from your stored memories
- Add interactive terminal UI with lifelines (50:50, Phone-a-Friend, Audience Poll) and cross-platform audio support
- Implement permanent question caching with --regenerate flag for instant game loading
- Enable hybrid vector search to discover related memory chains during question generation

### Changed
- Changelog regeneration automatically removes old entries from JSONL file when using `--generate` or `--historical` flags
- Switch to direct JSONL file loading for instant memory access without API calls
- Optimize AI generation with faster 'sonnet' model for improved performance
- Reduce memory query limit from 100 to 50 to prevent token overflow

### Fixed
- Changelog command now uses npm publish timestamps exclusively for accurate version time ranges
- Resolved timestamp filtering issues with Chroma database by leveraging semantic search with embedded dates
- Resolve game hanging at startup due to confirmation loop
- Fix memory integration bypass that prevented questions from using actual stored memories
- Consolidate 500+ lines of duplicate code for better maintainability


## [3.6.1] - 2025-09-10

### Changed
- Refactored pre-compact hook to work independently without status line updates

### Removed
- Removed status line integration and ccstatusline configuration support


## [3.5.5] - 2025-09-10

### Changed
- Standardized GitHub release naming to lowercase 'claude-mem vX.X.X' format for consistent branding
