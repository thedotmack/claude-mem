#!/usr/bin/env node

/**
 * Claude-mem MCP Search Server
 * Exposes SessionSearch capabilities as MCP tools with search_result formatting
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SessionSearch } from '../services/sqlite/SessionSearch.js';
import { ObservationSearchResult, SessionSummarySearchResult } from '../services/sqlite/types.js';

// Initialize search instance
let search: SessionSearch;
try {
  search = new SessionSearch();
} catch (error: any) {
  console.error('[search-server] Failed to initialize search:', error.message);
  process.exit(1);
}

/**
 * Format observation as search_result with citations
 */
function formatObservationResult(obs: ObservationSearchResult, index: number) {
  const source = `claude-mem://observation/${obs.id}`;
  const title = obs.title || `Observation #${obs.id}`;

  // Build content from available fields
  const contentParts: string[] = [];

  if (obs.subtitle) {
    contentParts.push(`**${obs.subtitle}**`);
  }

  if (obs.narrative) {
    contentParts.push(obs.narrative);
  }

  if (obs.text) {
    contentParts.push(obs.text);
  }

  // Add metadata
  const metadata: string[] = [];
  metadata.push(`Type: ${obs.type}`);

  if (obs.facts) {
    try {
      const facts = JSON.parse(obs.facts);
      if (facts.length > 0) {
        metadata.push(`Facts: ${facts.join('; ')}`);
      }
    } catch {}
  }

  if (obs.concepts) {
    try {
      const concepts = JSON.parse(obs.concepts);
      if (concepts.length > 0) {
        metadata.push(`Concepts: ${concepts.join(', ')}`);
      }
    } catch {}
  }

  if (obs.files_read || obs.files_modified) {
    const files: string[] = [];
    if (obs.files_read) {
      try {
        files.push(...JSON.parse(obs.files_read));
      } catch {}
    }
    if (obs.files_modified) {
      try {
        files.push(...JSON.parse(obs.files_modified));
      } catch {}
    }
    if (files.length > 0) {
      metadata.push(`Files: ${[...new Set(files)].join(', ')}`);
    }
  }

  if (metadata.length > 0) {
    contentParts.push(`\n---\n${metadata.join(' | ')}`);
  }

  const content = contentParts.join('\n\n');

  return {
    type: 'search_result' as const,
    source,
    title,
    content: [{
      type: 'text' as const,
      text: content || 'No content available'
    }],
    citations: { enabled: true }
  };
}

/**
 * Format session summary as search_result with citations
 */
function formatSessionResult(session: SessionSummarySearchResult, index: number) {
  const source = `claude-mem://session/${session.sdk_session_id}`;
  const title = session.request || `Session ${session.sdk_session_id.substring(0, 8)}`;

  // Build content from available fields
  const contentParts: string[] = [];

  if (session.completed) {
    contentParts.push(`**Completed:** ${session.completed}`);
  }

  if (session.learned) {
    contentParts.push(`**Learned:** ${session.learned}`);
  }

  if (session.investigated) {
    contentParts.push(`**Investigated:** ${session.investigated}`);
  }

  if (session.next_steps) {
    contentParts.push(`**Next Steps:** ${session.next_steps}`);
  }

  if (session.notes) {
    contentParts.push(`**Notes:** ${session.notes}`);
  }

  // Add metadata
  const metadata: string[] = [];

  if (session.files_read || session.files_edited) {
    const files: string[] = [];
    if (session.files_read) {
      try {
        files.push(...JSON.parse(session.files_read));
      } catch {}
    }
    if (session.files_edited) {
      try {
        files.push(...JSON.parse(session.files_edited));
      } catch {}
    }
    if (files.length > 0) {
      metadata.push(`Files: ${[...new Set(files)].join(', ')}`);
    }
  }

  const date = new Date(session.created_at_epoch).toLocaleDateString();
  metadata.push(`Date: ${date}`);

  if (metadata.length > 0) {
    contentParts.push(`\n---\n${metadata.join(' | ')}`);
  }

  const content = contentParts.join('\n\n');

  return {
    type: 'search_result' as const,
    source,
    title,
    content: [{
      type: 'text' as const,
      text: content || 'No content available'
    }],
    citations: { enabled: true }
  };
}

/**
 * Common filter schema
 */
