## Summary of GitHub Discussion #8

**Title:** Welcome to claude-mem Discussions!

**Author:** thedotmack

**Created:** October 23, 2025

**Main Topic:** 
This is the default welcome discussion for the GitHub Discussions feature, serving as an introduction and community guidelines post.

**Key Points:**
- Welcomes community members to use Discussions for connecting with each other
- Encourages users to:
  - Ask questions
  - Share ideas
  - Engage with other community members
  - Be welcoming and open-minded
- Invites users to introduce themselves in the comments

**Current Status:**
- No comments or responses yet
- This is a standard GitHub Discussions welcome template with boilerplate content
- Contains maintainer tips (in HTML comments) for managing discussions, including announcing the feature, linking issue templates to discussions, and converting existing issues to discussions

**Resolution/Action Items:**
None - this is an open-ended welcome post with no specific action items or issues to resolve.

--- RESULT ---
## Summary of GitHub Discussion #9

**Title:** Claude-Mem v5.0 Skills Integration Guide

**Author:** thedotmack

**Created:** October 23, 2025

**Main Topic:**
A comprehensive implementation guide for integrating Claude Code's Agent Skills architecture into claude-mem to solve context window degradation issues through progressive disclosure of complex memory processing logic.

**Key Points Raised:**

1. **Problem Being Solved:** Context window degradation when complex classification/deduplication logic competes with actual development work in long sessions

2. **Skills Architecture Benefits:**
   - Progressive disclosure: metadata loads initially (~400 tokens for 4 skills), full instructions only when triggered (2-5K tokens per skill)
   - Supporting files load as needed
   - Maintains instruction integrity even in long sessions

3. **Proposed Skill Structure (4 core skills):**
   - **Observation Classifier**: Classify tool executions into 6 types (bugfix, feature, refactor, change, discovery, decision)
   - **Memory Deduplicator**: Search existing memory before creating new observations to prevent redundancy
   - **Summary Intelligence**: Generate intelligent session summaries focused on deliverables
   - **Memory Orchestrator**: Coordinate the complete memory pipeline across all other skills

4. **Implementation Phases:**
   - Phase 1: Add `plugin/skills/` directory structure
   - Phase 2: Create 4 core skill SKILL.md files with supporting documents
   - Phase 3: Refactor hooks to delegate complex logic to skills
   - Phase 4: Remove embedded prompts, reduce context footprint
   - Phase 5: Testing and validation
   - Phase 6: Gradual migration with feature flags
   - Phase 7: Release as v5.0.0

5. **Key Architectural Change:**
   - Move from embedded prompts (200+ lines) to skill-delegated decisions
   - Hooks become simple orchestrators that ask Claude to use specific skills
   - Complex logic (classification rules, concept taxonomy, search strategies) moves into skill files

**Resolution/Action Items:**
- This is a planning document/guide, not a discussion thread (0 comments)
- Represents a roadmap for a major v5.0.0 release
- No implementation has occurred yet based on the document being from October 2025
- The guide is self-contained with complete implementation examples

**Notable Details:**
- Includes concrete code examples for skill definitions and hook refactoring
- References official Anthropic documentation on Agent Skills
- Proposes backward compatibility strategy during transition
- Emphasizes "deliverables over observations" in summary generation

--- RESULT ---
## Summary of GitHub Discussion #35

**Title:** "Why Typescript and not Python"

**Author:** kyp0717

**Created:** October 30, 2025

**Main Topic:** 
The author is expressing interest in the claude-mem project and asking about the technical decision to use TypeScript instead of Python for the plugin implementation.

**Key Points:**
- Author wants to learn more about the project and potentially contribute in the future
- Expresses curiosity about the language choice (TypeScript vs Python)
- Notes they have no personal preference between the two languages

**Status:**
- **No responses yet** - The discussion has no comments as of the query
- **No resolution** - Question remains unanswered
- **Action Item:** This appears to be an open question that could benefit from a response explaining the architectural reasons for TypeScript (e.g., Claude Code plugin ecosystem compatibility, SDK requirements, build tooling, etc.)

This is a common question for new contributors trying to understand the project's technical stack. Given the project's architecture (TypeScript hooks, ESM builds, Node.js build tools), a response explaining that Claude Code plugins are built on the Claude Agent SDK which uses TypeScript would likely be helpful.

--- RESULT ---
## Summary of GitHub Discussion #92

**Title:** Feature Proposal: Optional Lazy Memory Analysis Mode for Token Efficiency

**Author:** orgoj

**Created:** November 11, 2025

### Main Topic
A proposal for an optional "lazy memory analysis" mode that would reduce token consumption by 80-90% by shifting from real-time AI processing to on-demand analysis.

### Key Points Raised

**Proposed Changes:**
1. **Metadata-only storage** - Store raw tool data instead of immediately processing with AI
2. **On-demand analysis** - Only analyze sessions when explicitly requested or searched
3. **Optional context injection** - Disable automatic context at session start
4. **Token efficiency** - AI processing only for sessions that are actually used

