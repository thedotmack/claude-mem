---
id: "06-git-repo-analyzer"
title: "Git Repository Analyzer"
category: cli
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "help_flag"
    command: "./analyze --help"
    expected: "exit_0"
  - name: "analyze_test_repo"
    command: "mkdir -p /tmp/test-repo && cd /tmp/test-repo && git init && echo 'hello' > file.txt && git add . && git commit -m 'init' && cd /workspace && ./analyze /tmp/test-repo"
    expected: "contains:report"
---

# Git Repository Analyzer

Build a CLI tool that analyzes a local Git repository and produces a structured report covering contributors, activity patterns, codebase statistics, and health metrics.

## Requirements

### Core Features
1. **Contributor Analysis**: List all contributors with commit counts, lines added/removed, and first/last commit dates
2. **Activity Timeline**: Show commits per week/month over the repo's lifetime
3. **File Statistics**: Breakdown by file type (extension), showing file count and total lines
4. **Commit Patterns**: Identify most active days of the week and hours of the day
5. **Health Metrics**: Calculate average commit size, frequency of merge commits, ratio of additions to deletions
6. **Structured Report**: Output as formatted markdown or JSON

### Technical Requirements
- Executable CLI tool
- Named `analyze`
- Uses `git log` and `git diff` commands under the hood (shell out to git, do not require a git library)
- Handles repos of any size (stream/paginate git output for large repos)
- Clear error if the path is not a valid git repository

### CLI Interface
```
Usage: analyze <repo-path> [options]

Arguments:
  repo-path      Path to the git repository to analyze (required)

Options:
  --format       Output format: markdown (default) or json
  --output, -o   Write report to file instead of stdout
  --since        Analyze only commits after this date (ISO 8601)
  --help         Show help
```

### Report Structure
```markdown
# Repository Report: <repo-name>

## Overview
- Total commits: 1,234
- Contributors: 15
- First commit: 2023-01-15
- Last commit: 2024-03-28

## Top Contributors
| Author | Commits | Lines Added | Lines Removed |
|--------|---------|-------------|---------------|
| alice  | 500     | 12,000      | 3,000         |

## File Type Breakdown
| Extension | Files | Lines  |
|-----------|-------|--------|
| .ts       | 45    | 8,000  |
| .js       | 12    | 2,000  |

## Activity Patterns
- Most active day: Tuesday
- Most active hour: 14:00-15:00

## Health Metrics
- Average commit size: 42 lines
- Merge commit ratio: 15%
```

## Testable Deliverables
- `./analyze --help` exits with code 0
- Given a valid git repo path, produces a report with contributor and file statistics
- JSON format flag outputs valid JSON
- Non-git-repo path produces a clear error message
- Since flag filters commits correctly
