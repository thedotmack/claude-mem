# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).


## [3.6.2] - 2025-09-10

### Added
- Visual feedback to changelog command showing current version, next version, and number of overviews being processed
- Generate changelog for specific versions using `--generate` flag with npm publish time boundaries

### Changed
- Changelog regeneration automatically removes old entries from JSONL file when using `--generate` or `--historical` flags

### Fixed
- Changelog command now uses npm publish timestamps exclusively for accurate version time ranges
- Resolved timestamp filtering issues with Chroma database by leveraging semantic search with embedded dates


## [3.6.1] - 2025-09-10

### Changed
- Refactored pre-compact hook to work independently without status line updates

### Removed
- Removed status line integration and ccstatusline configuration support


## [3.5.5] - 2025-09-10

### Changed
- Standardized GitHub release naming to lowercase 'claude-mem vX.X.X' format for consistent branding

