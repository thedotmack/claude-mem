
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getWorkerPort, workerHttpRequest, resolveWorkerScriptPath } from '../shared/worker-utils.js';
import { ensureWorkerStarted } from '../services/worker-spawner.js';
import { searchCodebase, formatSearchResults } from '../services/smart-file-read/search.js';
import { parseFile, formatFoldedView, unfoldSymbol, findProjectRoot } from '../services/smart-file-read/parser.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ServerClient,
  ServerClientError,
  isServerClientError,
  type ServerAddObservationRequest,
  type ServerContextObservationsRequest,
  type ServerRecordEventRequest,
  type ServerSearchObservationsRequest,
} from '../services/hooks/server-client.js';
import {
  selectRuntime,
  buildServerContext,
  type SelectedRuntime,
  type ServerRuntimeContext,
} from '../services/hooks/runtime-selector.js';
import { normalizePlatformSource } from '../shared/platform-source.js';

let mcpServerDirResolutionFailed = false;
const mcpServerDir = (() => {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    mcpServerDirResolutionFailed = true;
    return process.cwd();
  }
})();
// Prefer the canonical marketplace copy of the worker bundle (same
// marketplace-first candidates as the hook launcher) over this server's own
// directory: an MCP server still running out of a stale plugin cache dir
// would otherwise auto-spawn a stale worker. The own-dir resolution stays as
// the fallback for installs without a marketplace copy.
const WORKER_SCRIPT_PATH = resolveWorkerScriptPath() ?? resolve(mcpServerDir, 'worker-service.cjs');

function errorIfWorkerScriptMissing(): void {
  if (!mcpServerDirResolutionFailed) return;
  if (existsSync(WORKER_SCRIPT_PATH)) return;

  logger.error(
    'SYSTEM',
    'mcp-server: dirname resolution failed (both __dirname and import.meta.url are unavailable). Fell back to process.cwd() and the resolved WORKER_SCRIPT_PATH does not exist. This is the actual problem — the worker bundle is fine, but mcp-server cannot locate it. Worker auto-start will fail until the dirname-resolution path is fixed.',
    { workerScriptPath: WORKER_SCRIPT_PATH, mcpServerDir }
  );
}

const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};

