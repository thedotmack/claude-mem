// SPDX-License-Identifier: Apache-2.0

export interface ServerMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const serverMemoryTools: ServerMcpToolDefinition[] = [
  {
    name: 'memory_add',
    description: 'Add a team-scoped memory item to Claude-Mem Server.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string', enum: ['observation', 'summary', 'prompt', 'manual'] },
        type: { type: 'string' },
        title: { type: 'string' },
        narrative: { type: 'string' },
        facts: { type: 'array', items: { type: 'string' } },
      },
      required: ['projectId', 'kind', 'type'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search server memory items within the authorized project/team scope.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'memory_context',
    description: 'Build a compact context pack from matching server memories.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'memory_forget',
    description: 'Forget or tombstone a memory item in the authorized project/team scope.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        memoryId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['projectId', 'memoryId'],
    },
  },
  {
    name: 'memory_list_recent',
    description: 'List recent server memories for an authorized project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'memory_record_decision',
    description: 'Record an architectural or product decision as a server memory.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        decision: { type: 'string' },
        rationale: { type: 'string' },
        consequences: { type: 'array', items: { type: 'string' } },
      },
      required: ['projectId', 'title', 'decision'],
    },
  },
];
