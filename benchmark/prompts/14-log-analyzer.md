---
id: "14-log-analyzer"
title: "Web Server Log Analyzer"
category: cli
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "analyze_test_log"
    command: "printf '192.168.1.1 - - [15/Jan/2024:10:00:00 +0000] \"GET /index.html HTTP/1.1\" 200 1024\n192.168.1.2 - - [15/Jan/2024:10:01:00 +0000] \"GET /about.html HTTP/1.1\" 200 512\n192.168.1.1 - - [15/Jan/2024:10:02:00 +0000] \"POST /api/login HTTP/1.1\" 401 128\n' > /tmp/test-access.log && ./analyze /tmp/test-access.log"
    expected: "exit_0"
  - name: "output_report"
    command: "ls output/"
    expected: "contains:report"
---

# Web Server Log Analyzer

Build a CLI tool that parses Apache/Nginx-format access log files and produces a comprehensive report with statistics and ASCII charts.

## Requirements

### Core Features
1. **Log Parsing**: Parse standard Apache/Nginx combined log format entries
2. **Traffic Summary**: Total requests, unique IPs, date range covered
3. **Status Code Breakdown**: Count and percentage of each HTTP status code (200, 301, 404, 500, etc.)
4. **Top Pages**: Most requested URLs with hit counts
5. **Top IPs**: Most active IP addresses with request counts
6. **Hourly Traffic Chart**: ASCII bar chart showing requests per hour
7. **Error Analysis**: List of all 4xx and 5xx errors with URLs and frequency
8. **Output Report**: Write HTML and/or markdown report to output directory

### Technical Requirements
- Executable CLI tool
- Named `analyze`
- Parse Apache Combined Log Format: `%h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-agent}i"`
- Also support the simpler Common Log Format: `%h %l %u %t "%r" %>s %b`
- Handle large log files efficiently (streaming/line-by-line processing)
- Create an `output/` directory for reports

### CLI Interface
```
Usage: analyze <logfile> [options]

Arguments:
  logfile        Path to access log file (required)

Options:
  --output, -o   Output directory (default: ./output)
  --format       Report format: markdown, html, or both (default: both)
  --top          Number of top entries to show (default: 10)
  --help         Show help
```

### Report Contents
```markdown
# Access Log Report

## Summary
- Total requests: 15,234
- Unique IPs: 892
- Date range: 2024-01-01 to 2024-01-31
- Total bandwidth: 2.3 GB

## Status Codes
| Code | Count | Percentage |
|------|-------|------------|
| 200  | 12000 | 78.8%      |
| 301  | 1500  | 9.8%       |
| 404  | 1200  | 7.9%       |
| 500  | 534   | 3.5%       |

## Top 10 Pages
1. /index.html - 3,456 hits
2. /api/users - 2,100 hits
...

## Hourly Traffic
00:00 ████████ 234
01:00 ████ 120
02:00 ███ 89
...

## Errors
| URL | Status | Count |
|-----|--------|-------|
| /missing-page | 404 | 89 |
```

## Testable Deliverables
- `./analyze <logfile>` exits with code 0
- Report is generated in the output directory
- Report contains accurate status code counts
- Top pages and top IPs are correctly ranked
- ASCII hourly chart is generated
- Handles malformed log lines gracefully (skips with warning)
