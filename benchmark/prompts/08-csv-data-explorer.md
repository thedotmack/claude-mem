---
id: "08-csv-data-explorer"
title: "CSV Data Explorer TUI"
category: cli
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "help_flag"
    command: "./explore --help"
    expected: "exit_0"
---

# CSV Data Explorer TUI

Build a CLI tool that provides an interactive terminal user interface (TUI) for exploring CSV data files.

## Requirements

### Core Features
1. **CSV Parsing**: Load and parse any CSV file, auto-detecting delimiters and headers
2. **Table View**: Display data in a scrollable, paginated table with column headers
3. **Sorting**: Sort by any column (ascending/descending) with keyboard shortcuts
4. **Filtering**: Filter rows by column value (exact match, contains, greater/less than for numeric columns)
5. **Column Statistics**: Show summary statistics for selected column (count, min, max, mean, median for numeric; unique count, most common for text)
6. **Search**: Full-text search across all columns with highlighted matches
7. **Export**: Export filtered/sorted view to a new CSV file

### Technical Requirements
- Executable CLI tool
- Named `explore`
- Use a TUI library (blessed, ink, or similar) for the interactive interface
- Handle large files efficiently (stream parsing, virtual scrolling for display)
- Graceful handling of malformed CSV rows

### CLI Interface
```
Usage: explore <file.csv> [options]

Arguments:
  file.csv       Path to CSV file to explore (required)

Options:
  --delimiter    Column delimiter (default: auto-detect)
  --no-header    Treat first row as data, not headers
  --encoding     File encoding (default: utf-8)
  --help         Show help
```

### TUI Keyboard Shortcuts
- `Arrow keys` / `j/k` — Navigate rows
- `h/l` — Navigate columns (horizontal scroll)
- `s` — Sort by current column (toggle asc/desc)
- `f` — Open filter dialog
- `/` — Search
- `i` — Show column statistics
- `e` — Export current view
- `q` — Quit

### UI Layout
```
┌─ CSV Explorer: sales_data.csv ──────────────────────┐
│ Rows: 1,234 | Filtered: 890 | Sort: revenue DESC    │
├──────────────────────────────────────────────────────┤
│ id   │ name     │ revenue  │ date       │ region    │
│──────│──────────│──────────│────────────│───────────│
│ 1    │ Widget A │ $45,000  │ 2024-01-15 │ North     │
│ 2    │ Widget B │ $38,500  │ 2024-01-16 │ South     │
│ ...  │          │          │            │           │
├──────────────────────────────────────────────────────┤
│ [s]ort [f]ilter [/]search [i]nfo [e]xport [q]uit   │
└──────────────────────────────────────────────────────┘
```

## Testable Deliverables
- `./explore --help` exits with code 0 and shows usage information
- Tool loads a CSV file without crashing
- TUI renders with table headers and data rows
- Sort and filter functionality works on sample data
- Column statistics display correctly for numeric and text columns