const filterSchema = z.object({
  project: z.string().optional().describe('Filter by project name'),
  type: z.union([
    z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']),
    z.array(z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']))
  ]).optional().describe('Filter by observation type'),
  concepts: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by concept tags'),
  files: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by file paths (partial match)'),
  dateRange: z.object({
    start: z.union([z.string(), z.number()]).optional().describe('Start date (ISO string or epoch)'),
    end: z.union([z.string(), z.number()]).optional().describe('End date (ISO string or epoch)')
  }).optional().describe('Filter by date range'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
  offset: z.number().min(0).default(0).describe('Number of results to skip'),
  orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('relevance').describe('Sort order')
});

/**
 * Create and start the MCP server
 */
const server = createSdkMcpServer({
  name: 'claude-mem-search',
  version: '1.0.0',
  tools: [
    // Tool 1: Search observations
    tool(
      'search_observations',
      'Search observations using full-text search across titles, narratives, facts, and concepts',
      {
        query: z.string().describe('Search query for FTS5 full-text search'),
        ...filterSchema.shape
      },
      async (args) => {
        try {
          const { query, ...options } = args;
          const results = search.searchObservations(query, options);

          if (results.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No observations found matching "${query}"`
              }]
            };
          }

          return {
            content: results.map((obs, i) => formatObservationResult(obs, i))
          };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    ),

    // Tool 2: Search sessions
    tool(
      'search_sessions',
      'Search session summaries using full-text search across requests, completions, learnings, and notes',
      {
        query: z.string().describe('Search query for FTS5 full-text search'),
        project: z.string().optional().describe('Filter by project name'),
        dateRange: z.object({
          start: z.union([z.string(), z.number()]).optional(),
          end: z.union([z.string(), z.number()]).optional()
        }).optional().describe('Filter by date range'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
        offset: z.number().min(0).default(0).describe('Number of results to skip'),
        orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('relevance').describe('Sort order')
      },
      async (args) => {
        try {
          const { query, ...options } = args;
          const results = search.searchSessions(query, options);

          if (results.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No sessions found matching "${query}"`
              }]
            };
          }

          return {
            content: results.map((session, i) => formatSessionResult(session, i))
          };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    ),

    // Tool 3: Find by concept
    tool(
      'find_by_concept',
      'Find observations tagged with a specific concept',
      {
        concept: z.string().describe('Concept tag to search for'),
        project: z.string().optional().describe('Filter by project name'),
        dateRange: z.object({
          start: z.union([z.string(), z.number()]).optional(),
          end: z.union([z.string(), z.number()]).optional()
        }).optional().describe('Filter by date range')
      },
      async (args) => {
        try {
          const { concept, ...filters } = args;
          const results = search.findByConcept(concept, filters);

          if (results.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No observations found with concept "${concept}"`
              }]
            };
          }

          return {
            content: results.map((obs, i) => formatObservationResult(obs, i))
          };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    ),

    // Tool 4: Find by file
    tool(
      'find_by_file',
      'Find observations and sessions that reference a specific file path',
      {
        filePath: z.string().describe('File path to search for (supports partial matching)'),
        project: z.string().optional().describe('Filter by project name'),
        dateRange: z.object({
          start: z.union([z.string(), z.number()]).optional(),
          end: z.union([z.string(), z.number()]).optional()
        }).optional().describe('Filter by date range')
      },
      async (args) => {
        try {
          const { filePath, ...filters } = args;
          const results = search.findByFile(filePath, filters);

          const totalResults = results.observations.length + results.sessions.length;

          if (totalResults === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No results found for file "${filePath}"`
              }]
            };
          }

          const content: any[] = [];

          // Add observations
          results.observations.forEach((obs, i) => {
            content.push(formatObservationResult(obs, i));
          });

          // Add sessions
          results.sessions.forEach((session, i) => {
            content.push(formatSessionResult(session, i + results.observations.length));
          });

          return { content };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    ),

    // Tool 5: Find by type
    tool(
      'find_by_type',
      'Find observations of a specific type (decision, bugfix, feature, refactor, discovery, change)',
      {
        type: z.union([
          z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']),
          z.array(z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']))
        ]).describe('Observation type(s) to filter by'),
        project: z.string().optional().describe('Filter by project name'),
        dateRange: z.object({
          start: z.union([z.string(), z.number()]).optional(),
          end: z.union([z.string(), z.number()]).optional()
        }).optional().describe('Filter by date range')
      },
      async (args) => {
        try {
          const { type, ...filters } = args;
          const results = search.findByType(type, filters);

          if (results.length === 0) {
            const typeStr = Array.isArray(type) ? type.join(', ') : type;
            return {
              content: [{
                type: 'text' as const,
                text: `No observations found with type "${typeStr}"`
              }]
            };
          }

          return {
            content: results.map((obs, i) => formatObservationResult(obs, i))
          };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    ),

    // Tool 6: Advanced search
    tool(
      'advanced_search',
      'Advanced search combining full-text search with structured filters across both observations and sessions',
      {
        textQuery: z.string().optional().describe('Optional text query for FTS5 search'),
        searchSessions: z.boolean().default(true).describe('Include session summaries in results'),
        ...filterSchema.shape
      },
      async (args) => {
        try {
          const results = search.advancedSearch(args);

          const totalResults = results.observations.length + results.sessions.length;

          if (totalResults === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: 'No results found matching the search criteria'
              }]
            };
          }

          const content: any[] = [];

          // Add observations
          results.observations.forEach((obs, i) => {
            content.push(formatObservationResult(obs, i));
          });

          // Add sessions
          results.sessions.forEach((session, i) => {
            content.push(formatSessionResult(session, i + results.observations.length));
          });

          return { content };
        } catch (error: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Search failed: ${error.message}`
            }]
          };
        }
      }
    )
  ]
});

// Start the server
console.error('[search-server] Starting claude-mem search server...');
