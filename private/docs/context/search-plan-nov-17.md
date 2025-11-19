 Unified Search API Consolidation Plan

 Overview

 Consolidate 10 search endpoints into 6 powerful, semantic endpoints with intelligent aliasing for backward compatibility.

 New Endpoint Structure

 1. /search - Unified Cross-Type Search

 - Searches all record types (observations + sessions + prompts) via Chroma multi-collection search
 - Optional type filter to narrow down
 - Replaces: search_observations, search_sessions, search_user_prompts
 - Params: query, response=[index|full], type, project, dateRange, limit, offset, orderBy

 2. /timeline - Unified Timeline Tool

 - Supports both anchor-based and query-based modes via params
 - If anchor → direct timeline lookup (like get_context_timeline)
 - If query → search-first then timeline (like get_timeline_by_query)
 - Params: anchor OR query, depth_before, depth_after, response, mode, project

 3. /decisions - Decision Observations

 - Metadata-first search for type=decision observations
 - Uses specialized search logic for precision
 - Params: response, project, dateRange, limit, offset, orderBy

 4. /changes - Change Observations

 - Metadata-first search for type=change observations
 - Same pattern as /decisions

 5. /how-it-works - How-It-Works Concept

 - Metadata-first search for concept=how-it-works observations
 - Same pattern as concept endpoints

 6. /contextualize - Intelligent Context Builder

 - Complex hybrid endpoint:
   a. Get 7 latest decisions + 7 latest changes + 3 latest how-it-works
   b. Find newest date across all results
   c. Get timeline (7 before + 7 after) around that date
   d. Merge & re-sort into single timeline (newest → oldest)
   e. Return timeline + narratives of each concept's latest result
 - Params: query (for contextualization), project

 Implementation Phases

 Phase 1: Core Unified Search (search-server.ts)

 - Create search tool with Chroma multi-collection query
 - Add type filtering support
 - Alias old tools: search_observations → search(type=['observations'])

 Phase 2: Unified Timeline (search-server.ts)

 - Merge get_context_timeline + get_timeline_by_query logic
 - Support both anchor and query params (mutually exclusive)
 - Alias old timeline tools to new unified implementation

 Phase 3: Specialized Concept Endpoints (search-server.ts)

 - Create decisions, changes, how_it_works tools
 - Use metadata-first search strategy
 - Update find_by_type and find_by_concept to call these internally

 Phase 4: Contextualize Endpoint (search-server.ts)

 - Implement parallel fetching (7 decisions, 7 changes, 3 how-it-works)
 - Find newest date, get timeline around it
 - Merge, re-sort, extract narratives
 - Return structured response with timeline + narratives

 Phase 5: HTTP API Routes (worker-service.ts)

 - Add 6 new routes: /api/search, /api/timeline, /api/decisions, /api/changes, /api/how-it-works, /api/contextualize
 - Update old routes to alias new implementations
 - Maintain backward compatibility

 Phase 6: Chroma Multi-Collection Search (ChromaSync.ts)

 - Add searchAll() method to query all collections in parallel
 - Include source collection metadata in results
 - Merge and rank by similarity score

 Phase 7: SQLite Fallback (SessionSearch.ts)

 - Add searchAll() for FTS5 fallback when Chroma unavailable
 - Merge results from all three FTS5 tables

 Phase 8: Documentation & Skill Updates

 - Update mem-search skill with new endpoints
 - Update CLAUDE.md and README.md
 - Add examples and migration guide

 Phase 9: Testing & Deployment

 - Unit tests for all new tools
 - Integration tests for aliasing
 - Manual testing via mem-search skill
 - Build → sync → worker restart

 Key Design Decisions

 ✅ Aliasing Strategy: Old endpoints call new implementations internally (zero breaking changes)
 ✅ Unified Search: Chroma multi-collection search for true cross-type queries
 ✅ Flexible Timeline: Single tool supports both direct and query-based modes
 ✅ Specialized Shortcuts: /decisions, /changes, /how-it-works for common queries
 ✅ Intelligent Context: /contextualize auto-builds rich context with narratives

 Migration Impact

 - Users: Zero breaking changes, old endpoints work via aliasing
 - Codebase: Simplified from 10 conceptual endpoints to 6
 - Performance: Improved via Chroma multi-collection search
 - Developer UX: Cleaner, more semantic API