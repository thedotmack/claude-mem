# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).


## [Unreleased]


## [4.3.4] - 2025-10-31

### Security
- **Dependency updates**: Fixed npm audit vulnerabilities in build and runtime dependencies
  - Updated `esbuild` from ^0.20.0 to ^0.25.11 (fixes GHSA-67mh-4wv8-2f99 - moderate severity)
    - Vulnerability: Development server request vulnerability that allowed any website to send requests
  - Updated `pm2` from ^5.3.0 to ^6.0.13 (fixes GHSA-x5gf-qvw8-r2rm - low severity)
    - Vulnerability: Regular Expression Denial of Service (ReDoS)
  - All npm audit vulnerabilities resolved (0 vulnerabilities)

### Changed
- **Build system**: Rebuilt all hooks, worker service, and search server with updated esbuild
- **Development**: Removed `package-lock.json` from `.gitignore` for better security and reproducible builds

### Technical Details
- Modified: `package.json` (updated dependency versions)
- Modified: `.gitignore` (removed package-lock.json entry)
- Verified: Build process continues to work correctly with esbuild 0.25.11
- Verified: PM2 worker service functions correctly with pm2 6.0.13


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