**Configuration approach:**
```json
{
  "CLAUDE_MEM_MODE": "default|lazy",
  "CLAUDE_MEM_AUTO_CONTEXT": "true|false",
  "CLAUDE_MEM_COMPACT_ANALYSIS": "true|false"
}
```

**Benefits cited:**
- Massive token cost reduction (80-90%)
- Faster session starts
- User control over when analysis happens
- Smaller storage footprint

**Trade-offs acknowledged:**
- Delayed structuring
- Less automatic/magical experience
- First-search latency
- Implementation complexity

### Response & Resolution

**thedotmack (maintainer) response:**

**Not convinced of the need** - Points out that lazy mode can already be achieved by text-searching the existing `.jsonl` transcript files through scripting, questioning what additional value this would provide.

**Alternative insight from transcript search experiment:**
- Importing raw JSONL transcripts into SQLite enables super-fast full-text search
- Even chunking by word groups (no semantic processing) into Chroma gives impressive results
- Not as good as linked semantic data, but surprisingly effective

**Partial agreement:**
- **Does NOT support** full lazy mode implementation
- **DOES agree** on the need for **granular controls** in settings for context injection and other features
- Users should have control over individual components with clear descriptions of gains/losses

**Architecture context provided:**
Referenced the evolution from a "layered memory system" concept:
- Layer 1: Flat-file index of titles + data locations
- Layer 2: Summarized data (what claude-mem implemented)
- Layer 3: Full transcript search (deemed unnecessary)

### Action Items
- Add granular user controls for context injection and memory features
- Provide clear documentation on feature trade-offs
- No immediate plans to implement full lazy mode

**Status:** Proposal declined in its full form, but inspired refinement toward more granular user controls.

--- RESULT ---
## Summary: GitHub Discussion #110 - Claude-Mem Feedback

**Title:** Claude-Mem Feedback

**Author:** @thedotmack

**Created:** November 14, 2025

**Main Topic:** 
A general feedback thread for the Claude-Mem project, inviting both positive and negative feedback from the community.

**Key Points Raised:**

1. **Context Pollution Issue** (@felores):
   - Problem: Memory context from different projects/areas bleeding into unrelated chats
   - Specific pain point: Using Claude Code in a "second brain root" directory where all projects are managed causes every new chat to get polluted with unrelated memories
   - Example: Working on frontend and backend simultaneously in separate instances causes cross-contamination of context

2. **Feature Requests** (@felores):
   - Per-project memory configuration/tweaking
   - Per-feature memory enablement
   - Ability to enable/disable memories per repository
   - Ability to deactivate Claude-Mem on a per-project basis

3. **Directory Structure Context** (@felores):
   - User's workflow: `root > projects > category > [project_root]`
   - This nested structure exacerbates the context pollution problem

**Resolution/Action Items:**
- No resolution posted yet
- Feature requests identified: per-project memory control and repository-level enable/disable toggle
- Core problem: Need for better memory scoping/isolation between different projects and work contexts

This appears to be an active usability issue affecting users who work across multiple projects simultaneously or use Claude Code for diverse purposes (development + personal knowledge management).

--- RESULT ---
## Summary: GitHub Discussion #129

**Title:** Worker service not starting on fresh install

**Author:** dreamiurg

**Created:** November 18, 2025

**Main Topic:**
Fresh installations of claude-mem fail because the worker service isn't automatically started. Users encounter errors asking them to run `pm2 restart claude-mem-worker`, which doesn't work since the process was never started initially.

**Key Points:**

1. **Root Cause:** The `smart-install.js` script only installs dependencies but doesn't start the worker service, despite a comment suggesting lazy startup would occur
2. **Error Flow:** Plugin hooks call `ensureWorkerRunning()` which fails and suggests running `pm2 restart` - unhelpful for fresh installs
3. **Manual Workaround:** Users must manually run `pm2 start ecosystem.config.cjs` from the plugin directory
4. **Additional Issue:** PM2 isn't in PATH since it's a local dependency, requiring `npx pm2` or direct node_modules/.bin invocation

**Proposed Solutions:**

- **Quick fix:** Update error message to suggest `pm2 start` instead of `pm2 restart`
- **Better fix:** Auto-start worker in `smart-install.js` after dependency installation
- **Alternative:** Implement lazy startup in `ensureWorkerRunning()` function
- **Documentation:** Add worker startup instructions to README

**Resolution/Action:**
User dreamiurg created PR #130 with a fix that handles both auto-starting the worker and properly invoking the local PM2 installation.

**Environment:** macOS, Node v25.1.0, plugin version 5.5.1

--- RESULT ---
## Summary of GitHub Discussion #137

**Title:** Does it work with `mise`?

**Author:** marr  
**Created:** 2025-11-19

