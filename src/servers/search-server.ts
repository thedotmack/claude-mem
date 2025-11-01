/**
 * Claude-mem MCP Search Server
 * Exposes SessionSearch capabilities as MCP tools with search_result formatting
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { basename } from 'path';
import { SessionSearch } from '../services/sqlite/SessionSearch.js';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../services/sqlite/types.js';
import { VECTOR_DB_DIR } from '../shared/paths.js';

// Initialize search instances
let search: SessionSearch;
let store: SessionStore;
let chromaClient: Client | null = null;
const COLLECTION_NAME = 'cm__claude-mem';

try {
  search = new SessionSearch();
  store = new SessionStore();
} catch (error: any) {
  console.error('[search-server] Failed to initialize search:', error.message);
  process.exit(1);
}

/**
 * Query Chroma vector database via MCP
 */
async function queryChroma(
  query: string,
  limit: number,
  whereFilter?: Record<string, any>
): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
  if (!chromaClient) {
    throw new Error('Chroma client not initialized');
  }

  const result = await chromaClient.callTool({
    name: 'chroma_query_documents',
    arguments: {
      collection_name: COLLECTION_NAME,
      query_texts: [query],
      n_results: limit,
      include: ['documents', 'metadatas', 'distances'],
      where: whereFilter
    }
  });

  const resultText = result.content[0]?.text || '';

  // Parse JSON response
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch (error) {
    console.error('[search-server] Failed to parse Chroma response as JSON:', error);
    return { ids: [], distances: [], metadatas: [] };
  }

  // Extract unique observation IDs from document IDs
  const ids: number[] = [];
  const docIds = parsed.ids?.[0] || [];
  for (const docId of docIds) {
    // Extract sqlite_id from document ID (format: obs_{id}_narrative, obs_{id}_fact_0, etc)
    const match = docId.match(/obs_(\d+)_/);
    if (match) {
      const sqliteId = parseInt(match[1], 10);
      if (!ids.includes(sqliteId)) {
        ids.push(sqliteId);
      }
    }
  }

  const distances = parsed.distances?.[0] || [];
  const metadatas = parsed.metadatas?.[0] || [];

  return { ids, distances, metadatas };
}

/**
 * Format search tips footer
 */
function formatSearchTips(): string {
  return `\n---
💡 Search Strategy:
ALWAYS search with index format FIRST to get an overview and identify relevant results.
This is critical for token efficiency - index format uses ~10x fewer tokens than full format.

Search workflow:
1. Initial search: Use default (index) format to see titles, dates, and sources
2. Review results: Identify which items are most relevant to your needs
3. Deep dive: Only then use format: "full" on specific items of interest
4. Narrow down: Use filters (type, dateRange, concepts, files) to refine results

Other tips:
• To search by concept: Use find_by_concept tool
• To browse by type: Use find_by_type with ["decision", "feature", etc.]
• To sort by date: Use orderBy: "date_desc" or "date_asc"`;
}

/**
 * Format observation as index entry (title, date, ID only)
 */
function formatObservationIndex(obs: ObservationSearchResult, index: number): string {
  const title = obs.title || `Observation #${obs.id}`;
  const date = new Date(obs.created_at_epoch).toLocaleString();
  const type = obs.type ? `[${obs.type}]` : '';

  return `${index + 1}. ${type} ${title}
   Date: ${date}
   Source: claude-mem://observation/${obs.id}`;
}

/**
 * Format session summary as index entry (title, date, ID only)
 */
function formatSessionIndex(session: SessionSummarySearchResult, index: number): string {
  const title = session.request || `Session ${session.sdk_session_id.substring(0, 8)}`;
  const date = new Date(session.created_at_epoch).toLocaleString();

  return `${index + 1}. ${title}
   Date: ${date}
   Source: claude-mem://session/${session.sdk_session_id}`;
}

/**
 * Format observation as text content with metadata
 */
function formatObservationResult(obs: ObservationSearchResult, index: number): string {
  const title = obs.title || `Observation #${obs.id}`;

  // Build content from available fields
  const contentParts: string[] = [];
  contentParts.push(`## ${title}`);
  contentParts.push(`*Source: claude-mem://observation/${obs.id}*`);
  contentParts.push('');

  if (obs.subtitle) {
    contentParts.push(`**${obs.subtitle}**`);
    contentParts.push('');
  }

  if (obs.narrative) {
    contentParts.push(obs.narrative);
    contentParts.push('');
  }

  if (obs.text) {
    contentParts.push(obs.text);
    contentParts.push('');
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
    contentParts.push('---');
    contentParts.push(metadata.join(' | '));
  }

  // Add date
  const date = new Date(obs.created_at_epoch).toLocaleString();
  contentParts.push('');
  contentParts.push(`---`);
  contentParts.push(`Date: ${date}`);

  return contentParts.join('\n');
}

