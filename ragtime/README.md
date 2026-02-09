# Ragtime

Email Investigation Batch Processor using Claude-mem's email-investigation mode.

## Overview

Ragtime processes email corpus files through Claude, using the email-investigation mode for entity/relationship/timeline extraction. Each file gets a NEW session - context is managed by Claude-mem's context injection hook, not by conversation continuation.

## Features

- **Email-investigation mode** - Specialized observation types for entities, relationships, timeline events, anomalies
- **Self-iterating loop** - Each file processed in a new session
- **Transcript cleanup** - Automatic cleanup prevents buildup of old transcripts
- **Configurable** - All paths and settings via environment variables

## Usage

```bash
# Basic usage (expects corpus in datasets/epstein-mode/)
bun ragtime/ragtime.ts

# With custom corpus path
RAGTIME_CORPUS_PATH=/path/to/emails bun ragtime/ragtime.ts

# Limit files for testing
RAGTIME_FILE_LIMIT=5 bun ragtime/ragtime.ts
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `RAGTIME_CORPUS_PATH` | `./datasets/epstein-mode` | Path to folder containing .md email files |
| `RAGTIME_PLUGIN_PATH` | `./plugin` | Path to claude-mem plugin |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker service port |
| `RAGTIME_TRANSCRIPT_MAX_AGE` | `24` | Max age of transcripts to keep (hours) |
| `RAGTIME_PROJECT_NAME` | `ragtime-investigation` | Project name for grouping |
| `RAGTIME_FILE_LIMIT` | `0` | Limit files to process (0 = all) |
| `RAGTIME_SESSION_DELAY` | `2000` | Delay between sessions (ms) |

## Corpus Format

The corpus directory should contain markdown files with email content. Files are processed in numeric order based on the first number in the filename:

```
datasets/epstein-mode/
  0001.md
  0002.md
  0003.md
  ...
```

Each markdown file should contain a single email or document to analyze.

## How It Works

1. **Startup**: Sets `CLAUDE_MEM_MODE=email-investigation` and cleans up old transcripts
2. **Processing**: For each file:
   - Starts a NEW Claude session (no continuation)
   - Claude reads the file and analyzes entities, relationships, timeline events
   - Claude-mem's context injection hook provides relevant past observations
   - Worker processes and stores new observations
3. **Cleanup**: Periodic and final transcript cleanup prevents buildup

## License

This directory is licensed under the **PolyForm Noncommercial License 1.0.0**.

See [LICENSE](./LICENSE) for full terms.

### What this means:

- You can use ragtime for noncommercial purposes
- You can modify and distribute it
- You cannot use it for commercial purposes without permission

### Why a different license?

The main claude-mem repository is licensed under AGPL 3.0, but ragtime uses the more restrictive PolyForm Noncommercial license to ensure it remains freely available for personal and educational use while preventing commercial exploitation.

---

For questions about commercial licensing, please contact the project maintainer.
