# Change Log

All notable changes to the "claude-mem-vscode" extension will be documented in this file.

## [0.1.0] - 2024-11-12

### Added
- Initial release
- Language Model Tool integration for GitHub Copilot
- Automatic session initialization and management
- Tool usage observation capture
- Session summary generation
- Worker health monitoring with status bar indicator
- Commands for worker management and viewer access
- Configuration options for auto-init, auto-capture, and port settings
- README documentation and architecture guide

### Features
- **5 Language Model Tools**:
  - `mem_session_init` - Initialize memory sessions
  - `mem_user_prompt_log` - Log user prompts for FTS search
  - `mem_observation_record` - Capture tool usage observations
  - `mem_summary_finalize` - Generate session summaries
  - `mem_session_cleanup` - Mark sessions as complete
- **Worker Integration**: Direct HTTP communication with claude-mem worker service
- **Database Integration**: SQLite database access for session management
- **Status Bar**: Real-time worker health indicator
- **Commands**: Check health, restart worker, open viewer, manage settings

### Architecture
- Built with TypeScript and esbuild
- Reuses claude-mem worker service (port 37777)
- Shares SQLite database with Claude Code plugin
- Language Model Tools provide lifecycle hooks for Copilot