/**
 * Format session summary as text content with metadata
 */
function formatSessionResult(session: SessionSummarySearchResult, index: number): string {
  const title = session.request || `Session ${session.sdk_session_id.substring(0, 8)}`;

  // Build content from available fields
  const contentParts: string[] = [];
  contentParts.push(`## ${title}`);
  contentParts.push(`*Source: claude-mem://session/${session.sdk_session_id}*`);
  contentParts.push('');

  if (session.completed) {
    contentParts.push(`**Completed:** ${session.completed}`);
    contentParts.push('');
  }

  if (session.learned) {
    contentParts.push(`**Learned:** ${session.learned}`);
    contentParts.push('');
  }

  if (session.investigated) {
    contentParts.push(`**Investigated:** ${session.investigated}`);
    contentParts.push('');
  }

  if (session.next_steps) {
    contentParts.push(`**Next Steps:** ${session.next_steps}`);
    contentParts.push('');
  }

  if (session.notes) {
    contentParts.push(`**Notes:** ${session.notes}`);
    contentParts.push('');
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
    contentParts.push('---');
    contentParts.push(metadata.join(' | '));
  }

  return contentParts.join('\n');
}

/**
 * Format user prompt as index entry (truncated text, date, ID only)
 */
function formatUserPromptIndex(prompt: UserPromptSearchResult, index: number): string {
  const truncated = prompt.prompt_text.length > 100
    ? prompt.prompt_text.substring(0, 100) + '...'
    : prompt.prompt_text;
  const date = new Date(prompt.created_at_epoch).toLocaleString();

  return `${index + 1}. "${truncated}"
   Date: ${date} | Prompt #${prompt.prompt_number}
   Source: claude-mem://user-prompt/${prompt.id}`;
}

/**
 * Format user prompt as text content with metadata
 */
function formatUserPromptResult(prompt: UserPromptSearchResult, index: number): string {
  const contentParts: string[] = [];
  contentParts.push(`## User Prompt #${prompt.prompt_number}`);
  contentParts.push(`*Source: claude-mem://user-prompt/${prompt.id}*`);
  contentParts.push('');
  contentParts.push(prompt.prompt_text);
  contentParts.push('');
  contentParts.push('---');

  const date = new Date(prompt.created_at_epoch).toLocaleString();
  contentParts.push(`Date: ${date}`);

  return contentParts.join('\n');
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
  orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
});

