# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).


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