async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  }

  const apiPath = `${endpoint}?${searchParams}`;

  try {
    const response = await workerHttpRequest(apiPath);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    return data;
  } catch (error: unknown) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function callWorkerAPIText(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API text', undefined, { endpoint, params });

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  }

  const apiPath = `${endpoint}?${searchParams}`;

  try {
    const response = await workerHttpRequest(apiPath);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const text = await response.text();

    logger.debug('SYSTEM', '← Worker API text success', undefined, { endpoint });

    return {
      content: [{
        type: 'text' as const,
        text,
      }],
    };
  } catch (error: unknown) {
    logger.error('SYSTEM', '← Worker API text error', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function executeWorkerPostRequest(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const response = await workerHttpRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  try {
    return await executeWorkerPostRequest(endpoint, body);
  } catch (error: unknown) {
    logger.error('HTTP', 'Worker API error (POST)', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await workerHttpRequest('/api/health');
    return response.ok;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check failed', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

// Phase 8 — runtime selection for MCP tools.
// In server mode, observation_* tools talk to the server `/v1`
// endpoints via the SAME ServerClient hooks use. This guarantees we
// share the REST core for writes and searches; we never duplicate the
// event-insert + outbox + enqueue logic on the MCP side.
//
// We deliberately resolve the runtime per-call (cheap; reads cached
// settings) so the user can flip CLAUDE_MEM_RUNTIME without restarting
// the MCP server.
type ServerToolContext = ServerRuntimeContext;

interface ServerUnavailable {
  // Phase 1a (cmem-sdk rename): canonical runtime literal is `'server'`.
  runtime: 'server';
  available: false;
  reason: string;
}

interface ServerAvailable extends ServerToolContext {
  available: true;
}

type ServerResolution = ServerAvailable | ServerUnavailable;

function resolveServerToolContext(): ServerResolution | null {
  const runtime: SelectedRuntime = selectRuntime();
  // Phase 1a (cmem-sdk rename): canonical runtime literal is `'server'`.
  // `selectRuntime()` accepts legacy `'server-beta'` settings and returns
  // `'server'` for either.
  if (runtime !== 'server') {
    return null;
  }
  const ctx = buildServerContext();
  if (!ctx) {
    return {
      runtime: 'server',
      available: false,
      reason: 'server runtime is selected but configuration is incomplete (missing url, api key, or project id)',
    };
  }
  return { ...ctx, available: true };
}

function formatToolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (isServerClientError(error)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Server error (${error.kind}${error.status ? ` ${error.status}` : ''}): ${error.message}`,
      }],
      isError: true as const,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
    }],
    isError: true as const,
  };
}

function formatJsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function requireServerForObservationTool(toolName: string): ServerAvailable {
  const resolution = resolveServerToolContext();
  if (!resolution) {
    throw new ServerClientError(
      'transport',
      `${toolName} requires CLAUDE_MEM_RUNTIME=server. Current runtime is "worker"; use the existing search/timeline/get_observations tools for worker-mode memory access.`,
    );
  }
  if (!resolution.available) {
    throw new ServerClientError('missing_api_key', `${toolName}: ${resolution.reason}`);
  }
  return resolution;
}

interface ObservationAddArgs {
  projectId?: string;
  serverSessionId?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

async function handleObservationAdd(
  args: ObservationAddArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ctx = requireServerForObservationTool('observation_add');
    if (typeof args?.content !== 'string' || args.content.trim().length === 0) {
      throw new Error('observation_add: "content" is required');
    }
    const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
    const request: ServerAddObservationRequest = {
      projectId,
      content: args.content,
      ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    };
    const response = await ctx.client.addObservation(request);
    return formatJsonResult(response);
  } catch (error) {
    return formatToolError(error);
  }
}

interface ObservationRecordEventArgs {
  projectId?: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  memorySessionId?: string | null;
  platformSource?: string | null;
  sourceType?: 'hook' | 'worker' | 'provider' | 'server' | 'api';
  eventType: string;
  payload?: unknown;
  occurredAtEpoch?: number;
  generate?: boolean;
}

function normalizeMcpPlatformSource(value: string | null): string | null {
  return typeof value === 'string' ? normalizePlatformSource(value) : null;
}

async function handleObservationRecordEvent(
  args: ObservationRecordEventArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ctx = requireServerForObservationTool('observation_record_event');
    if (typeof args?.eventType !== 'string' || args.eventType.trim().length === 0) {
      throw new Error('observation_record_event: "eventType" is required');
    }
    const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
    const request: ServerRecordEventRequest = {
      projectId,
      sourceType: args.sourceType ?? 'api',
      eventType: args.eventType,
      occurredAtEpoch: typeof args.occurredAtEpoch === 'number' ? args.occurredAtEpoch : Date.now(),
      ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
      ...(args.contentSessionId !== undefined ? { contentSessionId: args.contentSessionId } : {}),
      ...(args.memorySessionId !== undefined ? { memorySessionId: args.memorySessionId } : {}),
      ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
      ...(args.generate !== undefined ? { generate: args.generate } : {}),
    };
    const response = await ctx.client.recordEvent(request);
    return formatJsonResult(response);
  } catch (error) {
    return formatToolError(error);
  }
}

interface ObservationSearchArgs {
  projectId?: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

async function handleObservationSearch(
  args: ObservationSearchArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ctx = requireServerForObservationTool('observation_search');
    if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
      throw new Error('observation_search: "query" is required');
    }
    const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
    const request: ServerSearchObservationsRequest = {
      projectId,
      query: args.query,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
    };
    const response = await ctx.client.searchObservations(request);
    return formatJsonResult(response);
  } catch (error) {
    return formatToolError(error);
  }
}

interface ObservationContextArgs {
  projectId?: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

async function handleObservationContext(
  args: ObservationContextArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ctx = requireServerForObservationTool('observation_context');
    if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
      throw new Error('observation_context: "query" is required');
    }
    const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
    const request: ServerContextObservationsRequest = {
      projectId,
      query: args.query,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
    };
    const response = await ctx.client.contextObservations(request);
    return formatJsonResult(response);
  } catch (error) {
    return formatToolError(error);
  }
}

interface ObservationGenerationStatusArgs {
  jobId?: string;
  job_id?: string;
}

interface SessionStartContextArgs {
  project?: string;
  projects?: string[] | string;
  platformSource?: string | null;
  full?: boolean;
  colors?: boolean;
}

function normalizeProjectsArg(args: SessionStartContextArgs): string[] {
  if (Array.isArray(args.projects)) {
    return args.projects
      .map(project => typeof project === 'string' ? project.trim() : '')
      .filter(Boolean);
  }
  if (typeof args.projects === 'string') {
    return args.projects
      .split(',')
      .map(project => project.trim())
      .filter(Boolean);
  }
  if (typeof args.project === 'string' && args.project.trim().length > 0) {
    return [args.project.trim()];
  }
  return [];
}

async function handleSessionStartContext(
  args: SessionStartContextArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const projects = normalizeProjectsArg(args);
  if (projects.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'session_start_context: "project" or "projects" is required',
      }],
      isError: true,
    };
  }

  return callWorkerAPIText('/api/context/inject', {
    projects: projects.join(','),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
    ...(args.full !== undefined ? { full: args.full } : {}),
    ...(args.colors !== undefined ? { colors: args.colors } : {}),
  });
}

async function handleObservationGenerationStatus(
  args: ObservationGenerationStatusArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ctx = requireServerForObservationTool('observation_generation_status');
    const jobId = (args?.jobId ?? args?.job_id ?? '').trim();
    if (!jobId) {
      throw new Error('observation_generation_status: "jobId" is required');
    }
    const response = await ctx.client.getJobStatus(jobId);
    return formatJsonResult(response);
  } catch (error) {
    return formatToolError(error);
  }
}

async function ensureWorkerConnection(): Promise<boolean> {
  if (await verifyWorkerConnection()) {
    return true;
  }

  logger.warn('SYSTEM', 'Worker not available, attempting auto-start for MCP client');

  errorIfWorkerScriptMissing();

  try {
    const port = getWorkerPort();
    const result = await ensureWorkerStarted(port, WORKER_SCRIPT_PATH);
    if (result === 'dead') {
      logger.error(
        'SYSTEM',
        'Worker auto-start failed — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running. Check earlier log lines for the specific failure reason (Bun not found, missing worker bundle, port conflict, etc.).'
      );
    }
    return result !== 'dead';
  } catch (error: unknown) {
    logger.error(
      'SYSTEM',
      'Worker auto-start threw — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running.',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, platformSource, type, obs_type, dateStart, dateEnd, offset, orderBy',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Filter by project name' },
        platformSource: { type: 'string', description: "Filter by platform source (e.g. claude, codex, cursor) — restricts results to that agent's own memory" },
        type: { type: 'string', description: 'Filter by observation type' },
        obs_type: { type: 'string', description: 'Filter by obs_type field' },
        dateStart: { type: 'string', description: 'Start date filter (ISO)' },
        dateEnd: { type: 'string', description: 'End date filter (ISO)' },
        offset: { type: 'number', description: 'Pagination offset' },
        orderBy: { type: 'string', description: 'Sort order: date_desc or date_asc' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center the timeline around' },
        query: { type: 'string', description: 'Query to find anchor automatically' },
        depth_before: { type: 'number', description: 'Items before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Items after anchor (default 3)' },
        project: { type: 'string', description: 'Filter by project name' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required), orderBy, limit, project',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch (required)'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
  },
  {
    name: 'session_start_context',
    description: 'Render the exact worker-mode SessionStart context for a project. Calls /api/context/inject and returns the same text hooks inject at startup. Params: project OR projects, platformSource, full, colors.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, e.g. claude-mem/night-parsnip' },
        projects: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
          description: 'Project chain for context injection. Array or comma-separated string; last project is treated as primary.',
        },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        full: { type: 'boolean', description: 'When true, request full context instead of configured limits' },
        colors: { type: 'boolean', description: 'When true, request human terminal-color formatting' },
      },
      additionalProperties: false,
    },
    handler: async (args: any) => handleSessionStartContext(args ?? {}),
  },
  // Phase 8 — observation_* tools backed by server REST core.
  // These are the canonical names. memory_* tools below are kept as
  // compatibility aliases that delegate to these handlers, so existing
  // MCP clients keep working without rewrites. (Plan line 753.)
  {
    name: 'observation_add',
    description: 'Insert a manual observation directly into server storage. Calls /v1/memories — does NOT enqueue generation. Server runtime only. Params: content (required), projectId (optional, falls back to settings), serverSessionId, kind, metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (falls back to CLAUDE_MEM_SERVER_PROJECT_ID)' },
        serverSessionId: { type: 'string', description: 'Optional server_session_id to attach the observation to' },
        kind: { type: 'string', description: 'Observation kind (default: manual)' },
        content: { type: 'string', description: 'Observation content (required)' },
        metadata: { type: 'object', description: 'Free-form metadata object', additionalProperties: true },
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationAdd(args ?? {}),
  },
  {
    name: 'observation_record_event',
    description: 'Record an agent event into the server. Calls /v1/events — server inserts the event row, the outbox row, and enqueues a generation job atomically. Server runtime only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        eventType: { type: 'string', description: 'Event type (required), e.g. PostToolUse, UserPromptSubmit' },
        sourceType: { type: 'string', enum: ['hook', 'worker', 'provider', 'server', 'api'] },
        serverSessionId: { type: 'string' },
        contentSessionId: { type: 'string' },
        memorySessionId: { type: 'string' },
        platformSource: { type: 'string', description: 'Optional platform source for session linkage and event scoping' },
        payload: { description: 'Event payload (any JSON value)' },
        occurredAtEpoch: { type: 'number', description: 'Unix epoch millis (defaults to now)' },
        generate: { type: 'boolean', description: 'If false, skip generation job (default: true)' },
      },
      required: ['eventType'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationRecordEvent(args ?? {}),
  },
  {
    name: 'observation_search',
    description: 'Full-text search across generated observations using the server\'s GIN tsvector index (Phase 1). Calls /v1/search. Server runtime only. Params: query (required), projectId (optional), platformSource, limit (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationSearch(args ?? {}),
  },
  {
    name: 'observation_context',
    description: 'Get top-N relevant observations for context injection. Returns matched observations AND a pre-joined context string suitable for prompt injection. Calls /v1/context. Server runtime only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max observations (default 10, max 50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationContext(args ?? {}),
  },
  {
    name: 'observation_generation_status',
    description: 'Look up the status of an observation generation job by id. Calls /v1/jobs/:id. Server runtime only. Returns the same payload as REST.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Generation job id (required)' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationGenerationStatus(args ?? {}),
  },
  // Compatibility aliases — keep `memory_*` tool names that pre-existed in
  // src/server/mcp/tools.ts working for any client that bound to them.
  // These intentionally delegate to the same observation_* handlers so
  // there is one code path for MCP write/read against the server.
  {
    name: 'memory_add',
    description: 'Compatibility alias for observation_add. Same behavior; same schema modulo the legacy field names.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string' },
        content: { type: 'string' },
        narrative: { type: 'string', description: 'Legacy alias for content; mapped to content if content is missing' },
        title: { type: 'string', description: 'Legacy field; appended to metadata.title' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['projectId'],
      additionalProperties: true,
    },
    handler: async (args: any) => {
      // Map legacy fields onto observation_add. `narrative` was the v1
      // SQLite payload; it is normalized to `content` before forwarding.
      const merged: ObservationAddArgs = {
        projectId: args?.projectId,
        content: args?.content ?? args?.narrative ?? '',
        kind: args?.kind,
        metadata: {
          ...(args?.metadata ?? {}),
          ...(args?.title ? { title: args.title } : {}),
        },
      };
      return handleObservationAdd(merged);
    },
  },
  {
    name: 'memory_search',
    description: 'Compatibility alias for observation_search. Same FTS path; same /v1/search REST endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        platformSource: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['projectId', 'query'],
      additionalProperties: true,
    },
    handler: async (args: any) => handleObservationSearch(args ?? {}),
  },
  {
    name: 'memory_context',
    description: 'Compatibility alias for observation_context. Same /v1/context REST endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        platformSource: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['projectId', 'query'],
      additionalProperties: true,
    },
    handler: async (args: any) => handleObservationContext(args ?? {}),
  },
  {
    name: 'smart_search',
    description: 'Search codebase for symbols, functions, classes using tree-sitter AST parsing. Returns folded structural views with token counts. Use path parameter to scope the search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — matches against symbol names, file names, and file content'
        },
        path: {
          type: 'string',
          description: 'Root directory to search (default: current working directory)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 20)'
        },
        file_pattern: {
          type: 'string',
          description: 'Substring filter for file paths (e.g. ".ts", "src/services")'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      const rootDir = resolve(args.path || process.cwd());
      const result = await searchCodebase(rootDir, args.query, {
        maxResults: args.max_results || 20,
        filePattern: args.file_pattern
      });
      const formatted = formatSearchResults(result, args.query);
      return {
        content: [{ type: 'text' as const, text: formatted }]
      };
    }
  },
  {
    name: 'smart_unfold',
    description: 'Expand a specific symbol (function, class, method) from a file. Returns the full source code of just that symbol. Use after smart_search or smart_outline to read specific code.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to unfold (function, class, method, etc.)'
        }
      },
      required: ['file_path', 'symbol_name']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const projectRoot = findProjectRoot(filePath) ?? process.cwd();
      const unfolded = unfoldSymbol(content, filePath, args.symbol_name, projectRoot);
      if (unfolded) {
        return {
          content: [{ type: 'text' as const, text: unfolded }]
        };
      }
      const parsed = parseFile(content, filePath, projectRoot);
      if (parsed.symbols.length > 0) {
        const available = parsed.symbols.map(s => `  - ${s.name} (${s.kind})`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Symbol "${args.symbol_name}" not found in ${args.file_path}.\n\nAvailable symbols:\n${available}`
          }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may be unsupported or empty.`
        }]
      };
    }
  },
  {
    name: 'smart_outline',
    description: 'Get structural outline of a file — shows all symbols (functions, classes, methods, types) with signatures but bodies folded. Much cheaper than reading the full file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        }
      },
      required: ['file_path']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const parsed = parseFile(content, filePath, findProjectRoot(filePath) ?? process.cwd());
      if (parsed.symbols.length > 0) {
        return {
          content: [{ type: 'text' as const, text: formatFoldedView(parsed) }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may use an unsupported language or be empty.`
        }]
      };
    }
  },
  {
    name: 'build_corpus',
    description: 'Build a knowledge corpus from filtered observations. Creates a queryable knowledge agent. Params: name (required), description, project, types (comma-separated), concepts (comma-separated), files (comma-separated), query, dateStart, dateEnd, limit',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Corpus name (used as filename)' },
        description: { type: 'string', description: 'What this corpus is about' },
        project: { type: 'string', description: 'Filter by project' },
        types: { type: 'string', description: 'Comma-separated observation types: decision,bugfix,feature,refactor,discovery,change' },
        concepts: { type: 'string', description: 'Comma-separated concepts to filter by' },
        files: { type: 'string', description: 'Comma-separated file paths to filter by' },
        query: { type: 'string', description: 'Semantic search query' },
        dateStart: { type: 'string', description: 'Start date (ISO format)' },
        dateEnd: { type: 'string', description: 'End date (ISO format)' },
        limit: { type: 'number', description: 'Maximum observations (default 500)' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/corpus', args);
    }
  },
  {
    name: 'list_corpora',
    description: 'List all knowledge corpora with their stats and priming status',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPI('/api/corpus', args);
    }
  },
  {
    name: 'prime_corpus',
    description: 'Prime a knowledge corpus — creates an AI session loaded with the corpus knowledge. Must be called before query_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to prime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/prime`, rest);
    }
  },
  {
    name: 'query_corpus',
    description: 'Ask a question to a primed knowledge corpus. The corpus must be primed first with prime_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to query' },
        question: { type: 'string', description: 'The question to ask' }
      },
      required: ['name', 'question'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/query`, rest);
    }
  },
  {
    name: 'rebuild_corpus',
    description: 'Rebuild a knowledge corpus from its stored filter — re-runs the search to refresh with new observations. Does not re-prime the session.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to rebuild' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/rebuild`, rest);
    }
  },
  {
    name: 'reprime_corpus',
    description: 'Create a fresh knowledge agent session for a corpus, clearing prior Q&A context. Use when conversation has drifted or after rebuilding.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to reprime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/reprime`, rest);
    }
  }
];

