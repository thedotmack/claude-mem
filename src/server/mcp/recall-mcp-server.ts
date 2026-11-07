// SPDX-License-Identifier: Apache-2.0
//
// Remote-recall MCP server factory.
//
// Builds a low-level MCP `Server` exposing Smart's three read stages over an
// injected `RecallBackend`. The backend is the only seam to
// storage, so this factory is pure and unit-testable without Postgres — the
// route layer (ServerV1PostgresRoutes) supplies a backend already scoped to the
// authenticated API key's team (and honoring any project scope).
//
// This is the same recall surface the stdio MCP server exposes via
// ServerBetaClient (`/v1/search`, `/v1/context`), so a hosted MCP link and the
// local CLI read identical data. The mutating tools are intentionally absent:
// a pasted recall link is read-only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js';
import { formatMcpPayload } from '../../servers/mcp-text-format.js';

export interface RecallBackend {
  // Returns serialized observations (already shaped by serializeObservation),
  // scoped to the caller's team. Throws if `projectId` is outside the key's scope.
  // `search` and `context` query identically; they are separate methods so the
  // route can audit each tool under its own mode (search vs context).
  search(args: { projectId: string; query: string; limit: number }): Promise<unknown[]>;
  timeline(args: { projectId: string; anchorId: string; depthBefore: number; depthAfter: number }): Promise<unknown[]>;
  getObservations(args: { projectId: string; ids: string[] }): Promise<unknown[]>;
  context(args: { projectId: string; query: string; limit: number }): Promise<unknown[]>;
  recent(args: { projectId: string; limit: number }): Promise<unknown[]>;
}

const SEARCH_LIMIT = { default: 20, max: 100 };
const CONTEXT_LIMIT = { default: 10, max: 50 };
const RECENT_LIMIT = { default: 20, max: 100 };

const TOOLS: Tool[] = [
  {
    name: 'search',
    description:
      'Smart search (default), step 1: search a compact memory index. Reason about relevance, inspect timeline around selected IDs, then get_observations only for needed details.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT.max },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'timeline',
    description: 'Smart search step 2: inspect nearby memory context around a selected search ID in the same project, then choose relevant IDs for get_observations.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        anchorId: { type: 'string', description: 'Exact ID from the search index.' },
        depthBefore: { type: 'integer', minimum: 0, maximum: 20 },
        depthAfter: { type: 'integer', minimum: 0, maximum: 20 },
      },
      required: ['projectId', 'anchorId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_observations',
    description: 'Smart search step 3: read only selected observation IDs after inspecting the search index and timeline. Batch the IDs needed for the answer.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
      },
      required: ['projectId', 'ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'context',
    description:
      'Explicit context pack for integrations. For default Smart recall use search → timeline → selected get_observations.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: CONTEXT_LIMIT.max },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'recent',
    description: 'Explicit recent-memory view. For default Smart recall use search → timeline → selected get_observations.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to list.' },
        limit: { type: 'integer', minimum: 1, maximum: RECENT_LIMIT.max },
      },
      required: ['projectId'],
    },
  },
];

function clampLimit(raw: unknown, spec: { default: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default;
  return Math.min(Math.max(1, Math.trunc(raw)), spec.max);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RecallInputError(`"${key}" is required`);
  }
  if (value.length > (key === 'query' ? 4096 : 256)) throw new RecallInputError(`"${key}" is too long`);
  return value.trim();
}

class RecallInputError extends Error {}

function depth(args: Record<string, unknown>, key: string): number {
  const value = args[key] ?? 3;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 20) {
    throw new RecallInputError(`"${key}" must be an integer from 0 to 20`);
  }
  return value;
}

function smartStageResult(stage: 'server-search' | 'server-timeline', observations: unknown[]): CallToolResult {
  const result = formatMcpPayload(stage, { observations });
  const next = stage === 'server-search'
    ? 'Next: timeline({projectId, anchorId}) for context around a selected ID, then get_observations({projectId, ids}) for selected details.'
    : 'Next: get_observations({projectId, ids}) for only the relevant IDs you choose.';
  return { ...result, content: result.content.map(item => ({ ...item, text: item.text.replace(/\nNext:[^\n]*$/, '') + `\n${next}` })) };
}

// Dispatches a single tool call to the backend. Throws on unknown tools or
// invalid arguments; `createRecallMcpServer` converts those into MCP errors.
async function dispatchToolCall(
  backend: RecallBackend,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = TOOLS.find(tool => tool.name === name);
  if (!tool) throw new RecallInputError(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties ?? {}, key))) {
    throw new RecallInputError('Unsupported arguments. Smart search uses search → timeline → selected get_observations, without a mode parameter.');
  }
  if (name === 'search') {
    const observations = await backend.search({
      projectId: requireString(args, 'projectId'),
      query: requireString(args, 'query'),
      limit: clampLimit(args.limit, SEARCH_LIMIT),
    });
    return smartStageResult('server-search', observations);
  }
  if (name === 'timeline') {
    const observations = await backend.timeline({
      projectId: requireString(args, 'projectId'),
      anchorId: requireString(args, 'anchorId'),
      depthBefore: depth(args, 'depthBefore'),
      depthAfter: depth(args, 'depthAfter'),
    });
    return smartStageResult('server-timeline', observations);
  }
  if (name === 'get_observations') {
    if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > 100
      || args.ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) {
      throw new RecallInputError('"ids" must contain 1 to 100 selected observation IDs');
    }
    const observations = await backend.getObservations({
      projectId: requireString(args, 'projectId'), ids: [...new Set(args.ids.map(id => id.trim()))],
    });
    return formatMcpPayload('observations', { observations });
  }
  if (name === 'context') {
    const observations = await backend.context({
      projectId: requireString(args, 'projectId'),
      query: requireString(args, 'query'),
      limit: clampLimit(args.limit, CONTEXT_LIMIT),
    });
    const context = observations
      .map((o) => (o as { content?: unknown }).content)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .join('\n\n');
    return formatMcpPayload('context', { observations, context });
  }
  if (name === 'recent') {
    const observations = await backend.recent({
      projectId: requireString(args, 'projectId'),
      limit: clampLimit(args.limit, RECENT_LIMIT),
    });
    return smartStageResult('server-timeline', observations);
  }
  throw new RecallInputError(`Unknown tool: ${name}`);
}

/**
 * Build a read-only recall MCP server bound to `backend`. The caller owns the
 * transport (stdio in the CLI, streamable-HTTP in Server Beta).
 */
export function createRecallMcpServer(backend: RecallBackend, version: string): Server {
  const server = new Server(
    { name: 'claude-mem', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await dispatchToolCall(backend, name, args);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'recall MCP tool call failed', { tool: name }, err);
      const message = err instanceof RecallInputError || err.message === 'API key is scoped to a different project'
        ? err.message : 'Memory recall failed. Check the connection and project permissions, then retry Smart search.';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

export const RECALL_MCP_TOOLS = TOOLS;
