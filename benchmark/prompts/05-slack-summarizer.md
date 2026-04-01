---
id: "05-slack-summarizer"
title: "Slack Export Summarizer"
category: cli
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "help_flag"
    command: "./summarize --help"
    expected: "exit_0"
  - name: "summarize_test_export"
    command: "echo '[{\"channel\":\"general\",\"messages\":[{\"user\":\"alice\",\"text\":\"We need to ship the feature by Friday\",\"ts\":\"1700000000\"},{\"user\":\"bob\",\"text\":\"I can handle the frontend\",\"ts\":\"1700000060\"}]}]' > /tmp/test-export.json && ./summarize --input /tmp/test-export.json"
    expected: "contains:summary"
---

# Slack Export Summarizer

Build a CLI tool that takes a Slack export JSON file and produces structured markdown summaries of conversations.

## Requirements

### Core Features
1. **Parse Slack Export**: Accept a JSON file in Slack export format (array of channels, each with messages)
2. **Channel Summaries**: Generate a summary for each channel covering: key topics discussed, decisions made, action items identified
3. **Markdown Output**: Output well-formatted markdown with headings per channel, bullet points for topics, and a separate action items section
4. **Date Filtering**: Optional `--from` and `--to` flags to filter messages by date range
5. **Output File**: Optional `--output` flag to write to a file instead of stdout

### Technical Requirements
- Executable CLI tool (Node.js with shebang, or compiled binary)
- Named `summarize` (or `summarize.js` / `summarize.ts` with an executable wrapper)
- No external API calls required; summarization can use heuristics (keyword extraction, message clustering) or local logic
- Handle malformed JSON gracefully with clear error messages

### CLI Interface
```
Usage: summarize --input <path> [options]

Options:
  --input, -i    Path to Slack export JSON file (required)
  --output, -o   Path to output markdown file (default: stdout)
  --from         Start date filter (ISO 8601)
  --to           End date filter (ISO 8601)
  --help         Show help
```

### Expected Slack Export Format
```json
[
  {
    "channel": "general",
    "messages": [
      {
        "user": "alice",
        "text": "We need to ship the feature by Friday",
        "ts": "1700000000",
        "type": "message"
      }
    ]
  }
]
```

### Output Format
```markdown
# Slack Summary

## #general
### Key Topics
- Feature shipping deadline discussed

### Action Items
- Ship feature by Friday (mentioned by alice)

---
```

## Testable Deliverables
- `./summarize --help` exits with code 0 and prints usage
- Given a valid export JSON, produces markdown with channel summaries
- Date filtering limits messages included in summary
- Invalid JSON input produces a clear error message
- Output file flag writes to the specified path