const server = new Server(
  {
    name: 'claude-mem',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error: unknown) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isCleaningUp = false;

function handleStdioClosed() {
  cleanup('stdio-closed');
}

function handleStdioError(error: Error) {
  logger.warn('SYSTEM', 'MCP stdio stream errored, shutting down', {
    message: error.message
  });
  cleanup('stdio-error');
}

function attachStdioLifecycle() {
  process.stdin.on('end', handleStdioClosed);
  process.stdin.on('close', handleStdioClosed);
  process.stdin.on('error', handleStdioError);
}

function detachStdioLifecycle() {
  process.stdin.off('end', handleStdioClosed);
  process.stdin.off('close', handleStdioClosed);
  process.stdin.off('error', handleStdioError);
}

function startParentHeartbeat() {
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function checkMarketplaceMarker(): void {
  try {
    const home = homedir();
    const marketplaceCandidates = [
      resolve(home, '.claude', 'plugins', 'marketplaces', 'thedotmack'),
      resolve(home, '.config', 'claude', 'plugins', 'marketplaces', 'thedotmack'),
    ];
    const present = marketplaceCandidates.some(p => p && existsSync(p));
    const cacheCandidates = [
      resolve(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
      resolve(home, '.config', 'claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
    ];
    const cachePresent = cacheCandidates.some(p => p && existsSync(p));
    const cacheRoot = cacheCandidates[0];

    if (!present && cachePresent) {
      logger.error(
        'SYSTEM',
        'claude-mem MCP started but no marketplace directory was found at ~/.claude/plugins/marketplaces/thedotmack or the XDG equivalent. The IDE plugin loader needs that directory to fire claude-mem hooks (SessionStart, PostToolUse, Stop, etc.). Without it, MCP search will work but no new memories will be captured. To self-heal, run: node ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/smart-install.js (or reinstall the plugin from the marketplace).',
        { marketplaceCandidates, cacheRoot }
      );
    }
  } catch {
  }
}

async function main() {
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  setTimeout(async () => {
    // Phase 8 — when CLAUDE_MEM_RUNTIME=server (or legacy `server-beta`,
    // normalized to `'server'` by selectRuntime), MCP must NOT auto-start
    // the worker. observation_* tools talk to the server runtime directly;
    // the legacy worker-backed tools (search/timeline/get_observations)
    // will simply error with a helpful message until the user switches
    // runtime.
    if (selectRuntime() === 'server') {
      logger.info('SYSTEM', 'MCP runtime=server — skipping worker auto-start', undefined, {});
      return;
    }
    const workerAvailable = await ensureWorkerConnection();
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available', undefined, {});
      logger.error('SYSTEM', 'Tools will fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, {});
    }
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
