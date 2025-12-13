---
name: mem-search
description: Search your persistent memory database from previous coding sessions. Use when asked about past work, decisions, bugs fixed, or development history.
---

## Overview

Search your local memory database for past sessions, decisions, code changes, and development history. This skill uses the `mem-search` MCP server tools.

## Available MCP tools

Use these tools from the `mem-search` MCP server:

| Tool | Description |
|------|-------------|
| `search` | Unified search across all memory types |
| `decisions` | Find architectural/design decisions |
| `changes` | Find code changes and refactorings |
| `timeline` | Get observations around a specific point in time |
| `find_by_file` | Find observations for specific files |
| `find_by_type` | Filter by type (decision, bugfix, feature, refactor, discovery, change) |
| `find_by_concept` | Find by concept tags |
| `how_it_works` | Understand system architecture and design patterns |

## Common parameters

- `query` - Natural language search query
- `limit` - Max results (1-100, default 20)
- `format` - `index` for titles only (recommended), `full` for complete content
- `type` - Filter: observations, sessions, or prompts
- `obs_type` - Filter observation type: decision, bugfix, feature, refactor, discovery, change

## When to use

- "Did we already solve this?"
- "How did we do X last time?"
- "Find the bug fix for..."
- "What decisions did we make about..."
- "Show me changes to [file]"
- "What work did we do on [project]?"

## Setup requirement

The `mem-search` MCP server must be configured in Claude Desktop settings. See MCP configuration docs.
