# Claude-Mem Feature Requests

Extracted from GitHub Discussions summaries.

## Priority Ranking

| Rank | Feature | Effort | Value | Notes |
|------|---------|--------|-------|-------|
| 1 | [Git Branch Metadata](#10-git-branch-metadata-tracking) | Low | High | Add one field to observation storage |
| 2 | [Multi-Language Support](#7-multi-language-support) | Low | High | Single setting + prompt tweak |
| 3 | [Plan File Persistence](#9-plan-file-persistence) | Low | High | Data already in hook response |
| 4 | [Project-Level Memory Disable](#11-project-level-memory-disable) | Low | High | Check for `.claude-mem.json` in hooks |
| 5 | [Bun Runtime for Hooks](#13-bun-runtime-for-hook-scripts) | Low | Medium | Already using Bun elsewhere |
| 6 | [Per-Session Context Skip](#12-per-session-context-injection-skip) | Low | Medium | Flag check in SessionStart hook |
| 7 | [Selective Forgetting](#4-selective-forgetting-gdpr-compliant-deletion) | Medium | High | Critical for long-term health, addresses memory rot |
| 8 | [Session-Level View](#14-session-level-view-in-web-ui) | Medium | High | Data exists, just needs UI grouping |
| 9 | [Cross-Project Search](#2-cross-project-pattern-search) | Medium | High | Remove project filter, add scope param |
| 10 | [Standalone CLI Tool](#5-standalone-cli-query-tool) | Medium | Medium | Useful but MCP skill already works |
| 11 | [Web Viewer Auth](#1-web-viewer-authentication) | Medium | Medium | Only matters if exposing to network |
| 12 | [Multiple Claude Aliases](#16-multiple-claude-alias-support) | Medium | Low | Edge case, few users affected |
| 13 | [Importance Scoring](#17-memory-importance-scoring--de-duplication) | High | Medium | Complex, contributor offered PR |
| 14 | [Analytics Dashboard](#6-learning-analytics-dashboard) | High | Low | Nice-to-have, not core functionality |
| 15 | [Conflict Detection](#3-conflict-detection-for-contradicting-decisions) | High | Low | Overengineered, semantic matching is hard |
| 16 | [Tool Execution Visibility](#8-toolskillmcp-execution-visibility) | High | Low | Claude Code should handle this, not plugin |
| 17 | [Auto CLAUDE.md Updates](#15-automatic-claudemd-updates) | High | Low | Risky, could corrupt project config |
| 18 | [Per-Project Memory Control](#18-per-project-memory-control) | - | - | Duplicate of #11 |

---

## 1. Web Viewer Authentication

**Discussion:** [#280](https://github.com/thedotmack/claude-mem/discussions/280)

**Description:** Add token-based or basic auth for the web viewer when exposed beyond localhost.

**Reasoning:** When `CLAUDE_MEM_WORKER_HOST=0.0.0.0`, all data is publicly accessible on the network - this is a security vulnerability exposing session observations, user prompts, project structure, and activity timelines.

**Additional Info:**

- Token-based auth recommended (auto-generate or user-defined)
- Rate limiting for brute force protection
- Login page UI needed
- Future HTTPS support consideration

---

## 2. Cross-Project Pattern Search

**Discussion:** [#281](https://github.com/thedotmack/claude-mem/discussions/281)

**Description:** Add `--global` or `--all-projects` flag to search observations across all projects instead of just the current project.

**Reasoning:** Current project-scoping prevents developers from leveraging learnings across their portfolio (authentication patterns, error handling strategies, database migrations from previous projects).

**Additional Info:**

- MCP tool extension with `scope` parameter
- Web viewer toggle for "All Projects" with project name badges
- Pattern library to identify recurring patterns
- Privacy concerns for sensitive projects need addressing

---

## 3. Conflict Detection for Contradicting Decisions

**Discussion:** [#282](https://github.com/thedotmack/claude-mem/discussions/282)

**Description:** Warn users when new decisions or implementations contradict previously documented decisions.

**Reasoning:** Developers document architectural decisions over time but later work may contradict earlier decisions due to forgotten context or changing requirements. No mechanism currently exists to detect these conflicts.

**Additional Info:**

- Decision tracking by category (architecture, technology choices, conventions, security)
- Use existing Chroma embeddings for semantic similarity detection
- Conflict resolution metadata (supersede, exception, cancel)
- Configurable sensitivity thresholds

---

## 4. Selective Forgetting (GDPR-Compliant Deletion)

**Discussion:** [#283](https://github.com/thedotmack/claude-mem/discussions/283)

**Description:** Add CLI commands and Web UI to selectively delete observations, sessions, and prompts by topic, date range, project, or custom criteria.

**Reasoning:** No granular deletion capability exists. Users need to delete data for GDPR/privacy compliance, cleanup, mistakes, accidentally captured credentials, or storage management.

**Additional Info:**

- `claude-mem forget` CLI with filters and dry-run mode
- Web Viewer "Manage Data" section with bulk delete
- Cascade handling: remove from SQLite, FTS5 index, Chroma embeddings
- Export-before-delete option, audit logging
- Community notes this addresses "memory rot" from append-only architecture

---

## 5. Standalone CLI Query Tool

**Discussion:** [#284](https://github.com/thedotmack/claude-mem/discussions/284)

**Description:** `claude-mem` CLI tool to query the memory database without starting a full Claude Code session.

**Reasoning:** Currently requires starting Claude Code, using mem-search skill/MCP tools, and waiting for context injection just to perform quick memory lookups - excessive overhead for simple queries.

**Additional Info:**

- Quick searches with filters (project, type)
- Interactive REPL mode for sequential queries
- Multiple output formats: human-readable, JSON, markdown, one-line
- Shell integration examples (fzf, jq, aliases)
- Implementation options: Bun script, compiled binary, or Worker API client

---

## 6. Learning Analytics Dashboard

**Discussion:** [#285](https://github.com/thedotmack/claude-mem/discussions/285)

**Description:** Add an "Analytics" tab in the web viewer with activity heatmaps, metrics, and trends.

**Reasoning:** Users accumulate observations but lack visibility into work patterns, productivity trends, topics they work on most, and their most valuable learnings.

**Additional Info:**

- Activity heatmap visualization
- Metrics: observations/sessions per period, distribution by type/concept
- Week-over-week and month-over-month trends
- Automated insights engine ("You fixed 40% more bugs this week")
- Export as PDF/PNG, optional weekly email digest

---

## 7. Multi-Language Support

**Discussion:** [#286](https://github.com/thedotmack/claude-mem/discussions/286)

**Description:** Add `CLAUDE_MEM_LANGUAGE` configuration setting to output observations and summaries in the user's preferred language.

**Reasoning:** Observations and summaries are currently hardcoded to English output, which is not ideal for non-English users (Korean, Japanese, etc.).

**Additional Info:**

- Requires modifications to prompt engineering in observation/summary generation logic
- Setting would go in `~/.claude-mem/settings.json`

---

## 8. Tool/Skill/MCP Execution Visibility

**Discussion:** [#287](https://github.com/thedotmack/claude-mem/discussions/287)

**Description:** Show which tools, skills, and MCP servers ran during each response, including chronological order of operations.

**Reasoning:** No visibility into execution trace - needed for transparency and debugging capabilities.

**Additional Info:**

- Show which skills were read/invoked
- Show which MCP servers were called
- Show which hooks fired during execution
- Chronological ordering of operations

---

## 9. Plan File Persistence

**Discussion:** [#288](https://github.com/thedotmack/claude-mem/discussions/288)

**Description:** Capture and retrieve plan file paths from Claude Code's plan mode across sessions.

**Reasoning:** Claude Code creates temporary plan files in `~/.claude/plans/*.md` during plan mode, but references aren't persisted across sessions, making it difficult to continue previous planning work.

**Additional Info:**

- `ExitPlanMode` hook response contains the plan file path
- Store path, content, session_id, and timestamp
- Add query capability via `get_last_plan` tool or extended search filters

---

## 10. Git Branch Metadata Tracking

**Discussion:** [#289](https://github.com/thedotmack/claude-mem/discussions/289)

**Description:** Store the active git branch as observation metadata.

**Reasoning:** Enable branch-specific context filtering and better understanding of work done on different branches.

**Additional Info:**

- Minimal description in original discussion
- Would add branch field to observation storage

---

## 11. Project-Level Memory Disable

**Discussion:** [#297](https://github.com/thedotmack/claude-mem/discussions/297)

**Description:** Add `.claude-mem.json` config file in project root to disable or customize memory capture on a per-project basis.

**Reasoning:** Developers working on multiple projects need to disable memory capture for specific projects containing sensitive data or temporary experiments, without affecting global settings.

**Additional Info:**

- Simple disable: `{ "enabled": false, "reason": "..." }`
- Granular control: enable/disable observations, sessions, prompts independently
- Alternative: global `ignoredProjects` array in settings.json
- Aligns with industry standards (`.gitignore`, `.npmrc`)

---

## 12. Per-Session Context Injection Skip

**Discussion:** [#322](https://github.com/thedotmack/claude-mem/discussions/322)

**Description:** Add opt-out mechanism to skip context injection for individual sessions.

**Reasoning:** Users want to explore ideas from scratch without bias, work on sensitive/experimental tasks without past memory influence, or temporarily opt out without uninstalling.

**Additional Info:**

- Default behavior unchanged
- Currently no visible/documented way to disable injection per session
- Would improve trust, flexibility, and usability for exploratory workflows

---

## 13. Bun Runtime for Hook Scripts

**Discussion:** [#328](https://github.com/thedotmack/claude-mem/discussions/328)

**Description:** Use Bun as the primary runtime for executing hook scripts, with Node.js as fallback.

**Reasoning:** Leverage Bun's performance benefits for hook script execution.

**Additional Info:**

- Currently hooks execute using Node.js
- Project already uses Bun for worker service
- Try Bun first, fall back to Node.js if unavailable

---

## 14. Session-Level View in Web UI

**Discussion:** [#337](https://github.com/thedotmack/claude-mem/discussions/337)

**Description:** Add session-based navigation in the web UI as an alternative to the continuous observation stream.

**Reasoning:** Current continuous stream makes it difficult to review specific work sessions.

**Additional Info:**

- List view of sessions with metadata (timestamp, observation count, summary)
- Click-through navigation to view all observations within a session
- Hierarchical session list showing chronological sessions

---

## 15. Automatic CLAUDE.md Updates

**Discussion:** [#349](https://github.com/thedotmack/claude-mem/discussions/349)

**Description:** Automatically update CLAUDE.md files based on important data gathered during sessions.

**Reasoning:** Automate the process of capturing and documenting important project learnings and rules.

**Additional Info:**

- Identify important information from conversations
- Separate important data and add relevant rules to CLAUDE.md
- Author believes technically feasible based on existing data

---

## 16. Multiple Claude Alias Support

**Discussion:** [#351](https://github.com/thedotmack/claude-mem/discussions/351)

**Description:** Support custom Claude directories (`.claude-work`, `.claude-personal`) instead of hardcoding `.claude`.

**Reasoning:** Users running multiple Claude Code instances with directory-based aliases find the plugin incorrectly looks for configuration in the default `.claude` directory.

**Additional Info:**

- Add config option for specifying root directory name
- Or auto-detect current directory instead of assuming `.claude`
- Additional npm install issues with `NODE_ENV=production`

---

## 17. Memory Importance Scoring & De-duplication

**Discussion:** [#365](https://github.com/thedotmack/claude-mem/discussions/365)

**Description:** Implement importance scoring and de-duplication for stored observations.

**Reasoning:** Similar/repeated observations accumulate over time, all stored with equal weight, creating noise and reducing relevance of injected context.

**Additional Info:**

- Scoring hierarchy: Decisions (highest) > Writes > Reads > Informational (lowest)
- Hash or similarity-based de-duplication
- Prefer higher-value memories during context injection
- Author willing to implement and submit PR

---

## 18. Per-Project Memory Control

**Discussion:** [#110](https://github.com/thedotmack/claude-mem/discussions/110)

**Description:** Enable/disable memories per repository, per-feature memory configuration.

**Reasoning:** Context pollution between projects in multi-project workflows. Memory from different projects bleeds into unrelated chats.

**Additional Info:**

- User's workflow: `root > projects > category > [project_root]`
- Nested structure exacerbates context pollution
- Related to #297 (Project-Level Memory Disable)
