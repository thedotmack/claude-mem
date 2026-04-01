---
id: "07-markdown-site-generator"
title: "Markdown Static Site Generator"
category: cli
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "generate_site"
    command: "mkdir -p /tmp/test-docs && echo '# Hello World\nThis is a test page.' > /tmp/test-docs/test.md && ./generate /tmp/test-docs --output /tmp/test-site"
    expected: "exit_0"
  - name: "output_contains_html"
    command: "ls /tmp/test-site/"
    expected: "contains:html"
---

# Markdown Static Site Generator

Build a CLI tool that converts a directory of Markdown files into a complete, navigable static HTML website.

## Requirements

### Core Features
1. **Markdown to HTML**: Convert all `.md` files in the input directory (recursively) to HTML pages
2. **Template System**: Wrap each page in an HTML template with navigation header, sidebar, and footer
3. **Auto-Navigation**: Generate a sidebar navigation tree reflecting the directory structure
4. **Frontmatter Support**: Parse YAML frontmatter for `title`, `description`, `order` (for sorting in navigation)
5. **Syntax Highlighting**: Code blocks should have syntax highlighting (use a CSS-based approach like highlight.js or Prism)
6. **Static Assets**: Copy any non-markdown files (images, CSS, etc.) to the output directory preserving paths
7. **Index Pages**: Auto-generate index pages for directories listing their child pages

### Technical Requirements
- Executable CLI tool
- Named `generate`
- Use a markdown parsing library (marked, markdown-it, or similar)
- Generated HTML should be self-contained (inline CSS or bundled stylesheet)
- Output directory is created if it doesn't exist, and is wiped clean before generation

### CLI Interface
```
Usage: generate <input-dir> [options]

Arguments:
  input-dir      Directory containing markdown files (required)

Options:
  --output, -o   Output directory (default: ./site)
  --title        Site title for the header (default: "Documentation")
  --theme        Color theme: light or dark (default: light)
  --help         Show help
```

### Expected Directory Structure
```
Input:                    Output:
docs/                     site/
  getting-started.md  →     getting-started.html
  guides/                   guides/
    install.md        →       install.html
    config.md         →       config.html
    index.html (auto-generated)
  images/                   images/
    logo.png          →       logo.png
  index.html (auto-generated)
  styles.css (bundled)
```

### Generated HTML Features
- Responsive layout
- Navigation sidebar with collapsible sections matching directory hierarchy
- Breadcrumb trail
- Previous/Next page links
- Mobile-friendly hamburger menu for sidebar

## Testable Deliverables
- `./generate --help` exits with code 0
- Given a directory of markdown files, generates HTML files in the output directory
- Generated HTML files are valid and renderable
- Navigation sidebar reflects the directory structure
- Code blocks have syntax highlighting classes applied
- Non-markdown files are copied to output