// Define tool schemas
const tools = [
  {
    name: 'search_observations',
    description: 'Search observations using full-text search across titles, narratives, facts, and concepts. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Search query for FTS5 full-text search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      ...filterSchema.shape
    }),
    handler: async (args: any) => {
      try {
        const { query, format = 'index', ...options } = args;
        let results: ObservationSearchResult[] = [];

        // Hybrid search: Try Chroma semantic search first, fall back to FTS5
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid semantic search (Chroma + SQLite)');

            // Step 1: Chroma semantic search (top 100)
            const chromaResults = await queryChroma(query, 100);
            console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Step 2: Filter by recency (90 days)
              const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
              const recentIds = chromaResults.ids.filter((id, idx) => {
                const meta = chromaResults.metadatas[idx];
                return meta && meta.created_at_epoch > ninetyDaysAgo;
              });

              console.error(`[search-server] ${recentIds.length} results within 90-day window`);

              // Step 3: Hydrate from SQLite in temporal order
              if (recentIds.length > 0) {
                const limit = options.limit || 20;
                results = store.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit });
                console.error(`[search-server] Hydrated ${results.length} observations from SQLite`);
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma query failed, falling back to FTS5:', chromaError.message);
            // Fall through to FTS5 fallback
          }
        }

        // Fall back to FTS5 if Chroma unavailable or returned no results
        if (results.length === 0) {
          console.error('[search-server] Using FTS5 keyword search');
          results = search.searchObservations(query, options);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No observations found matching "${query}"`
            }]
          };
        }

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} observation(s) matching "${query}":\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = results.map((obs, i) => formatObservationResult(obs, i));
          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'search_sessions',
    description: 'Search session summaries using full-text search across requests, completions, learnings, and notes. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Search query for FTS5 full-text search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateRange: z.object({
        start: z.union([z.string(), z.number()]).optional(),
        end: z.union([z.string(), z.number()]).optional()
      }).optional().describe('Filter by date range'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const { query, format = 'index', ...options } = args;
        const results = search.searchSessions(query, options);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No sessions found matching "${query}"`
            }]
          };
        }

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} session(s) matching "${query}":\n\n`;
          const formattedResults = results.map((session, i) => formatSessionIndex(session, i));
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = results.map((session, i) => formatSessionResult(session, i));
          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'find_by_concept',
    description: 'Find observations tagged with a specific concept. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      concept: z.string().describe('Concept tag to search for'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateRange: z.object({
        start: z.union([z.string(), z.number()]).optional(),
        end: z.union([z.string(), z.number()]).optional()
      }).optional().describe('Filter by date range'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const { concept, format = 'index', ...filters } = args;
        let results: ObservationSearchResult[] = [];

        // Metadata-first, semantic-enhanced search
        if (chromaClient) {
          try {
            console.error('[search-server] Using metadata-first + semantic ranking for concept search');

            // Step 1: SQLite metadata filter (get all IDs with this concept)
            const metadataResults = search.findByConcept(concept, filters);
            console.error(`[search-server] Found ${metadataResults.length} observations with concept "${concept}"`);

            if (metadataResults.length > 0) {
              // Step 2: Chroma semantic ranking (rank by relevance to concept)
              const ids = metadataResults.map(obs => obs.id);
              const chromaResults = await queryChroma(concept, Math.min(ids.length, 100));

              // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
              const rankedIds: number[] = [];
              for (const chromaId of chromaResults.ids) {
                if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                  rankedIds.push(chromaId);
                }
              }

              console.error(`[search-server] Chroma ranked ${rankedIds.length} results by semantic relevance`);

              // Step 3: Hydrate in semantic rank order
              if (rankedIds.length > 0) {
                results = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                // Restore semantic ranking order
                results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma ranking failed, using SQLite order:', chromaError.message);
            // Fall through to SQLite fallback
          }
        }

        // Fall back to SQLite-only if Chroma unavailable or failed
        if (results.length === 0) {
          console.error('[search-server] Using SQLite-only concept search');
          results = search.findByConcept(concept, filters);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No observations found with concept "${concept}"`
            }]
          };
        }

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} observation(s) with concept "${concept}":\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = results.map((obs, i) => formatObservationResult(obs, i));
          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'find_by_file',
    description: 'Find observations and sessions that reference a specific file path. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      filePath: z.string().describe('File path to search for (supports partial matching)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateRange: z.object({
        start: z.union([z.string(), z.number()]).optional(),
        end: z.union([z.string(), z.number()]).optional()
      }).optional().describe('Filter by date range'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const { filePath, format = 'index', ...filters } = args;
        let observations: ObservationSearchResult[] = [];
        let sessions: SessionSummarySearchResult[] = [];

        // Metadata-first, semantic-enhanced search for observations
        if (chromaClient) {
          try {
            console.error('[search-server] Using metadata-first + semantic ranking for file search');

            // Step 1: SQLite metadata filter (get all results with this file)
            const metadataResults = search.findByFile(filePath, filters);
            console.error(`[search-server] Found ${metadataResults.observations.length} observations, ${metadataResults.sessions.length} sessions for file "${filePath}"`);

            // Sessions: Keep as-is (already summarized, no semantic ranking needed)
            sessions = metadataResults.sessions;

            // Observations: Apply semantic ranking
            if (metadataResults.observations.length > 0) {
              // Step 2: Chroma semantic ranking (rank by relevance to file path)
              const ids = metadataResults.observations.map(obs => obs.id);
              const chromaResults = await queryChroma(filePath, Math.min(ids.length, 100));

              // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
              const rankedIds: number[] = [];
              for (const chromaId of chromaResults.ids) {
                if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                  rankedIds.push(chromaId);
                }
              }

              console.error(`[search-server] Chroma ranked ${rankedIds.length} observations by semantic relevance`);

              // Step 3: Hydrate in semantic rank order
              if (rankedIds.length > 0) {
                observations = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                // Restore semantic ranking order
                observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma ranking failed, using SQLite order:', chromaError.message);
            // Fall through to SQLite fallback
          }
        }

        // Fall back to SQLite-only if Chroma unavailable or failed
        if (observations.length === 0 && sessions.length === 0) {
          console.error('[search-server] Using SQLite-only file search');
          const results = search.findByFile(filePath, filters);
          observations = results.observations;
          sessions = results.sessions;
        }

        const totalResults = observations.length + sessions.length;

        if (totalResults === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No results found for file "${filePath}"`
            }]
          };
        }

        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${totalResults} result(s) for file "${filePath}":\n\n`;
          const formattedResults: string[] = [];

          // Add observations
          observations.forEach((obs, i) => {
            formattedResults.push(formatObservationIndex(obs, i));
          });

          // Add sessions
          sessions.forEach((session, i) => {
            formattedResults.push(formatSessionIndex(session, i + observations.length));
          });

          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults: string[] = [];

          // Add observations
          observations.forEach((obs, i) => {
            formattedResults.push(formatObservationResult(obs, i));
          });

          // Add sessions
          sessions.forEach((session, i) => {
            formattedResults.push(formatSessionResult(session, i + observations.length));
          });

          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'find_by_type',
    description: 'Find observations of a specific type (decision, bugfix, feature, refactor, discovery, change). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      type: z.union([
        z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']),
        z.array(z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']))
      ]).describe('Observation type(s) to filter by'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateRange: z.object({
        start: z.union([z.string(), z.number()]).optional(),
        end: z.union([z.string(), z.number()]).optional()
      }).optional().describe('Filter by date range'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const { type, format = 'index', ...filters } = args;
        const typeStr = Array.isArray(type) ? type.join(', ') : type;
        let results: ObservationSearchResult[] = [];

        // Metadata-first, semantic-enhanced search
        if (chromaClient) {
          try {
            console.error('[search-server] Using metadata-first + semantic ranking for type search');

            // Step 1: SQLite metadata filter (get all IDs with this type)
            const metadataResults = search.findByType(type, filters);
            console.error(`[search-server] Found ${metadataResults.length} observations with type "${typeStr}"`);

            if (metadataResults.length > 0) {
              // Step 2: Chroma semantic ranking (rank by relevance to type)
              const ids = metadataResults.map(obs => obs.id);
              const chromaResults = await queryChroma(typeStr, Math.min(ids.length, 100));

              // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
              const rankedIds: number[] = [];
              for (const chromaId of chromaResults.ids) {
                if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                  rankedIds.push(chromaId);
                }
              }

              console.error(`[search-server] Chroma ranked ${rankedIds.length} results by semantic relevance`);

              // Step 3: Hydrate in semantic rank order
              if (rankedIds.length > 0) {
                results = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                // Restore semantic ranking order
                results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma ranking failed, using SQLite order:', chromaError.message);
            // Fall through to SQLite fallback
          }
        }

        // Fall back to SQLite-only if Chroma unavailable or failed
        if (results.length === 0) {
          console.error('[search-server] Using SQLite-only type search');
          results = search.findByType(type, filters);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No observations found with type "${typeStr}"`
            }]
          };
        }

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} observation(s) with type "${typeStr}":\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = results.map((obs, i) => formatObservationResult(obs, i));
          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'get_recent_context',
    description: 'Get recent session context including summaries and observations for a project',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (defaults to current working directory basename)'),
      limit: z.number().min(1).max(10).default(3).describe('Number of recent sessions to retrieve')
    }),
    handler: async (args: any) => {
      try {
        const project = args.project || basename(process.cwd());
        const limit = args.limit || 3;

        const sessions = store.getRecentSessionsWithStatus(project, limit);

        if (sessions.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `# Recent Session Context\n\nNo previous sessions found for project "${project}".`
            }]
          };
        }

        const lines: string[] = [];
        lines.push('# Recent Session Context');
        lines.push('');
        lines.push(`Showing last ${sessions.length} session(s) for **${project}**:`);
        lines.push('');

        for (const session of sessions) {
          if (!session.sdk_session_id) continue;

          lines.push('---');
          lines.push('');

          if (session.has_summary) {
            const summary = store.getSummaryForSession(session.sdk_session_id);
            if (summary) {
              const promptLabel = summary.prompt_number ? ` (Prompt #${summary.prompt_number})` : '';
              lines.push(`**Summary${promptLabel}**`);
              lines.push('');

              if (summary.request) lines.push(`**Request:** ${summary.request}`);
              if (summary.completed) lines.push(`**Completed:** ${summary.completed}`);
              if (summary.learned) lines.push(`**Learned:** ${summary.learned}`);
              if (summary.next_steps) lines.push(`**Next Steps:** ${summary.next_steps}`);

              // Handle files_read
              if (summary.files_read) {
                try {
                  const filesRead = JSON.parse(summary.files_read);
                  if (Array.isArray(filesRead) && filesRead.length > 0) {
                    lines.push(`**Files Read:** ${filesRead.join(', ')}`);
                  }
                } catch {
                  if (summary.files_read.trim()) {
                    lines.push(`**Files Read:** ${summary.files_read}`);
                  }
                }
              }

              // Handle files_edited
              if (summary.files_edited) {
                try {
                  const filesEdited = JSON.parse(summary.files_edited);
                  if (Array.isArray(filesEdited) && filesEdited.length > 0) {
                    lines.push(`**Files Edited:** ${filesEdited.join(', ')}`);
                  }
                } catch {
                  if (summary.files_edited.trim()) {
                    lines.push(`**Files Edited:** ${summary.files_edited}`);
                  }
                }
              }

              const date = new Date(summary.created_at).toLocaleString();
              lines.push(`**Date:** ${date}`);
            }
          } else if (session.status === 'active') {
            lines.push('**In Progress**');
            lines.push('');

            if (session.user_prompt) {
              lines.push(`**Request:** ${session.user_prompt}`);
            }

            const observations = store.getObservationsForSession(session.sdk_session_id);
            if (observations.length > 0) {
              lines.push('');
              lines.push(`**Observations (${observations.length}):**`);
              for (const obs of observations) {
                lines.push(`- ${obs.title}`);
              }
            } else {
              lines.push('');
              lines.push('*No observations yet*');
            }

            lines.push('');
            lines.push('**Status:** Active - summary pending');

            const date = new Date(session.started_at).toLocaleString();
            lines.push(`**Date:** ${date}`);
          } else {
            lines.push(`**${session.status.charAt(0).toUpperCase() + session.status.slice(1)}**`);
            lines.push('');

            if (session.user_prompt) {
              lines.push(`**Request:** ${session.user_prompt}`);
            }

            lines.push('');
            lines.push(`**Status:** ${session.status} - no summary available`);

            const date = new Date(session.started_at).toLocaleString();
            lines.push(`**Date:** ${date}`);
          }

          lines.push('');
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n')
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to get recent context: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'search_user_prompts',
    description: 'Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Search query for FTS5 full-text search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for truncated prompts/dates (default, RECOMMENDED for initial search), "full" for complete prompt text (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateRange: z.object({
        start: z.union([z.string(), z.number()]).optional(),
        end: z.union([z.string(), z.number()]).optional()
      }).optional().describe('Filter by date range'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const { query, format = 'index', ...options } = args;
        const results = search.searchUserPrompts(query, options);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No user prompts found matching "${query}"`
            }]
          };
        }

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} user prompt(s) matching "${query}":\n\n`;
          const formattedResults = results.map((prompt, i) => formatUserPromptIndex(prompt, i));
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = results.map((prompt, i) => formatUserPromptResult(prompt, i));
          combinedText = formattedResults.join('\n\n---\n\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: combinedText
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Search failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  }
];

/**
 * Create and start the MCP server
 */
const server = new Server(
  {
    name: 'claude-mem-search',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as any
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error: any) {
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error.message}`
      }],
      isError: true
    };
  }
});

// Start the server
async function main() {
  // Start the MCP server FIRST (critical - must start before blocking operations)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[search-server] Claude-mem search server started');

  // Initialize Chroma client in background (non-blocking)
  setTimeout(async () => {
    try {
      console.error('[search-server] Initializing Chroma client...');
      const chromaTransport = new StdioClientTransport({
        command: 'uvx',
        args: ['chroma-mcp', '--client-type', 'persistent', '--data-dir', VECTOR_DB_DIR]
      });

      const client = new Client({
        name: 'claude-mem-search-chroma-client',
        version: '1.0.0'
      }, {
        capabilities: {}
      });

      await client.connect(chromaTransport);
      chromaClient = client;
      console.error('[search-server] Chroma client connected successfully');
    } catch (error: any) {
      console.error('[search-server] Failed to initialize Chroma client:', error.message);
      console.error('[search-server] Falling back to FTS5-only search');
      chromaClient = null;
    }
  }, 0);
}

main().catch((error) => {
  console.error('[search-server] Fatal error:', error);
  process.exit(1);
});
