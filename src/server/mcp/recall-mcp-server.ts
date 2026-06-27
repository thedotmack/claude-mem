// SPDX-License-Identifier: Apache-2.0
//
// Remote-recall MCP server factory.
//
// Builds a low-level MCP `Server` exposing the read tools (`search`, `context`,
// `recent`) over an injected `RecallBackend`. The backend is the only seam to
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

export interface RecallBackend {
  // Returns serialized observations (already shaped by serializeObservation),
  // scoped to the caller's team. Throws if `projectId` is outside the key's scope.
  // `search` and `context` query identically; they are separate methods so the
  // route can audit each tool under its own mode (search vs context).
  search(args: { projectId: string; query: string; limit: number }): Promise<unknown[]>;
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
      'Full-text search your claude-mem memory for a project. Returns matching observations (most relevant first).',
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
    name: 'context',
    description:
      'Like search, but also returns a concatenated context string ready to inject into a prompt.',
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
    description: 'List the most recent observations for a project (newest first).',
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
    throw new Error(`"${key}" is required`);
  }
  return value;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
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
      if (name === 'search') {
        const observations = await backend.search({
          projectId: requireString(args, 'projectId'),
          query: requireString(args, 'query'),
          limit: clampLimit(args.limit, SEARCH_LIMIT),
        });
        return jsonResult({ observations });
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
        return jsonResult({ observations, context });
      }
      if (name === 'recent') {
        const observations = await backend.recent({
          projectId: requireString(args, 'projectId'),
          limit: clampLimit(args.limit, RECENT_LIMIT),
        });
        return jsonResult({ observations });
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

export const RECALL_MCP_TOOLS = TOOLS;
