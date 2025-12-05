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
import { silentDebug } from '../utils/silent-debug.js';

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

  silentDebug('queryChroma called', { query, limit, whereFilter });

  const whereStringified = whereFilter ? JSON.stringify(whereFilter) : undefined;
  silentDebug('where filter stringified', { whereFilter, whereStringified });

  const arguments_obj = {
    collection_name: COLLECTION_NAME,
    query_texts: [query],
    n_results: limit,
    include: ['documents', 'metadatas', 'distances'],
    where: whereStringified
  };
  silentDebug('calling chroma_query_documents', arguments_obj);

  const result = await chromaClient.callTool({
    name: 'chroma_query_documents',
    arguments: arguments_obj
  });

  const resultText = result.content[0]?.text || '';
  silentDebug('chroma response received', {
    hasContent: !!result.content[0]?.text,
    textLength: resultText.length,
    textPreview: resultText.substring(0, 200)
  });

  // Parse JSON response
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch (error) {
    console.error('[search-server] Failed to parse Chroma response as JSON:', error);
    console.error('[search-server] Raw Chroma response:', resultText);
    return { ids: [], distances: [], metadatas: [] };
  }

  // Extract unique IDs from document IDs
  const ids: number[] = [];
  const docIds = parsed.ids?.[0] || [];
  for (const docId of docIds) {
    // Extract sqlite_id from document ID (supports three formats):
    // - obs_{id}_narrative, obs_{id}_fact_0, etc (observations)
    // - summary_{id}_request, summary_{id}_learned, etc (session summaries)
    // - prompt_{id} (user prompts)
    const obsMatch = docId.match(/obs_(\d+)_/);
    const summaryMatch = docId.match(/summary_(\d+)_/);
    const promptMatch = docId.match(/prompt_(\d+)/);

    let sqliteId: number | null = null;
    if (obsMatch) {
      sqliteId = parseInt(obsMatch[1], 10);
    } else if (summaryMatch) {
      sqliteId = parseInt(summaryMatch[1], 10);
    } else if (promptMatch) {
      sqliteId = parseInt(promptMatch[1], 10);
    }

    if (sqliteId !== null && !ids.includes(sqliteId)) {
      ids.push(sqliteId);
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
4. Narrow down: Use filters (type, dateStart/dateEnd, concepts, files) to refine results

Other tips:
• To search by concept: Use find_by_concept tool
• To browse by type: Use find_by_type with ["decision", "feature", etc.]
• To sort by date: Use orderBy: "date_desc" or "date_asc"`;
}

/**
 * Timeline item for unified chronological display
 */
interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: any;
  epoch: number;
}

/**
 * Filter timeline items to respect depth_before/depth_after window around anchor
 */
function filterTimelineByDepth(
  items: TimelineItem[],
  anchorId: number | string,
  anchorEpoch: number,
  depth_before: number,
  depth_after: number
): TimelineItem[] {
  if (items.length === 0) return items;

  let anchorIndex = -1;
  if (typeof anchorId === 'number') {
    anchorIndex = items.findIndex(item => item.type === 'observation' && item.data.id === anchorId);
  } else if (typeof anchorId === 'string' && anchorId.startsWith('S')) {
    const sessionNum = parseInt(anchorId.slice(1), 10);
    anchorIndex = items.findIndex(item => item.type === 'session' && item.data.id === sessionNum);
  } else {
    // Timestamp anchor - find closest item
    anchorIndex = items.findIndex(item => item.epoch >= anchorEpoch);
    if (anchorIndex === -1) anchorIndex = items.length - 1;
  }

  if (anchorIndex === -1) return items;

  const startIndex = Math.max(0, anchorIndex - depth_before);
  const endIndex = Math.min(items.length, anchorIndex + depth_after + 1);
  return items.slice(startIndex, endIndex);
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
  const title = session.request || `Session ${session.sdk_session_id?.substring(0, 8) || 'unknown'}`;
  const date = new Date(session.created_at_epoch).toLocaleString();

  return `${index + 1}. ${title}
   Date: ${date}
   Source: claude-mem://session/${session.sdk_session_id}`;
}

/**
 * Format observation as text content with metadata
 */
function formatObservationResult(obs: ObservationSearchResult): string {
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
function formatSessionResult(session: SessionSummarySearchResult): string {
  const title = session.request || `Session ${session.sdk_session_id?.substring(0, 8) || 'unknown'}`;

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
 * Format user prompt as index entry (full text - don't truncate context!)
 */
function formatUserPromptIndex(prompt: UserPromptSearchResult, index: number): string {
  const date = new Date(prompt.created_at_epoch).toLocaleString();

  return `${index + 1}. "${prompt.prompt_text}"
   Date: ${date} | Prompt #${prompt.prompt_number}
   Source: claude-mem://user-prompt/${prompt.id}`;
}

/**
 * Format user prompt as text content with metadata
 */
function formatUserPromptResult(prompt: UserPromptSearchResult): string {
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
 * Helper to normalize query parameters from URL-friendly format
 * Converts comma-separated strings to arrays and flattens date params
 */
function normalizeParams(args: any): any {
  const normalized: any = { ...args };

  // Parse comma-separated concepts into array
  if (normalized.concepts && typeof normalized.concepts === 'string') {
    normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated files into array
  if (normalized.files && typeof normalized.files === 'string') {
    normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated obs_type into array
  if (normalized.obs_type && typeof normalized.obs_type === 'string') {
    normalized.obs_type = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated type (for filterSchema) into array
  if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
    normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Flatten dateStart/dateEnd into dateRange object
  if (normalized.dateStart || normalized.dateEnd) {
    normalized.dateRange = {
      start: normalized.dateStart,
      end: normalized.dateEnd
    };
    delete normalized.dateStart;
    delete normalized.dateEnd;
  }

  return normalized;
}

/**
 * Common filter schema (accepts simple strings that get normalized to arrays)
 */
const filterSchema = z.object({
  project: z.string().optional().describe('Filter by project name'),
  type: z.union([
    z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']),
    z.array(z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']))
  ]).optional().describe('Filter by observation type (single value or comma-separated list)'),
  concepts: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by concept tags (single value or comma-separated list)'),
  files: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
  dateStart: z.union([z.string(), z.number()]).optional().describe('Start date (ISO string or epoch)'),
  dateEnd: z.union([z.string(), z.number()]).optional().describe('End date (ISO string or epoch)'),
  dateRange: z.object({
    start: z.union([z.string(), z.number()]).optional().describe('Start date (ISO string or epoch)'),
    end: z.union([z.string(), z.number()]).optional().describe('End date (ISO string or epoch)')
  }).optional().describe('Filter by date range (use dateStart/dateEnd instead for simpler URLs)'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
  offset: z.number().min(0).default(0).describe('Number of results to skip'),
  orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
});

// Define tool schemas
const tools = [
  {
    name: 'search',
    description: 'Unified search across all memory types (observations, sessions, and user prompts) using vector-first semantic search (ChromaDB). Returns combined results from all document types. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().optional().describe('Natural language search query for semantic ranking via ChromaDB vector search. Optional - omit for date-filtered queries only (Chroma cannot filter by date, requires direct SQLite).'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Filter by document type (observations, sessions, or prompts). Omit to search all types.'),
      obs_type: z.string().optional().describe('Filter observations by type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change). Only applies when type="observations"'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list). Only applies when type="observations"'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match). Only applies when type="observations"'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        // Normalize URL-friendly params to internal format
        const normalized = normalizeParams(args);
        const { query, format = 'index', type, obs_type, concepts, files, ...options } = normalized;
        let observations: ObservationSearchResult[] = [];
        let sessions: SessionSummarySearchResult[] = [];
        let prompts: UserPromptSearchResult[] = [];

        // Determine which types to query based on type filter
        const searchObservations = !type || type === 'observations';
        const searchSessions = !type || type === 'sessions';
        const searchPrompts = !type || type === 'prompts';

        // PATH 1: FILTER-ONLY (no query text) - Skip Chroma/FTS5, use direct SQLite filtering
        // This path enables date filtering which Chroma cannot do (requires direct SQLite access)
        if (!query) {
          console.error(`[search-server] Filter-only query (no query text), using direct SQLite filtering (enables date filters)`);
          const obsOptions = { ...options, type: obs_type, concepts, files };
          if (searchObservations) {
            observations = search.searchObservations(undefined, obsOptions);
          }
          if (searchSessions) {
            sessions = search.searchSessions(undefined, options);
          }
          if (searchPrompts) {
            prompts = search.searchUserPrompts(undefined, options);
          }
        }
        // PATH 2: CHROMA SEMANTIC SEARCH (query text + Chroma available)
        else if (chromaClient) {
          let chromaSucceeded = false;
          try {
            console.error(`[search-server] Using ChromaDB semantic search (type filter: ${type || 'all'})`);

            // Build Chroma where filter for doc_type
            let whereFilter: Record<string, any> | undefined;
            if (type === 'observations') {
              whereFilter = { doc_type: 'observation' };
            } else if (type === 'sessions') {
              whereFilter = { doc_type: 'session_summary' };
            } else if (type === 'prompts') {
              whereFilter = { doc_type: 'user_prompt' };
            }

            // Step 1: Chroma semantic search with optional type filter
            const chromaResults = await queryChroma(query, 100, whereFilter);
            chromaSucceeded = true; // Chroma didn't throw error
            console.error(`[search-server] ChromaDB returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Step 2: Filter by recency (90 days)
              const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
              const recentMetadata = chromaResults.metadatas.map((meta, idx) => ({
                id: chromaResults.ids[idx],
                meta,
                isRecent: meta && meta.created_at_epoch > ninetyDaysAgo
              })).filter(item => item.isRecent);

              console.error(`[search-server] ${recentMetadata.length} results within 90-day window`);

              // Step 3: Categorize IDs by document type
              const obsIds: number[] = [];
              const sessionIds: number[] = [];
              const promptIds: number[] = [];

              for (const item of recentMetadata) {
                const docType = item.meta?.doc_type;
                if (docType === 'observation' && searchObservations) {
                  obsIds.push(item.id);
                } else if (docType === 'session_summary' && searchSessions) {
                  sessionIds.push(item.id);
                } else if (docType === 'user_prompt' && searchPrompts) {
                  promptIds.push(item.id);
                }
              }

              console.error(`[search-server] Categorized: ${obsIds.length} obs, ${sessionIds.length} sessions, ${promptIds.length} prompts`);

              // Step 4: Hydrate from SQLite with additional filters
              if (obsIds.length > 0) {
                // Apply obs_type, concepts, files filters if provided
                const obsOptions = { ...options, type: obs_type, concepts, files };
                observations = store.getObservationsByIds(obsIds, obsOptions);
              }
              if (sessionIds.length > 0) {
                sessions = store.getSessionSummariesByIds(sessionIds, { orderBy: 'date_desc', limit: options.limit });
              }
              if (promptIds.length > 0) {
                prompts = store.getUserPromptsByIds(promptIds, { orderBy: 'date_desc', limit: options.limit });
              }

              console.error(`[search-server] Hydrated ${observations.length} obs, ${sessions.length} sessions, ${prompts.length} prompts from SQLite`);
            } else {
              // Chroma returned 0 results - this is the correct answer, don't fall back to FTS5
              console.error(`[search-server] ChromaDB found no matches (this is final - NOT falling back to FTS5)`);
            }
          } catch (chromaError: any) {
            console.error('[search-server] ChromaDB failed - returning empty results (FTS5 fallback removed):', chromaError.message);
            console.error('[search-server] Install UVX/Python to enable vector search: https://docs.astral.sh/uv/getting-started/installation/');
            // Return empty results - no fallback
            observations = [];
            sessions = [];
            prompts = [];
          }
        }
        // ChromaDB not initialized - return empty results (no fallback)
        else {
          console.error(`[search-server] ChromaDB not initialized - returning empty results (FTS5 fallback removed)`);
          console.error(`[search-server] Install UVX/Python to enable vector search: https://docs.astral.sh/uv/getting-started/installation/`);
          observations = [];
          sessions = [];
          prompts = [];
        }

        const totalResults = observations.length + sessions.length + prompts.length;

        if (totalResults === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No results found matching "${query}"`
            }]
          };
        }

        // Combine all results with timestamps for unified sorting
        interface CombinedResult {
          type: 'observation' | 'session' | 'prompt';
          data: any;
          epoch: number;
        }

        const allResults: CombinedResult[] = [
          ...observations.map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
          ...sessions.map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
          ...prompts.map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
        ];

        // Sort by date (most recent first)
        if (options.orderBy === 'date_desc') {
          allResults.sort((a, b) => b.epoch - a.epoch);
        } else if (options.orderBy === 'date_asc') {
          allResults.sort((a, b) => a.epoch - b.epoch);
        }

        // Apply limit across all types
        const limitedResults = allResults.slice(0, options.limit || 20);

        // Format based on requested format
        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${totalResults} result(s) matching "${query}" (${observations.length} obs, ${sessions.length} sessions, ${prompts.length} prompts):\n\n`;
          const formattedResults = limitedResults.map((item, i) => {
            if (item.type === 'observation') {
              return formatObservationIndex(item.data, i);
            } else if (item.type === 'session') {
              return formatSessionIndex(item.data, i);
            } else {
              return formatUserPromptIndex(item.data, i);
            }
          });
          combinedText = header + formattedResults.join('\n\n') + formatSearchTips();
        } else {
          const formattedResults = limitedResults.map(item => {
            if (item.type === 'observation') {
              return formatObservationResult(item.data);
            } else if (item.type === 'session') {
              return formatSessionResult(item.data);
            } else {
              return formatUserPromptResult(item.data);
            }
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
    name: 'timeline',
    description: 'Get a unified timeline of context around a specific point in time OR search query. Supports two modes: (1) anchor-based: provide observation ID, session ID, or timestamp to center timeline around; (2) query-based: provide natural language query to find relevant observation and center timeline around it. All record types (observations, sessions, prompts) are interleaved chronologically.',
    inputSchema: z.object({
      anchor: z.union([
        z.number(),
        z.string()
      ]).optional().describe('Anchor point: observation ID (number), session ID (e.g., "S123"), or ISO timestamp. Use this OR query, not both.'),
      query: z.string().optional().describe('Natural language search query to find relevant observation as anchor. Use this OR anchor, not both.'),
      depth_before: z.number().min(0).max(50).default(10).describe('Number of records to retrieve before anchor (default: 10)'),
      depth_after: z.number().min(0).max(50).default(10).describe('Number of records to retrieve after anchor (default: 10)'),
      project: z.string().optional().describe('Filter by project name')
    }),
    handler: async (args: any) => {
      try {
        const { anchor, query, depth_before = 10, depth_after = 10, project } = args;

        // Validate: must provide either anchor or query, not both
        if (!anchor && !query) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: Must provide either "anchor" or "query" parameter'
            }],
            isError: true
          };
        }

        if (anchor && query) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: Cannot provide both "anchor" and "query" parameters. Use one or the other.'
            }],
            isError: true
          };
        }

        let anchorId: string | number;
        let anchorEpoch: number;
        let timeline: any;

        // MODE 1: Query-based timeline
        if (query) {
          // Step 1: Search for observations
          let results: ObservationSearchResult[] = [];

          if (chromaClient) {
            try {
              console.error('[search-server] Using hybrid semantic search for timeline query');
              const chromaResults = await queryChroma(query, 100);
              console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

              if (chromaResults.ids.length > 0) {
                const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
                const recentIds = chromaResults.ids.filter((_id, idx) => {
                  const meta = chromaResults.metadatas[idx];
                  return meta && meta.created_at_epoch > ninetyDaysAgo;
                });

                if (recentIds.length > 0) {
                  results = store.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit: 1 });
                }
              }
            } catch (chromaError: any) {
              console.error('[search-server] Chroma query failed - no results (FTS5 fallback removed):', chromaError.message);
            }
          }

          if (results.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `No observations found matching "${query}". Try a different search query.`
              }]
            };
          }

          // Use top result as anchor
          const topResult = results[0];
          anchorId = topResult.id;
          anchorEpoch = topResult.created_at_epoch;
          console.error(`[search-server] Query mode: Using observation #${topResult.id} as timeline anchor`);
          timeline = store.getTimelineAroundObservation(topResult.id, topResult.created_at_epoch, depth_before, depth_after, project);
        }
        // MODE 2: Anchor-based timeline
        else if (typeof anchor === 'number') {
          // Observation ID
          const obs = store.getObservationById(anchor);
          if (!obs) {
            return {
              content: [{
                type: 'text' as const,
                text: `Observation #${anchor} not found`
              }],
              isError: true
            };
          }
          anchorId = anchor;
          anchorEpoch = obs.created_at_epoch;
          timeline = store.getTimelineAroundObservation(anchor, anchorEpoch, depth_before, depth_after, project);
        } else if (typeof anchor === 'string') {
          // Session ID or ISO timestamp
          if (anchor.startsWith('S') || anchor.startsWith('#S')) {
            const sessionId = anchor.replace(/^#?S/, '');
            const sessionNum = parseInt(sessionId, 10);
            const sessions = store.getSessionSummariesByIds([sessionNum]);
            if (sessions.length === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Session #${sessionNum} not found`
                }],
                isError: true
              };
            }
            anchorEpoch = sessions[0].created_at_epoch;
            anchorId = `S${sessionNum}`;
            timeline = store.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
          } else {
            // ISO timestamp
            const date = new Date(anchor);
            if (isNaN(date.getTime())) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Invalid timestamp: ${anchor}`
                }],
                isError: true
              };
            }
            anchorEpoch = date.getTime();
            anchorId = anchor;
            timeline = store.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
          }
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: 'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'
            }],
            isError: true
          };
        }

        // Combine, sort, and filter timeline items
        const items: TimelineItem[] = [
          ...timeline.observations.map((obs: any) => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
          ...timeline.sessions.map((sess: any) => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
          ...timeline.prompts.map((prompt: any) => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
        ];
        items.sort((a, b) => a.epoch - b.epoch);
        const filteredItems = filterTimelineByDepth(items, anchorId, anchorEpoch, depth_before, depth_after);

        if (filteredItems.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: query
                ? `Found observation matching "${query}", but no timeline context available (${depth_before} records before, ${depth_after} records after).`
                : `No context found around anchor (${depth_before} records before, ${depth_after} records after)`
            }]
          };
        }

        // Format timeline (helper functions)
        function formatDate(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          });
        }

        function formatTime(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
        }

        function formatDateTime(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
        }

        function estimateTokens(text: string | null): number {
          if (!text) return 0;
          return Math.ceil(text.length / 4);
        }

        // Format results
        const lines: string[] = [];

        // Header
        if (query) {
          const anchorObs = filteredItems.find(item => item.type === 'observation' && item.data.id === anchorId);
          const anchorTitle = anchorObs ? (anchorObs.data.title || 'Untitled') : 'Unknown';
          lines.push(`# Timeline for query: "${query}"`);
          lines.push(`**Anchor:** Observation #${anchorId} - ${anchorTitle}`);
        } else {
          lines.push(`# Timeline around anchor: ${anchorId}`);
        }

        lines.push(`**Window:** ${depth_before} records before → ${depth_after} records after | **Items:** ${filteredItems.length}`);
        lines.push('');

        // Legend
        lines.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision`);
        lines.push('');

        // Group by day
        const dayMap = new Map<string, TimelineItem[]>();
        for (const item of filteredItems) {
          const day = formatDate(item.epoch);
          if (!dayMap.has(day)) {
            dayMap.set(day, []);
          }
          dayMap.get(day)!.push(item);
        }

        // Sort days chronologically
        const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
          const aDate = new Date(a[0]).getTime();
          const bDate = new Date(b[0]).getTime();
          return aDate - bDate;
        });

        // Render each day
        for (const [day, dayItems] of sortedDays) {
          lines.push(`### ${day}`);
          lines.push('');

          let currentFile: string | null = null;
          let lastTime = '';
          let tableOpen = false;

          for (const item of dayItems) {
            const isAnchor = (
              (typeof anchorId === 'number' && item.type === 'observation' && item.data.id === anchorId) ||
              (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session' && `S${item.data.id}` === anchorId)
            );

            if (item.type === 'session') {
              if (tableOpen) {
                lines.push('');
                tableOpen = false;
                currentFile = null;
                lastTime = '';
              }

              const sess = item.data;
              const title = sess.request || 'Session summary';
              const link = `claude-mem://session-summary/${sess.id}`;
              const marker = isAnchor ? ' ← **ANCHOR**' : '';

              lines.push(`**🎯 #S${sess.id}** ${title} (${formatDateTime(item.epoch)}) [→](${link})${marker}`);
              lines.push('');
            } else if (item.type === 'prompt') {
              if (tableOpen) {
                lines.push('');
                tableOpen = false;
                currentFile = null;
                lastTime = '';
              }

              const prompt = item.data;
              const truncated = prompt.prompt.length > 100 ? prompt.prompt.substring(0, 100) + '...' : prompt.prompt;

              lines.push(`**💬 User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
              lines.push(`> ${truncated}`);
              lines.push('');
            } else if (item.type === 'observation') {
              const obs = item.data;
              const file = 'General';

              if (file !== currentFile) {
                if (tableOpen) {
                  lines.push('');
                }

                lines.push(`**${file}**`);
                lines.push(`| ID | Time | T | Title | Tokens |`);
                lines.push(`|----|------|---|-------|--------|`);

                currentFile = file;
                tableOpen = true;
                lastTime = '';
              }

              let icon = '•';
              switch (obs.type) {
                case 'bugfix': icon = '🔴'; break;
                case 'feature': icon = '🟣'; break;
                case 'refactor': icon = '🔄'; break;
                case 'change': icon = '✅'; break;
                case 'discovery': icon = '🔵'; break;
                case 'decision': icon = '🧠'; break;
              }

              const time = formatTime(item.epoch);
              const title = obs.title || 'Untitled';
              const tokens = estimateTokens(obs.narrative);

              const showTime = time !== lastTime;
              const timeDisplay = showTime ? time : '″';
              lastTime = time;

              const anchorMarker = isAnchor ? ' ← **ANCHOR**' : '';
              lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
            }
          }

          if (tableOpen) {
            lines.push('');
          }
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
            text: `Timeline query failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'decisions',
    description: 'Semantic shortcut to find decision-type observations. Returns observations where important architectural, technical, or process decisions were made. Supports optional semantic search query to filter decisions by relevance.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query to filter decisions semantically'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default), "full" for complete details'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { query, format = 'index', ...filters } = normalized;
        let results: ObservationSearchResult[] = [];

        // Search for decision-type observations
        if (chromaClient) {
          try {
            if (query) {
              // Semantic search filtered to decision type
              console.error('[search-server] Using Chroma semantic search with type=decision filter');
              const chromaResults = await queryChroma(query, Math.min((filters.limit || 20) * 2, 100), { type: 'decision' });
              const obsIds = chromaResults.ids;

              if (obsIds.length > 0) {
                results = store.getObservationsByIds(obsIds, { ...filters, type: 'decision' });
                // Preserve Chroma ranking order
                results.sort((a, b) => obsIds.indexOf(a.id) - obsIds.indexOf(b.id));
              }
            } else {
              // No query: get all decisions, rank by "decision" keyword
              console.error('[search-server] Using metadata-first + semantic ranking for decisions');
              const metadataResults = search.findByType('decision', filters);

              if (metadataResults.length > 0) {
                const ids = metadataResults.map(obs => obs.id);
                const chromaResults = await queryChroma('decision', Math.min(ids.length, 100));

                const rankedIds: number[] = [];
                for (const chromaId of chromaResults.ids) {
                  if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                    rankedIds.push(chromaId);
                  }
                }

                if (rankedIds.length > 0) {
                  results = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                  results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
                }
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma search failed, using SQLite fallback:', chromaError.message);
          }
        }

        if (results.length === 0) {
          results = search.findByType('decision', filters);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No decision observations found'
            }]
          };
        }

        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} decision(s):\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n');
        } else {
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
    name: 'changes',
    description: 'Semantic shortcut to find change-related observations. Returns observations documenting what changed in the codebase, system behavior, or project state. Searches for type="change" OR concept="change" OR concept="what-changed".',
    inputSchema: z.object({
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default), "full" for complete details'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { format = 'index', ...filters } = normalized;
        let results: ObservationSearchResult[] = [];

        // Search for change-type observations and change-related concepts
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid search for change-related observations');

            // Get all observations with type="change" or concepts containing change
            const typeResults = search.findByType('change', filters);
            const conceptChangeResults = search.findByConcept('change', filters);
            const conceptWhatChangedResults = search.findByConcept('what-changed', filters);

            // Combine and deduplicate
            const allIds = new Set<number>();
            [...typeResults, ...conceptChangeResults, ...conceptWhatChangedResults].forEach(obs => allIds.add(obs.id));

            if (allIds.size > 0) {
              const idsArray = Array.from(allIds);
              const chromaResults = await queryChroma('what changed', Math.min(idsArray.length, 100));

              const rankedIds: number[] = [];
              for (const chromaId of chromaResults.ids) {
                if (idsArray.includes(chromaId) && !rankedIds.includes(chromaId)) {
                  rankedIds.push(chromaId);
                }
              }

              if (rankedIds.length > 0) {
                results = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma ranking failed, using SQLite order:', chromaError.message);
          }
        }

        if (results.length === 0) {
          const typeResults = search.findByType('change', filters);
          const conceptResults = search.findByConcept('change', filters);
          const whatChangedResults = search.findByConcept('what-changed', filters);

          const allIds = new Set<number>();
          [...typeResults, ...conceptResults, ...whatChangedResults].forEach(obs => allIds.add(obs.id));

          results = Array.from(allIds).map(id =>
            typeResults.find(obs => obs.id === id) ||
            conceptResults.find(obs => obs.id === id) ||
            whatChangedResults.find(obs => obs.id === id)
          ).filter(Boolean) as ObservationSearchResult[];

          results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
          results = results.slice(0, filters.limit || 20);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No change-related observations found'
            }]
          };
        }

        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} change-related observation(s):\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n');
        } else {
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
    name: 'how_it_works',
    description: 'Semantic shortcut to find "how it works" explanations. Returns observations documenting system architecture, component interactions, data flow, and technical mechanisms. Searches for concept="how-it-works".',
    inputSchema: z.object({
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default), "full" for complete details'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { format = 'index', ...filters } = normalized;
        let results: ObservationSearchResult[] = [];

        // Search for how-it-works concept observations
        if (chromaClient) {
          try {
            console.error('[search-server] Using metadata-first + semantic ranking for how-it-works');
            const metadataResults = search.findByConcept('how-it-works', filters);

            if (metadataResults.length > 0) {
              const ids = metadataResults.map(obs => obs.id);
              const chromaResults = await queryChroma('how it works architecture', Math.min(ids.length, 100));

              const rankedIds: number[] = [];
              for (const chromaId of chromaResults.ids) {
                if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                  rankedIds.push(chromaId);
                }
              }

              if (rankedIds.length > 0) {
                results = store.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
                results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma ranking failed, using SQLite order:', chromaError.message);
          }
        }

        if (results.length === 0) {
          results = search.findByConcept('how-it-works', filters);
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No "how it works" observations found'
            }]
          };
        }

        let combinedText: string;
        if (format === 'index') {
          const header = `Found ${results.length} "how it works" observation(s):\n\n`;
          const formattedResults = results.map((obs, i) => formatObservationIndex(obs, i));
          combinedText = header + formattedResults.join('\n\n');
        } else {
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
    name: 'search_observations',
    description: 'DEPRECATED: Use the unified "search" tool instead. Search observations using vector-first semantic search (ChromaDB). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query for semantic ranking via ChromaDB vector search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      ...filterSchema.shape
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { query, format = 'index', ...options } = normalized;
        let results: ObservationSearchResult[] = [];

        // Vector-first search via ChromaDB
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid semantic search (Chroma + SQLite)');

            // Step 1: Chroma semantic search (top 100)
            const chromaResults = await queryChroma(query, 100);
            console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Step 2: Filter by recency (90 days)
              const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
              const recentIds = chromaResults.ids.filter((_id, idx) => {
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
            console.error('[search-server] Chroma query failed - no results (FTS5 fallback removed):', chromaError.message);
          }
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
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
    description: 'DEPRECATED: Use the unified "search" tool instead. Search session summaries using vector-first semantic search (ChromaDB). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query for semantic ranking via ChromaDB vector search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { query, format = 'index', ...options } = normalized;
        let results: SessionSummarySearchResult[] = [];

        // Vector-first search via ChromaDB
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid semantic search for sessions');

            // Step 1: Chroma semantic search (top 100)
            const chromaResults = await queryChroma(query, 100, { doc_type: 'session_summary' });
            console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Step 2: Filter by recency (90 days)
              const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
              const recentIds = chromaResults.ids.filter((_id, idx) => {
                const meta = chromaResults.metadatas[idx];
                return meta && meta.created_at_epoch > ninetyDaysAgo;
              });

              console.error(`[search-server] ${recentIds.length} results within 90-day window`);

              // Step 3: Hydrate from SQLite in temporal order
              if (recentIds.length > 0) {
                const limit = options.limit || 20;
                results = store.getSessionSummariesByIds(recentIds, { orderBy: 'date_desc', limit });
                console.error(`[search-server] Hydrated ${results.length} sessions from SQLite`);
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma query failed - no results (FTS5 fallback removed):', chromaError.message);
          }
        }

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
          const formattedResults = results.map((session) => formatSessionResult(session));
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
    description: 'Find observations tagged with a specific concept. Available concepts: "discovery", "problem-solution", "what-changed", "how-it-works", "pattern", "gotcha", "change". IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      concept: z.string().describe('Concept tag to search for. Available: discovery, problem-solution, what-changed, how-it-works, pattern, gotcha, change'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { concept, format = 'index', ...filters } = normalized;
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
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { filePath, format = 'index', ...filters } = normalized;
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
          observations.forEach((obs) => {
            formattedResults.push(formatObservationResult(obs));
          });

          // Add sessions
          sessions.forEach((session) => {
            formattedResults.push(formatSessionResult(session));
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
      type: z.string().describe('Observation type(s) to filter by (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode.'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { type, format = 'index', ...filters } = normalized;
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
          const formattedResults = results.map((obs) => formatObservationResult(obs));
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
    description: 'DEPRECATED: Use the unified "search" tool instead. Search raw user prompts using vector-first semantic search (ChromaDB). Use this to find what the user actually said/requested across all sessions. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query for semantic ranking via ChromaDB vector search'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for truncated prompts/dates (default, RECOMMENDED for initial search), "full" for complete prompt text (use only after reviewing index results)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      try {
        const normalized = normalizeParams(args);
        const { query, format = 'index', ...options } = normalized;
        let results: UserPromptSearchResult[] = [];

        // Vector-first search via ChromaDB
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid semantic search for user prompts');

            // Step 1: Chroma semantic search (top 100)
            const chromaResults = await queryChroma(query, 100, { doc_type: 'user_prompt' });
            console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Step 2: Filter by recency (90 days)
              const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
              const recentIds = chromaResults.ids.filter((_id, idx) => {
                const meta = chromaResults.metadatas[idx];
                return meta && meta.created_at_epoch > ninetyDaysAgo;
              });

              console.error(`[search-server] ${recentIds.length} results within 90-day window`);

              // Step 3: Hydrate from SQLite in temporal order
              if (recentIds.length > 0) {
                const limit = options.limit || 20;
                results = store.getUserPromptsByIds(recentIds, { orderBy: 'date_desc', limit });
                console.error(`[search-server] Hydrated ${results.length} user prompts from SQLite`);
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma query failed - no results (FTS5 fallback removed):', chromaError.message);
          }
        }

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
          const formattedResults = results.map((prompt) => formatUserPromptResult(prompt));
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
    name: 'get_context_timeline',
    description: 'Get a unified timeline of context (observations, sessions, and prompts) around a specific point in time. All record types are interleaved chronologically. Useful for understanding "what was happening when X occurred". Returns depth_before records before anchor + anchor + depth_after records after (total: depth_before + 1 + depth_after mixed records).',
    inputSchema: z.object({
      anchor: z.union([
        z.number().describe('Observation ID to center timeline around'),
        z.string().describe('Session ID (format: S123) or ISO timestamp to center timeline around')
      ]).describe('Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp'),
      depth_before: z.number().min(0).max(50).default(10).describe('Number of records to retrieve before anchor, not including anchor (default: 10)'),
      depth_after: z.number().min(0).max(50).default(10).describe('Number of records to retrieve after anchor, not including anchor (default: 10)'),
      project: z.string().optional().describe('Filter by project name')
    }),
    handler: async (args: any) => {
      try {
        const { anchor, depth_before = 10, depth_after = 10, project } = args;
        let anchorEpoch: number;
        let anchorId: string | number = anchor;

        // Resolve anchor and get timeline data
        let timeline;
        if (typeof anchor === 'number') {
          // Observation ID - use ID-based boundary detection
          const obs = store.getObservationById(anchor);
          if (!obs) {
            return {
              content: [{
                type: 'text' as const,
                text: `Observation #${anchor} not found`
              }],
              isError: true
            };
          }
          anchorEpoch = obs.created_at_epoch;
          timeline = store.getTimelineAroundObservation(anchor, anchorEpoch, depth_before, depth_after, project);
        } else if (typeof anchor === 'string') {
          // Session ID or ISO timestamp
          if (anchor.startsWith('S') || anchor.startsWith('#S')) {
            const sessionId = anchor.replace(/^#?S/, '');
            const sessionNum = parseInt(sessionId, 10);
            const sessions = store.getSessionSummariesByIds([sessionNum]);
            if (sessions.length === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Session #${sessionNum} not found`
                }],
                isError: true
              };
            }
            anchorEpoch = sessions[0].created_at_epoch;
            anchorId = `S${sessionNum}`;
            timeline = store.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
          } else {
            // ISO timestamp
            const date = new Date(anchor);
            if (isNaN(date.getTime())) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Invalid timestamp: ${anchor}`
                }],
                isError: true
              };
            }
            anchorEpoch = date.getTime(); // Keep as milliseconds
            timeline = store.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
          }
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: 'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'
            }],
            isError: true
          };
        }

        // Combine, sort, and filter timeline items
        const items: TimelineItem[] = [
          ...timeline.observations.map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
          ...timeline.sessions.map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
          ...timeline.prompts.map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
        ];
        items.sort((a, b) => a.epoch - b.epoch);
        const filteredItems = filterTimelineByDepth(items, anchorId, anchorEpoch, depth_before, depth_after);

        if (filteredItems.length === 0) {
          const anchorDate = new Date(anchorEpoch).toLocaleString();
          return {
            content: [{
              type: 'text' as const,
              text: `No context found around ${anchorDate} (${depth_before} records before, ${depth_after} records after)`
            }]
          };
        }

        // Helper functions matching context-hook.ts
        function formatDate(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          });
        }

        function formatTime(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
        }

        function formatDateTime(epochMs: number): string {
          const date = new Date(epochMs);
          return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
        }

        function estimateTokens(text: string | null): number {
          if (!text) return 0;
          return Math.ceil(text.length / 4);
        }

        // Format results matching context-hook.ts exactly
        const lines: string[] = [];

        // Header
        lines.push(`# Timeline around anchor: ${anchorId}`);
        lines.push(`**Window:** ${depth_before} records before → ${depth_after} records after | **Items:** ${filteredItems.length}`);
        lines.push('');

        // Legend
        lines.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision`);
        lines.push('');

        // Group by day
        const dayMap = new Map<string, TimelineItem[]>();
        for (const item of filteredItems) {
          const day = formatDate(item.epoch);
          if (!dayMap.has(day)) {
            dayMap.set(day, []);
          }
          dayMap.get(day)!.push(item);
        }

        // Sort days chronologically
        const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
          const aDate = new Date(a[0]).getTime();
          const bDate = new Date(b[0]).getTime();
          return aDate - bDate;
        });

        // Render each day
        for (const [day, dayItems] of sortedDays) {
          lines.push(`### ${day}`);
          lines.push('');

          let currentFile: string | null = null;
          let lastTime = '';
          let tableOpen = false;

          for (const item of dayItems) {
            const isAnchor = (
              (typeof anchorId === 'number' && item.type === 'observation' && item.data.id === anchorId) ||
              (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session' && `S${item.data.id}` === anchorId)
            );

            if (item.type === 'session') {
              // Close any open table
              if (tableOpen) {
                lines.push('');
                tableOpen = false;
                currentFile = null;
                lastTime = '';
              }

              // Render session
              const sess = item.data;
              const title = sess.request || 'Session summary';
              const link = `claude-mem://session-summary/${sess.id}`;
              const marker = isAnchor ? ' ← **ANCHOR**' : '';

              lines.push(`**🎯 #S${sess.id}** ${title} (${formatDateTime(item.epoch)}) [→](${link})${marker}`);
              lines.push('');
            } else if (item.type === 'prompt') {
              // Close any open table
              if (tableOpen) {
                lines.push('');
                tableOpen = false;
                currentFile = null;
                lastTime = '';
              }

              // Render prompt
              const prompt = item.data;
              const truncated = prompt.prompt.length > 100 ? prompt.prompt.substring(0, 100) + '...' : prompt.prompt;

              lines.push(`**💬 User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
              lines.push(`> ${truncated}`);
              lines.push('');
            } else if (item.type === 'observation') {
              // Render observation in table
              const obs = item.data;
              const file = 'General'; // Simplified for timeline view

              // Check if we need a new file section
              if (file !== currentFile) {
                // Close previous table
                if (tableOpen) {
                  lines.push('');
                }

                // File header
                lines.push(`**${file}**`);
                lines.push(`| ID | Time | T | Title | Tokens |`);
                lines.push(`|----|------|---|-------|--------|`);

                currentFile = file;
                tableOpen = true;
                lastTime = '';
              }

              // Map observation type to emoji
              let icon = '•';
              switch (obs.type) {
                case 'bugfix': icon = '🔴'; break;
                case 'feature': icon = '🟣'; break;
                case 'refactor': icon = '🔄'; break;
                case 'change': icon = '✅'; break;
                case 'discovery': icon = '🔵'; break;
                case 'decision': icon = '🧠'; break;
              }

              const time = formatTime(item.epoch);
              const title = obs.title || 'Untitled';
              const tokens = estimateTokens(obs.narrative);

              const showTime = time !== lastTime;
              const timeDisplay = showTime ? time : '″';
              lastTime = time;

              const anchorMarker = isAnchor ? ' ← **ANCHOR**' : '';
              lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
            }
          }

          // Close final table if open
          if (tableOpen) {
            lines.push('');
          }
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
            text: `Timeline query failed: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  {
    name: 'get_timeline_by_query',
    description: 'Search for observations using natural language and get timeline context around the best match. Two modes: "auto" (default) automatically uses top result as timeline anchor; "interactive" returns top matches for you to choose from. This combines search + timeline into a single operation for faster context discovery.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query to find relevant observations'),
      mode: z.enum(['auto', 'interactive']).default('auto').describe('auto: Automatically use top search result as timeline anchor. interactive: Show top N search results for manual anchor selection.'),
      depth_before: z.number().min(0).max(50).default(10).describe('Number of timeline records before anchor (default: 10)'),
      depth_after: z.number().min(0).max(50).default(10).describe('Number of timeline records after anchor (default: 10)'),
      limit: z.number().min(1).max(20).default(5).describe('For interactive mode: number of top search results to display (default: 5)'),
      project: z.string().optional().describe('Filter by project name')
    }),
    handler: async (args: any) => {
      try {
        const { query, mode = 'auto', depth_before = 10, depth_after = 10, limit = 5, project } = args;

        // Step 1: Search for observations
        let results: ObservationSearchResult[] = [];

        // Use hybrid search if available
        if (chromaClient) {
          try {
            console.error('[search-server] Using hybrid semantic search for timeline query');
            const chromaResults = await queryChroma(query, 100);
            console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

            if (chromaResults.ids.length > 0) {
              // Filter by recency (90 days)
              const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
              const recentIds = chromaResults.ids.filter((_id, idx) => {
                const meta = chromaResults.metadatas[idx];
                return meta && meta.created_at_epoch > ninetyDaysAgo;
              });

              console.error(`[search-server] ${recentIds.length} results within 90-day window`);

              if (recentIds.length > 0) {
                results = store.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit: mode === 'auto' ? 1 : limit });
                console.error(`[search-server] Hydrated ${results.length} observations from SQLite`);
              }
            }
          } catch (chromaError: any) {
            console.error('[search-server] Chroma query failed - no results (FTS5 fallback removed):', chromaError.message);
          }
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No observations found matching "${query}". Try a different search query.`
            }]
          };
        }

        // Step 2: Handle based on mode
        if (mode === 'interactive') {
          // Return formatted index of top results for LLM to choose from
          const lines: string[] = [];
          lines.push(`# Timeline Anchor Search Results`);
          lines.push('');
          lines.push(`Found ${results.length} observation(s) matching "${query}"`);
          lines.push('');
          lines.push(`To get timeline context around any of these observations, use the \`get_context_timeline\` tool with the observation ID as the anchor.`);
          lines.push('');
          lines.push(`**Top ${results.length} matches:**`);
          lines.push('');

          for (let i = 0; i < results.length; i++) {
            const obs = results[i];
            const title = obs.title || `Observation #${obs.id}`;
            const date = new Date(obs.created_at_epoch).toLocaleString();
            const type = obs.type ? `[${obs.type}]` : '';

            lines.push(`${i + 1}. **${type} ${title}**`);
            lines.push(`   - ID: ${obs.id}`);
            lines.push(`   - Date: ${date}`);
            if (obs.subtitle) {
              lines.push(`   - ${obs.subtitle}`);
            }
            lines.push(`   - Source: claude-mem://observation/${obs.id}`);
            lines.push('');
          }

          return {
            content: [{
              type: 'text' as const,
              text: lines.join('\n')
            }]
          };
        } else {
          // Auto mode: Use top result as timeline anchor
          const topResult = results[0];
          console.error(`[search-server] Auto mode: Using observation #${topResult.id} as timeline anchor`);

          // Get timeline around this observation
          const timeline = store.getTimelineAroundObservation(
            topResult.id,
            topResult.created_at_epoch,
            depth_before,
            depth_after,
            project
          );

          // Combine, sort, and filter timeline items
          const items: TimelineItem[] = [
            ...timeline.observations.map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
            ...timeline.sessions.map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
            ...timeline.prompts.map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
          ];
          items.sort((a, b) => a.epoch - b.epoch);
          const filteredItems = filterTimelineByDepth(items, topResult.id, 0, depth_before, depth_after);

          if (filteredItems.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `Found observation #${topResult.id} matching "${query}", but no timeline context available (${depth_before} records before, ${depth_after} records after).`
              }]
            };
          }

          // Helper functions (reused from get_context_timeline)
          function formatDate(epochMs: number): string {
            const date = new Date(epochMs);
            return date.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            });
          }

          function formatTime(epochMs: number): string {
            const date = new Date(epochMs);
            return date.toLocaleString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            });
          }

          function formatDateTime(epochMs: number): string {
            const date = new Date(epochMs);
            return date.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            });
          }

          function estimateTokens(text: string | null): number {
            if (!text) return 0;
            return Math.ceil(text.length / 4);
          }

          // Format timeline (reused from get_context_timeline)
          const lines: string[] = [];

          // Header
          lines.push(`# Timeline for query: "${query}"`);
          lines.push(`**Anchor:** Observation #${topResult.id} - ${topResult.title || 'Untitled'}`);
          lines.push(`**Window:** ${depth_before} records before → ${depth_after} records after | **Items:** ${filteredItems.length}`);
          lines.push('');

          // Legend
          lines.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision`);
          lines.push('');

          // Group by day
          const dayMap = new Map<string, TimelineItem[]>();
          for (const item of filteredItems) {
            const day = formatDate(item.epoch);
            if (!dayMap.has(day)) {
              dayMap.set(day, []);
            }
            dayMap.get(day)!.push(item);
          }

          // Sort days chronologically
          const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
            const aDate = new Date(a[0]).getTime();
            const bDate = new Date(b[0]).getTime();
            return aDate - bDate;
          });

          // Render each day
          for (const [day, dayItems] of sortedDays) {
            lines.push(`### ${day}`);
            lines.push('');

            let currentFile: string | null = null;
            let lastTime = '';
            let tableOpen = false;

            for (const item of dayItems) {
              const isAnchor = (item.type === 'observation' && item.data.id === topResult.id);

              if (item.type === 'session') {
                // Close any open table
                if (tableOpen) {
                  lines.push('');
                  tableOpen = false;
                  currentFile = null;
                  lastTime = '';
                }

                // Render session
                const sess = item.data;
                const title = sess.request || 'Session summary';
                const link = `claude-mem://session-summary/${sess.id}`;

                lines.push(`**🎯 #S${sess.id}** ${title} (${formatDateTime(item.epoch)}) [→](${link})`);
                lines.push('');
              } else if (item.type === 'prompt') {
                // Close any open table
                if (tableOpen) {
                  lines.push('');
                  tableOpen = false;
                  currentFile = null;
                  lastTime = '';
                }

                // Render prompt
                const prompt = item.data;
                const truncated = prompt.prompt.length > 100 ? prompt.prompt.substring(0, 100) + '...' : prompt.prompt;

                lines.push(`**💬 User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
                lines.push(`> ${truncated}`);
                lines.push('');
              } else if (item.type === 'observation') {
                // Render observation in table
                const obs = item.data;
                const file = 'General'; // Simplified for timeline view

                // Check if we need a new file section
                if (file !== currentFile) {
                  // Close previous table
                  if (tableOpen) {
                    lines.push('');
                  }

                  // File header
                  lines.push(`**${file}**`);
                  lines.push(`| ID | Time | T | Title | Tokens |`);
                  lines.push(`|----|------|---|-------|--------|`);

                  currentFile = file;
                  tableOpen = true;
                  lastTime = '';
                }

                // Map observation type to emoji
                let icon = '•';
                switch (obs.type) {
                  case 'bugfix': icon = '🔴'; break;
                  case 'feature': icon = '🟣'; break;
                  case 'refactor': icon = '🔄'; break;
                  case 'change': icon = '✅'; break;
                  case 'discovery': icon = '🔵'; break;
                  case 'decision': icon = '🧠'; break;
                }

                const time = formatTime(item.epoch);
                const title = obs.title || 'Untitled';
                const tokens = estimateTokens(obs.narrative);

                const showTime = time !== lastTime;
                const timeDisplay = showTime ? time : '″';
                lastTime = time;

                const anchorMarker = isAnchor ? ' ← **ANCHOR**' : '';
                lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
              }
            }

            // Close final table if open
            if (tableOpen) {
              lines.push('');
            }
          }

          return {
            content: [{
              type: 'text' as const,
              text: lines.join('\n')
            }]
          };
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Timeline query failed: ${error.message}`
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

// Cleanup function to properly terminate all child processes
async function cleanup() {
  console.error('[search-server] Shutting down...');
  
  // Close Chroma client (terminates uvx/python processes)
  if (chromaClient) {
    try {
      await chromaClient.close();
      console.error('[search-server] Chroma client closed');
    } catch (error: any) {
      console.error('[search-server] Error closing Chroma client:', error.message);
    }
  }
  
  // Close database connections
  if (search) {
    try {
      search.close();
      console.error('[search-server] SessionSearch closed');
    } catch (error: any) {
      console.error('[search-server] Error closing SessionSearch:', error.message);
    }
  }
  
  if (store) {
    try {
      store.close();
      console.error('[search-server] SessionStore closed');
    } catch (error: any) {
      console.error('[search-server] Error closing SessionStore:', error.message);
    }
  }
  
  console.error('[search-server] Shutdown complete');
  process.exit(0);
}

// Register cleanup handlers for graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

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
      // Use Python 3.13 by default to avoid onnxruntime compatibility issues with Python 3.14+
      const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || '3.13';
      const chromaTransport = new StdioClientTransport({
        command: 'uvx',
        args: ['--python', pythonVersion, 'chroma-mcp', '--client-type', 'persistent', '--data-dir', VECTOR_DB_DIR],
        stderr: 'ignore'
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
      console.error('[search-server] Vector search unavailable - text queries will return empty results (FTS5 fallback removed)');
      console.error('[search-server] Install UVX/Python to enable vector search: https://docs.astral.sh/uv/getting-started/installation/');
      chromaClient = null;
    }
  }, 0);
}

main().catch((error) => {
  console.error('[search-server] Fatal error:', error);
  process.exit(1);
});