**Main Topic:**  
Compatibility issue between claude-mem plugin and `mise` package manager (https://mise.jdx.dev/), which manages multiple versions of node, python, etc.

**Key Points Raised:**

1. **Problem Description:**
   - User has Node 22 running via mise
   - Plugin installs successfully
   - Worker service fails to start with better-sqlite3 version error
   - Error: `NODE_MODULE_VERSION 127` (current) vs `NODE_MODULE_VERSION 137` (required)
   - Attempted fixes (`npm rebuild`, `npm install`) did not resolve the issue

2. **Response from thedotmack (Project Maintainer):**
   - Acknowledged the issue is "not great"
   - Expressed curiosity about mise use case, seeing it as potential added complexity
   - Suggested mise should theoretically work fine for setting environment
   - Asked for clarification on whether mise is being used to simplify dev environment

**Resolution/Action Items:**
- No resolution yet - discussion appears to be in early stages
- Maintainer is seeking to understand the use case better
- The NODE_MODULE_VERSION mismatch suggests a binary compatibility issue between the Node version used to compile better-sqlite3 and the runtime Node version
- Potential action: Investigation needed into how mise affects native module compilation for claude-mem's dependencies

**Technical Context:**  
The error indicates better-sqlite3 was compiled for Node.js version with MODULE_VERSION 137 (Node 22.x), but is running against a version with MODULE_VERSION 127 (Node 18.x or 19.x), suggesting a version mismatch despite the user reporting Node 22.

--- RESULT ---
## Summary of GitHub Discussion #156

**Title**: Auto-session → respawn when tokens are exhausted

**Author**: jmvl

**Created**: December 1, 2025

### Main Topic
The discussion addresses the problem of Claude Code sessions approaching the ~200K token context limit, which causes performance degradation, loss of conversation context, and requires manual session management that loses working context (todos, in-progress work).

### Key Points Raised

**Problem Statement** (by jmvl):
- Sessions degrade as they approach token limits
- Users must manually recognize and restart sessions
- New sessions lose working context and require manual retrieval
- Incomplete task handoff occurs in ~30% of respawns

**Proposed Solution** (by jmvl):
- Token Monitor Service using heuristics
- Respawn State Table in SQLite for todos and in-flight work
- Enhanced Context Hook for continuation
- Respawn Orchestrator for graceful handoffs
- Threshold alerts at 85%, 90%, 95% capacity
- Auto-spawn functionality (configurable)

### Resolution/Action Items

**Response from thedotmack** (project maintainer):
1. **Claude-mem already handles this** - The existing architecture supports session continuity
2. **New customization features added** - Fine-tuned session start context options now available in UI (localhost:37777)
3. **Settings updates pushed** - Users can customize startup messages and context inclusion
4. **Recommended tool** - Suggested using ccstatusline for context monitoring (https://github.com/sirmalloc/ccstatusline)
5. **Ongoing improvements** - Adding options for full observations at session start with live preview coming soon
6. **Reference to "endless mode"** - Existing experimental feature for continuous sessions

**Outcome**: The requested functionality essentially already exists in claude-mem's architecture. The maintainer enhanced the UI with additional customization options to give users more control over session start context, addressing the core concerns without needing the proposed new architecture.

--- RESULT ---
## Summary of GitHub Discussion #202

**Title:** Hi

**Author:** Vadimaxx

**Created:** December 9, 2025

**Main Topic:** This appears to be a minimal greeting/test discussion with no substantial content.

**Key Points Raised:**
- The discussion body contains only "Hi" with no additional context or questions
- No comments have been posted in response
- No specific issues, feature requests, or technical topics are discussed

**Resolution/Action Items:**
- None - this discussion does not contain any actionable items or require resolution
- It appears to be either a test post or an incomplete discussion that was never developed further

**Note:** This is effectively an empty discussion thread that may have been created accidentally or as a test. There is no meaningful technical content or community discussion to summarize.

--- RESULT ---
## Summary of GitHub Discussion #222

**Title**: Working on my remote control

**Author**: danieloshinusi92-maker

**Created**: December 10, 2025

**Main Topic**: The discussion appears to be about remote control functionality related to tools and creation capabilities.

**Key Points**:
- The initial post mentions "Remote controls tools and create with me"
- The description is brief and somewhat unclear in its intent

**Comments**: No comments have been posted on this discussion yet.

**Resolution/Action Items**: None identified. The discussion appears to be newly created with no follow-up activity or clarification from the author or community members.

**Note**: This discussion is quite brief and lacks detail. It may be awaiting further clarification from the author about what specific remote control functionality they're working on or need help with in the context of claude-mem.

--- RESULT ---
## Summary of GitHub Discussion #235

**Title:** How to uninstall

**Author:** sc-mcano

**Created:** December 11, 2025

**Main Topic:**
User inquiring about the uninstallation process for claude-mem and whether uninstalling would remove SQLite 3.

**Key Points:**

1. **User Concern:** The user wants to try claude-mem but is seeking information about how to uninstall it before installation, specifically concerned about SQLite 3 removal.

2. **Maintainer Response (thedotmack):**
   - The latest version no longer requires the `better-sqlite3` dependency
   - Manual cleanup can be done in `~/.claude/plugins/marketplaces/thedotmack/` where `node_modules` contains better-sqlite3 (for older versions)
   - The new system uses Bun, which has built-in SQLite functionality
   - Several dependencies were removed: `pm2`, `better-sqlite3`
   - Performance improvements were made
   - Bun was added as a new dependency (officially recommended by Anthropic)
   - The changes resolved issues with pm2 on Windows and better-sqlite3

**Resolution:**
The maintainer explained that the newer version has simplified dependencies and provided manual cleanup instructions. The concern about SQLite 3 is addressed by the fact that newer versions use Bun's built-in SQLite rather than better-sqlite3 as a separate dependency.

**Action Items:**
None explicit - informational discussion providing uninstall guidance and explaining architectural changes.

--- RESULT ---
## Summary of GitHub Discussion #280

**Title:** feat: Add optional authentication for web viewer when exposed to network

**Author:** github-actions (bot) - Originally posted as issue #266 by @informatJonas

**Created:** December 13, 2025

**Main Topic:**
Security vulnerability when exposing the claude-mem web viewer to the network. When `CLAUDE_MEM_WORKER_HOST` is set to `0.0.0.0`, the viewer becomes accessible to anyone on the network without authentication, exposing sensitive data including session observations, user prompts, project structure, and activity timelines.

**Key Points:**

1. **Security Risk:** Current implementation has no authentication when exposed beyond localhost, making all data publicly accessible on the network

2. **Proposed Solutions:**
   - **Option 1 (Recommended): Token-based Auth**
     - Auto-generate or user-define tokens
     - Token passed via query param or Authorization header
     - Cookie-based sessions for convenience
   
   - **Option 2: Basic Auth**
     - Username/password authentication

3. **Implementation Details:**
   - Add middleware in `worker-service.ts`
   - Auto-enable suggestion when `WORKER_HOST` is set to `0.0.0.0`
   - Login page in web viewer UI
   - Validate credentials on all routes except `/health`

4. **Use Cases:**
   - Accessing viewer from mobile devices on same network
   - Multi-workstation environments
   - Team settings with shared networks

5. **Security Considerations:**
   - Cryptographically random tokens (32+ chars)
   - Rate limiting for brute force protection
   - Documentation warnings about network exposure
   - Future HTTPS support consideration

**Status:** No comments yet - appears to be an open feature request awaiting implementation.

**Action Items:**
- Implement authentication middleware
- Add configuration options to settings.json
- Create login UI for web viewer
- Update documentation with security warnings
- Consider rate limiting and HTTPS for future versions

--- RESULT ---
## Summary of GitHub Discussion #281

**Title:** feat: Cross-project pattern search and knowledge transfer

**Author:** github-actions (originally posted as issue #267 by @informatJonas)

**Created:** December 13, 2025

**Main Topic:**  
Enable searching observations across all projects to find patterns and solutions from other codebases, rather than limiting searches to the current project scope.

**Key Points Raised:**

1. **Current Limitation:** Observations are project-scoped, preventing developers from leveraging learnings across their portfolio (e.g., authentication patterns, error handling strategies, database migrations from previous projects)

2. **Proposed Solutions:**
   - **Cross-Project Search Flag:** Add `--global` or `--all-projects` flag to search operations
   - **MCP Tool Extension:** Add `scope` parameter ("global" vs "current-project") to search tool
   - **Web Viewer Enhancement:** Toggle for "All Projects" with project name badges on results
   - **Pattern Library:** Automatically identify recurring patterns across projects (similar observations, common file types, repeated decisions)

3. **Use Cases:**
   - New project bootstrap ("Show me how I've structured APIs before")
   - Consistency checking ("What naming conventions have I used?")
   - Learning from past bugs ("What async/await bugs have I fixed?")
   - Knowledge sharing between client projects

4. **Implementation Considerations:**
   - Project name disambiguation
   - Privacy concerns for sensitive projects
   - Index optimization for cross-project queries
   - Clear UI indication of project context in results

**Status:** No comments yet on the discussion. No resolution or action items assigned. This appears to be a feature request that has been converted from an issue to a discussion for community input.

--- RESULT ---
## Summary of GitHub Discussion #282

**Title:** feat: Conflict detection for contradicting decisions

**Author:** github-actions (originally posted as issue #268 by @informatJonas)

**Created:** December 13, 2025

**Main Topic:**
This discussion proposes adding conflict detection capabilities to claude-mem to warn users when new decisions or implementations contradict previously documented decisions.

**Key Points Raised:**

1. **Problem Statement:** 
   - Developers document architectural decisions as observations over time
   - Later work may contradict earlier decisions due to forgotten context or changing requirements
   - Currently no mechanism to detect these conflicts

2. **Proposed Solution Components:**
   - **Decision Tracking:** Tag observations by category (architecture, technology choices, conventions, security)
   - **Conflict Detection Engine:** Compare new observations against existing decisions and warn about potential conflicts
   - **Semantic Similarity:** Use vector embeddings (Chroma) to detect semantic conflicts beyond keyword matching
   - **Conflict Resolution:** Store metadata tracking how conflicts were resolved (supersede, exception, cancel)

3. **Use Cases:**
   - Maintain architectural consistency
   - Team alignment across sessions
   - Track decision evolution history
   - Aid code review by surfacing conflicts early

4. **Implementation Notes:**
   - Leverage existing Chroma embeddings for semantic comparison
   - Configurable sensitivity thresholds
   - Optional disable for specific observation types

**Resolution/Action Items:**
No comments or resolution yet - this is a feature proposal awaiting community discussion and potential implementation. The discussion has no responses as of December 13, 2025.

--- RESULT ---
## Summary of GitHub Discussion #283

**Title**: "feat: Selective forgetting (GDPR-compliant data deletion)"

**Author**: github-actions (bot, converted from issue #269 by @informatJonas)

**Created**: December 13, 2025

**Main Topic**: Adding the ability to selectively delete observations, sessions, and prompts from claude-mem by topic, date range, project, or custom criteria.

### Key Points Raised

**The Problem**:
- No granular deletion capability currently exists
- Users need to delete data for GDPR/privacy compliance, cleanup, mistakes, or storage management
- Specific use cases include removing client data, outdated observations, accidentally captured credentials, and reducing database size

**Proposed Solution** includes:

1. **CLI Commands** - `claude-mem forget` with filters for topic, date ranges, project, type, and dry-run mode
2. **Web Viewer UI** - "Manage Data" section with search, bulk delete, export-before-delete, and confirmation dialogs
3. **MCP Tool** - Programmatic access to deletion functionality
4. **Deletion Workflow** - 5-step process: Search → Preview → Confirm → Delete → Log
5. **Cascade Handling** - Remove from SQLite, FTS5 index, Chroma embeddings, update session summaries
6. **Privacy Features** - Secure delete, export first, audit logging, no undo with clear warnings

### Community Feedback

**@pascalandy** (December 16, 2025) emphasized the critical nature of this feature:
- Current append-only approach causes "memory rot" that reduces reliability over time
- Progressive disclosure system makes it worse - bad memories get buried but never removed, actively misleading the AI when searched
- Referenced related issues: #249 (Memory Invalidation Mechanism) and #269 (original issue)
- Current workarounds are manual SQLite queries, export/import scripts, or disabling the project entirely
- Both capture AND curation are essential for sustainable memory systems

### Action Items

No explicit resolution yet - this appears to be a feature proposal awaiting implementation. The discussion highlights a critical gap in the current architecture that affects long-term reliability and compliance requirements.

--- RESULT ---
## Summary of GitHub Discussion #284

**Title:** feat: Standalone CLI query tool

**Author:** github-actions (bot) - originally posted as issue #270 by @informatJonas

**Created:** December 13, 2025

**Main Topic:**
Adding a standalone CLI tool to query claude-mem's persistent memory database without needing to start a full Claude Code session.

**Key Points:**

1. **Problem Identified:** Currently requires starting Claude Code, using mem-search skill/MCP tools, and waiting for context injection just to perform quick memory lookups - excessive overhead for simple queries.

2. **Proposed CLI Tool (`claude-mem`):** Command-line interface with capabilities for:
   - Quick searches with filters (project, type)
   - Recent observations listing
   - Timeline queries around specific dates
   - Session summaries
   - Specific observation retrieval
   - Export functionality (markdown/JSON formats)

3. **Interactive Mode:** REPL-style interface for sequential queries without restarting the tool.

4. **Multiple Output Formats:** Human-readable (default), JSON (scripting), markdown (documentation), and one-line format for piping to other tools.

5. **Integration Examples:** Demonstrates piping to fzf, using in scripts with jq, and creating shell aliases for quick access.

6. **Implementation Options Proposed:**
   - **Option A:** Bun script with package.json bin entry
   - **Option B:** Compiled binary using `bun build --compile`
   - **Option C:** Worker API client (requires running worker)

7. **Use Cases:** Quick lookups, shell script automation, documentation export, work review without starting Claude.

**Status:**
No comments on the discussion yet - appears to be awaiting community feedback or maintainer response. No resolution or action items assigned at this time.

--- RESULT ---
## Summary of GitHub Discussion #285

**Title:** feat: Learning analytics dashboard

**Author:** github-actions (originally posted as issue #271 by @informatJonas)

**Created:** December 13, 2025

**Main Topic:** 
Adding an analytics dashboard to the claude-mem web viewer to provide insights about captured observations over time.

**Key Points:**

1. **Problem Statement:**
   - Users accumulate observations but lack visibility into work patterns, productivity trends, topics they work on most, and their most valuable learnings

2. **Proposed Solution Components:**
   - **Dashboard Overview:** New "Analytics" tab in the web viewer with time-period filtering
   - **Activity Heatmap:** Visual representation of when users are most active
   - **Key Metrics Display:** Observations count, sessions, averages with period-over-period comparisons

3. **Metrics to Track:**
   - Activity: observations/sessions per time period, session duration
   - Content: distribution by observation type (bugfix, feature, etc.) and concept (how-it-works, gotcha, etc.)
   - Trends: week-over-week and month-over-month growth, moving averages

4. **Additional Features:**
   - Automated insights engine ("You fixed 40% more bugs this week")
   - Export analytics as PDF/PNG
   - Optional weekly email digest
   - Date range selectors (7d, 30d, 90d, all time)

5. **Implementation Approach:**
   - Leverage existing observation data
   - No additional tracking required
   - Cached calculations for performance

**Resolution/Action Items:**
- No comments or resolution yet
- This appears to be an open feature request awaiting discussion/implementation
- The proposal is well-detailed with UI mockups and specific metrics to track

This feature request aligns with claude-mem's goal of helping users track and leverage their learning over time, adding a meta-layer of insights about the captured knowledge itself.

--- RESULT ---
## Summary of GitHub Discussion #286

**Title:** Support for multi language

**Author:** github-actions (originally posted as issue #228 by @2ykwang)

**Created:** December 13, 2025

**Main Topic:**
The discussion requests support for multiple languages in claude-mem. Currently, observations and summaries are always written in English, which is not ideal for non-English users.

**Key Points:**
- Observations and summaries are currently hardcoded to English output
- Non-English users (Korean, Japanese, etc.) would benefit from native language support
- Suggested implementation approach: Add a `CLAUDE_MEM_LANGUAGE` configuration setting to control the output language

**Status:**
- No comments yet on the discussion
- No resolution or action items documented
- This appears to be a feature request that was converted from issue #228 to discussion format

**Context:**
This would require modifications to the prompt engineering in the observation and summary generation logic to respect a language preference setting, likely in the `~/.claude-mem/settings.json` configuration file.

--- RESULT ---
## Summary of GitHub Discussion #287

**Title:** [FEATURE] Show which tools/skills/MCPs ran during a response

**Author:** github-actions (originally posted as issue #194 by @Rylaa)

**Created:** December 13, 2025

**Main Topic:** 
Feature request to add visibility into tool/skill/MCP execution details within the claude-mem interface.

**Key Points Raised:**
The request is to add execution metadata to each response bubble showing:
- Which skills were read/invoked
- Which MCP servers were called
- Which hooks fired during execution
- The chronological order of these operations

**Resolution/Action Items:**
No comments or resolution yet - this is an open feature request with no discussion activity. The feature would enhance transparency and debugging capabilities by showing the execution trace of each interaction.

**Context:**
This appears to be part of claude-mem's evolution toward better observability of its plugin system, which would be particularly valuable given the complex architecture involving hooks (SessionStart, UserPromptSubmit, PostToolUse, Summary, SessionEnd), skills, and MCP integrations.

--- RESULT ---
## Summary of GitHub Discussion #288

**Title:** Feature Request: Reading Plan File of Last Session

**Author:** github-actions (originally posted as issue #180 by @unsafe9)

**Created:** 2025-12-13

**Main Topic:**  
Request to add functionality for claude-mem to capture and retrieve plan file paths from Claude Code's plan mode across sessions.

**Key Points:**

1. **Problem:** Claude Code creates temporary plan files in `~/.claude/plans/*.md` during plan mode, but references aren't persisted across sessions, making it difficult to continue previous planning work.

2. **Technical Finding:** Testing confirmed that the `ExitPlanMode` hook response contains the plan file path:
   ```json
   {
     "tool_response": {
       "filePath": "/Users/username/.claude/plans/federated-wandering-volcano.md",
       "plan": "# Plan content..."
     }
   }
   ```

3. **Proposed Solution:**
   - Capture plan file path, content, session_id, and timestamp on `ExitPlanMode` invocation
   - Add query capability (via `get_last_plan` tool or extended search filters)
   - Enable session continuity when users want to "continue from previous plan"

**Resolution/Action Items:**  
No comments or resolution yet - this is an open feature request awaiting implementation consideration.

**Additional Note:** The requester expressed appreciation for the plugin, noting they use it daily.

--- RESULT ---
## Summary of GitHub Discussion #289

**Title**: Track the git branch as observation metadata

**Author**: github-actions (auto-converted from issue #239 by @thedotmack)

**Created**: December 13, 2025

**Main Topic**: 
The discussion proposes adding git branch information as metadata to observations stored in claude-mem's database.

**Key Points**:
- Originally submitted as issue #239
- No detailed description provided in the discussion body
- No comments yet (0 comments)

**Status**: 
- No resolution or action items documented
- Appears to be a feature request that is still open for discussion
- No implementation details or use cases have been discussed yet

**Context**: 
This feature would enable claude-mem to track which git branch was active when observations were captured, potentially allowing for branch-specific context filtering or better understanding of work done on different branches.

--- RESULT ---
## Summary of GitHub Discussion #297

**Title**: Feature Request: Project-level memory disable option (.claude-mem.json)

**Author**: github-actions (originally posted as issue #293 by @mylukin)

**Created**: December 14, 2025

**Main Topic**: Request for project-level configuration to disable or customize claude-mem's memory capture on a per-project basis.

### Key Points Raised:

1. **Use Case**: Developers working on multiple projects need the ability to disable memory capture for specific projects containing sensitive data or temporary experiments, without affecting global settings.

2. **Proposed Solutions**:
   - **Project-level config file** (`.claude-mem.json` in project root):
     - Simple disable: `{ "enabled": false, "reason": "..." }`
     - Granular control: Enable/disable observations, sessions, and prompts independently
   - **Global ignore patterns** in `~/.claude-mem/settings.json`:
     - `ignoredProjects` array for project name patterns

3. **Expected Behavior**: When disabled, hooks should skip all memory capture while optionally maintaining the project in the database for organizational purposes.

4. **Current Workaround**: Manual SQLite deletion commands - not ideal as it's reactive rather than preventive.

5. **Additional Context**: 
   - Aligns with industry standards (`.gitignore`, `.npmrc`)
   - Addresses enterprise compliance requirements

### Status:
- **No comments or responses yet** (0 comments)
- **No resolution or action items assigned**
- Still open for discussion and implementation consideration

--- RESULT ---
## Summary of GitHub Discussion #298

**Title:** Move MCP scaffolding in to MCP file to not affect other systems and services

**Author:** github-actions (bot)

**Created:** December 14, 2025

**Main Topic:** 
This discussion was converted from issue #240 (originally created by @thedotmack). It proposes moving MCP (Model Context Protocol) scaffolding code into a dedicated MCP file to prevent it from affecting other systems and services in the codebase.

**Key Points:**
- The discussion was auto-converted from an issue
- No description was provided in either the original issue or the discussion
- The proposal suggests better code organization by isolating MCP-specific scaffolding

**Current Status:**
- No comments have been posted yet
- No resolution or action items documented
- The discussion appears to be awaiting further input from contributors

**Context:**
This seems to be a code architecture improvement proposal to better isolate MCP-related functionality from the rest of the claude-mem system, likely to improve maintainability and prevent unintended side effects.

--- RESULT ---
## GitHub Discussion #322 Summary

**Title**: Feature request: allow skipping context injection per session

**Author**: github-actions (originally posted as issue #321 by @kamil-hassan201)

**Created**: December 15, 2025

**Main Topic**: 
Request for the ability to start a Claude-Mem session without automatic context injection from previous sessions.

**Key Points Raised**:

1. **Current Limitation**: Claude-Mem automatically injects context from previous sessions at the start of every new session with no way to opt out

2. **Use Cases for Fresh Sessions**:
   - Exploring ideas from scratch without bias from previous context
   - Working on sensitive or experimental tasks where past memory should not influence the session
   - Temporarily opting out of memory without uninstalling the plugin or creating a new project

3. **Proposed Solution**: Add an explicit opt-out mechanism to skip context injection for individual sessions while keeping default behavior unchanged

4. **Gap in Documentation**: While docs mention "Context Configuration" and fine-grained control, there's currently no visible or documented way to disable injection per session

**Resolution/Action Items**: 
- No comments yet on the discussion
- Remains an open feature request
- Would improve user trust, flexibility, and usability for exploratory, sensitive, or debugging workflows

--- RESULT ---
## Summary of GitHub Discussion #325

**Title:** Cannot see Beta channel switch in settings / Endless mode not found

**Author:** Mickey123123

**Created:** December 15, 2025

**Main Topic:**
User is unable to locate the switch to enable "Endless mode" in the settings UI despite being on version 7.3 of claude-mem.

**Key Points Raised:**
- User has version 7.3 installed
- Cannot find the beta channel switch in settings UI
- Looking for "Endless mode" feature
- Expresses appreciation for the tool

**Status:**
- **No comments yet** - This discussion has not received any replies
- **No resolution** - The issue remains unresolved with no action items identified

**Observations:**
This appears to be a feature discoverability issue. The user may be looking for a feature that either:
1. Has been renamed or moved in the UI
2. Requires a different configuration approach
3. Is documented but not yet implemented in their version
4. Needs additional setup steps not immediately obvious

The discussion would benefit from maintainer attention to clarify the status of "Endless mode" and provide guidance on accessing beta features.

--- RESULT ---
## Summary of GitHub Discussion #328

**Title:** [Runtime] Let possibility to use Bun as runtime for hooks scripts executions

**Author:** github-actions (bot conversion from issue #327 by @CorentinLumineau)

**Created:** December 15, 2025

**Main Topic:** 
Feature request to use Bun as the primary runtime for executing hook scripts, with Node.js as a fallback option.

**Key Points:**
- The original poster wants to leverage Bun's performance benefits for hook script execution
- Currently, hooks are executed using Node.js
- Proposed solution: Change hook execution to try Bun first, then fall back to Node.js if Bun is not available
- The motivation is to take advantage of Bun's speed when it's already installed on the user's system

**Resolution/Action Items:**
- No comments or responses yet - the discussion appears to be newly created
- No action items or resolution at this time
- This is an open feature request awaiting maintainer or community feedback

**Context:** 
This aligns with claude-mem's existing use of Bun for the worker service. The project already requires Bun (auto-installed if missing), so extending its use to hook execution would be consistent with the current architecture.

--- RESULT ---
## Summary: GitHub Discussion #337

**Title:** Feature Request: Session-level view in web UI

**Author:** Originally posted by @changluyi (issue #336), converted to discussion by github-actions bot

**Created:** December 16, 2025

**Main Topic:**  
Request for a session-based navigation interface in the claude-mem web UI, as an alternative to the current continuous observation stream view.

**Key Points:**

1. **Current limitation:** The web UI displays observations as a continuous stream, making it difficult to review specific work sessions

2. **Requested features:**
   - List view of sessions with metadata (timestamp, observation count, summary)
   - Click-through navigation to view all observations within a specific session
   - Easy session-to-session navigation

3. **Use case:** Users want to review previous work sessions in a structured way rather than scrolling through the flat observation stream

4. **Proposed structure:** Hierarchical session list showing chronological sessions, each with observation counts and summaries

**Status:** No comments or resolution yet - this is an open feature request with no discussion activity.

**Action Items:** None specified - awaiting feedback/prioritization from maintainers.

--- RESULT ---
## Summary of GitHub Discussion #349

**Title**: Feature Request: Automatic claude.md update feature

**Author**: kticoder

**Created**: December 16, 2025

**Main Topic**: 
The discussion proposes implementing an automatic feature to update CLAUDE.md files based on important data gathered during sessions.

**Key Points**:
- The author suggests that claude-mem could identify important information from conversations and automatically update the project's CLAUDE.md file
- The feature would separate important data and add relevant rules to CLAUDE.md
- The author believes this is technically feasible based on the information claude-mem already gathers

**Current Status**:
- No comments yet - this is a new feature request with no discussion or resolution
- No maintainer response or action items defined

**Context**:
This relates to the CLAUDE.md files mentioned in the codebase instructions - these are markdown files that provide project-specific context and coding standards to Claude. The feature would essentially automate the process of capturing and documenting important project learnings and rules.

--- RESULT ---
## Summary of GitHub Discussion #351

**Title**: Add support for multiple Claude "aliases"

**Author**: jeremyHixon (via github-actions bot)

**Created**: December 16, 2025

**Main Topic**: 
The user runs multiple Claude Code instances using directory-based aliases (e.g., `claude-work` and `claude-personal` with separate `.claude-work` and `.claude-personal` directories). When installing the claude-mem plugin in a non-default alias directory (`.claude-personal`), the plugin incorrectly looks for configuration in the default `.claude` directory instead of the alias directory.

**Key Points Raised**:
1. **Problem**: Plugin doesn't respect custom Claude alias directories - it hardcodes lookups to `.claude` instead of detecting the actual installation directory
2. **Proposed Solution**: Add a configuration option for specifying the root directory name, or automatically detect the current directory instead of assuming `.claude`
3. **Additional Issue**: User suspects `npm install` commands may be failing due to their system's `NODE_ENV` defaulting to "production"

**Resolution/Action Items**:
- No resolution yet - discussion is open with only one comment from the original author
- Feature request needs implementation to support dynamic directory detection or configuration
- May need to investigate how claude-mem determines the Claude home directory and make it alias-aware

--- RESULT ---
## Summary of GitHub Discussion #365

**Title:** Feature: Memory Importance Scoring & De-duplication

**Author:** Originally posted by @PremChaurasiya07 as issue #364, converted to discussion by github-actions bot

**Created:** December 17, 2025

**Main Topic:**  
Enhancement request to improve memory quality by implementing importance scoring and de-duplication for stored observations.

**Key Points Raised:**

1. **Problem Identified:**
   - Similar or repeated observations (especially from tool outputs) accumulate over time
   - All observations are stored with equal weight, creating noise
   - Reduces relevance of injected context in new sessions

2. **Proposed Solution:**
   - Implement lightweight importance scoring system with hierarchy:
     - Decisions (highest priority)
     - Writes
     - Reads
     - Informational (lowest priority)
   - Add basic de-duplication using hash or similarity-based matching
   - Prefer higher-value memories during context injection
   - Merge or skip near-duplicate observations

3. **Alternatives Considered:**
   - Manual tuning of context limits
   - Relying solely on recency
   - These approaches don't effectively address noise or repetition

4. **Expected Benefits:**
   - Reduced token usage
   - Improved memory quality
   - Better scalability for long-running projects
   - Preserves existing behavior (non-breaking change)

**Resolution/Action Items:**
- No comments yet on the discussion
- Author expressed willingness to implement and submit a PR if the approach is acceptable
- Currently awaiting feedback from maintainers

This feature request addresses a scalability concern as the memory database grows over time, proposing an intelligent filtering mechanism to maintain quality and relevance of stored context.
